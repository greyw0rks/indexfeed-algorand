/**
 * Eligibility screening and market-cap weighting with a concentration cap.
 */
import { METHODOLOGY, TOTAL_WEIGHT_BPS } from "./methodology.js";
import { classifyExclusion } from "./classify.js";

/**
 * Apply the eligibility rules to a candidate universe.
 *
 * Order matters: classification runs first, so a stablecoin is reported as a
 * stablecoin rather than as whichever numeric rule it happens to also fail.
 * Exclusion reasons are the audit trail for why a name is absent, so they need
 * to name the real cause.
 *
 * @param {Array<{symbol: string, name?: string, marketCapUsd: number,
 *   volume24hUsd: number, listingAgeDays: number|null,
 *   change24hPct?: number|null, change7dPct?: number|null, sources?: string[]}>} universe
 * @returns {{eligible: Array, excluded: Array<{symbol: string, reason: string, detail?: string}>}}
 */
export function screen(universe, methodology = METHODOLOGY) {
  const rules = methodology.eligibility;
  const minProviders = methodology.fundamentals?.minProviders ?? 1;
  const eligible = [];
  const excluded = [];

  for (const asset of universe) {
    let reason = null;
    let detail;

    if (rules.excludeNonConstituents) {
      reason = classifyExclusion(asset, { maxChangePct: rules.stableMaxChangePct });
    }

    if (!reason && (asset.sources?.length ?? 1) < minProviders) {
      reason = "too_few_providers";
      detail = `${asset.sources?.length ?? 0} of ${minProviders}`;
    }
    if (!reason && asset.marketCapUsd < rules.minMarketCapUsd) {
      reason = "market_cap";
      detail = `$${(asset.marketCapUsd / 1e6).toFixed(1)}M`;
    }
    if (!reason && asset.volume24hUsd < rules.minVolume24hUsd) {
      reason = "volume";
      detail = `$${(asset.volume24hUsd / 1e6).toFixed(2)}M`;
    }
    if (!reason && rules.minTurnoverBps) {
      const turnoverBps = (asset.volume24hUsd / asset.marketCapUsd) * TOTAL_WEIGHT_BPS;
      if (turnoverBps < rules.minTurnoverBps) {
        reason = "turnover";
        detail = `${turnoverBps.toFixed(1)}bps of ${rules.minTurnoverBps}`;
      }
    }
    if (!reason) {
      // A null age means no provider reported a listing date. Treated as
      // failing the rule: an unknown-age asset could be days old, and admitting
      // one on launch-price noise is worse than omitting it.
      if (asset.listingAgeDays === null) {
        reason = "unknown_listing_age";
      } else if (asset.listingAgeDays < rules.minListingAgeDays) {
        reason = "listing_age";
        detail = `${asset.listingAgeDays}d`;
      }
    }

    if (reason) excluded.push({ symbol: asset.symbol, reason, ...(detail ? { detail } : {}) });
    else eligible.push(asset);
  }

  // Largest market cap first, then take the top N.
  eligible.sort((a, b) => b.marketCapUsd - a.marketCapUsd);
  const selected = eligible.slice(0, methodology.targetSize);
  for (const asset of eligible.slice(methodology.targetSize)) {
    excluded.push({ symbol: asset.symbol, reason: "below_target_size" });
  }

  return { eligible: selected, excluded };
}

/**
 * Market-cap weights with an iterative concentration cap.
 *
 * Capping one name pushes its excess onto the others, which can lift a second
 * name over the cap — so this repeats until no name breaches it. Uncapped names
 * absorb the excess in proportion to their own weight.
 *
 * @returns {Array<{symbol: string, weight: number}>} weights as fractions summing to 1
 */
export function weight(assets, methodology = METHODOLOGY) {
  const cap = methodology.concentrationCapBps / TOTAL_WEIGHT_BPS;
  if (assets.length === 0) return [];

  // A cap below an equal split is unsatisfiable — every name would breach it.
  if (cap * assets.length < 1) {
    throw new Error(
      `concentrationCapBps ${methodology.concentrationCapBps} cannot be met with ` +
        `${assets.length} constituents (needs >= ${Math.ceil(TOTAL_WEIGHT_BPS / assets.length)})`,
    );
  }

  const total = assets.reduce((s, a) => s + a.marketCapUsd, 0);
  const weights = new Map(assets.map((a) => [a.symbol, a.marketCapUsd / total]));
  const capped = new Set();

  // Bounded by the number of names: each pass caps at least one more, or stops.
  for (let pass = 0; pass < assets.length; pass += 1) {
    const breaching = [...weights].filter(([s, w]) => !capped.has(s) && w > cap + 1e-12);
    if (breaching.length === 0) break;

    for (const [symbol] of breaching) {
      weights.set(symbol, cap);
      capped.add(symbol);
    }

    const cappedWeight = capped.size * cap;
    const freeSymbols = assets.map((a) => a.symbol).filter((s) => !capped.has(s));
    const freeWeight = freeSymbols.reduce((s, sym) => s + weights.get(sym), 0);
    const remaining = 1 - cappedWeight;
    for (const sym of freeSymbols) {
      weights.set(sym, freeWeight === 0 ? remaining / freeSymbols.length : (weights.get(sym) / freeWeight) * remaining);
    }
  }

  return assets.map((a) => ({ symbol: a.symbol, weight: weights.get(a.symbol) }));
}

/**
 * Convert fractional weights to basis points that sum to exactly 10_000.
 *
 * The contract rejects any update whose weights do not sum to 10_000, so the
 * rounding residual is assigned to the largest name — the one where a 1bp
 * adjustment is least material.
 */
export function toBasisPoints(weights) {
  if (weights.length === 0) return [];
  const bps = weights.map((w) => ({ symbol: w.symbol, weight_bps: Math.round(w.weight * TOTAL_WEIGHT_BPS) }));
  const residual = TOTAL_WEIGHT_BPS - bps.reduce((s, b) => s + b.weight_bps, 0);
  if (residual !== 0) {
    const largest = bps.reduce((a, b) => (b.weight_bps > a.weight_bps ? b : a));
    largest.weight_bps += residual;
  }
  return bps;
}
