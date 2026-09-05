/**
 * Constituent classification — what is not an index name.
 *
 * The methodology excludes stablecoins, wrapped assets, and staking derivatives.
 * All three would otherwise corrupt the index in the same way: they duplicate or
 * peg to exposure that is already represented, so including them double-counts.
 * WBTC alongside BTC is the same bet twice; stETH alongside ETH likewise.
 *
 * There is no free, reliable tag API for this. CoinPaprika's `/coins/{id}` tags
 * are inconsistent — stETH is tagged "Liquid Staking Token" but WBTC and USDT
 * carry no tags at all — and it costs one request per asset. So classification
 * uses two complementary signals instead:
 *
 *   1. Realized volatility, for stablecoins. Verified 2026-08-31: every known
 *      stablecoin moved ≤0.10% over both 24h and 7d, while the least volatile
 *      non-stable moved 0.79%. The gap is peg-agnostic, which is the point — it
 *      correctly catches yield-bearing stables trading at 1.25 (sUSDe) or 1.11
 *      (sUSDS) that a "price near $1" test would miss.
 *
 *      Two short windows are not enough on their own. That 0.79% margin was one
 *      day's reading, and on 2026-09-05 ETH came in under 0.5% on both windows
 *      and was classified as a stablecoin — a top-20 crypto index with no ETH.
 *      A 30-day window vetoes that: the same day, stables sat at 0.1% while ETH
 *      had moved 28.5%.
 *
 *   2. Naming patterns, for wrapped and staked derivatives. These track their
 *      underlying's volatility exactly, so signal 1 cannot see them. Patterns are
 *      structural (`w`/`st`/`cb` prefixes, "wrapped"/"staked" in the name) rather
 *      than a fixed denylist, so new derivatives are caught without a code change.
 *
 * Both signals are heuristics and both are reported in the audit record with the
 * reason, so a wrong call is visible rather than silent.
 */

/** Max |% change| over 24h and 7d for an asset to count as a stablecoin. */
export const STABLE_MAX_CHANGE_PCT = 0.5;

/**
 * Max |% change| over 30d before the stablecoin verdict is vetoed.
 *
 * See methodology.js for the measurements. Short windows cannot distinguish a
 * peg from a quiet week; a month can.
 */
export const STABLE_MAX_CHANGE_30D_PCT = 2.0;

/**
 * Name fragments that mark a derivative. Matched against the asset's full name,
 * which is more reliable than the ticker — "Wrapped Bitcoin" is unambiguous
 * where "WBTC" is only suggestive.
 */
const DERIVATIVE_NAME_PATTERNS = [
  /\bwrapped\b/i,
  /\bstaked\b/i,
  /\bliquid staking\b/i,
  /\brestaked\b/i,
  /\bbridged\b/i,
  /\bpeg(ged)?\b/i,
  /\bsynthetic\b/i,
  /\btokenized\b/i,
];

/**
 * Tickers that are derivatives but whose names do not say so. Kept deliberately
 * short — every entry here is a maintenance burden and a thing that will go stale.
 */
const DERIVATIVE_SYMBOLS = new Set([
  "WETH", "WBTC", "CBBTC", "STETH", "WSTETH", "WEETH", "RETH", "CBETH",
  "JITOSOL", "MSOL", "BSOL", "SUSDE", "SUSDS", "STSOL",
]);

/**
 * Commodity-backed tokens. Excluded because the index measures the crypto
 * market; a gold token is gold exposure wearing a token.
 */
const COMMODITY_SYMBOLS = new Set(["PAXG", "XAUT", "KAU", "TGOLD"]);

export const ExclusionReason = {
  STABLECOIN: "stablecoin",
  DERIVATIVE: "derivative",
  COMMODITY: "commodity",
  UNKNOWN_VOLATILITY: "unknown_volatility",
};

/**
 * Is this asset price-stable enough to be a stablecoin?
 *
 * Both short windows must be quiet, and the 30-day window must not contradict
 * them. Requiring both 24h and 7d was already necessary — a single quiet 24h
 * window is common for any large asset on a flat day — but it was not sufficient:
 * a genuinely flat week reads identically to a peg. The 30d veto is what separates
 * them, because an asset that is flat for a week has almost always moved over a
 * month, while a peg has not moved over either.
 *
 * `change30dPct` is only populated by providers that report it, so a null leaves
 * the old two-window verdict standing rather than admitting an unclassifiable
 * asset. That fallback applies to the tail of the universe, where the cost of a
 * wrong call is one slot; the names that would actually be missed are all covered.
 */
export function looksLikeStablecoin(
  asset,
  maxChangePct = STABLE_MAX_CHANGE_PCT,
  maxChange30dPct = STABLE_MAX_CHANGE_30D_PCT,
) {
  const { change24hPct, change7dPct, change30dPct } = asset;
  if (change24hPct === null || change7dPct === null) return false;
  if (Math.abs(change24hPct) > maxChangePct || Math.abs(change7dPct) > maxChangePct) return false;
  if (change30dPct !== null && change30dPct !== undefined && Math.abs(change30dPct) > maxChange30dPct) {
    return false;
  }
  return true;
}

export function looksLikeDerivative(asset) {
  if (DERIVATIVE_SYMBOLS.has(asset.symbol)) return true;
  return DERIVATIVE_NAME_PATTERNS.some((pattern) => pattern.test(asset.name ?? ""));
}

/**
 * Classify one asset. Returns null when it is a legitimate index candidate,
 * otherwise the reason it is not.
 */
export function classifyExclusion(
  asset,
  { maxChangePct = STABLE_MAX_CHANGE_PCT, maxChange30dPct = STABLE_MAX_CHANGE_30D_PCT } = {},
) {
  if (COMMODITY_SYMBOLS.has(asset.symbol)) return ExclusionReason.COMMODITY;
  if (looksLikeDerivative(asset)) return ExclusionReason.DERIVATIVE;
  if (looksLikeStablecoin(asset, maxChangePct, maxChange30dPct)) return ExclusionReason.STABLECOIN;

  // Without change data the stablecoin test cannot run. Excluding is the safe
  // direction: admitting a stablecoin corrupts the index, while excluding one
  // real asset costs a slot in a 20-name index.
  if (asset.change24hPct === null || asset.change7dPct === null) {
    return ExclusionReason.UNKNOWN_VOLATILITY;
  }
  return null;
}
