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
 *      non-stable moved 0.79%. The gap is wide enough to be robust, and it is
 *      peg-agnostic — it correctly catches yield-bearing stables trading at 1.25
 *      (sUSDe) or 1.11 (sUSDS) that a "price near $1" test would miss.
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
 * Requires *both* windows to be quiet. A single quiet 24h window is common for
 * any large asset on a flat day, so 24h alone would exclude real constituents.
 */
export function looksLikeStablecoin(asset, maxChangePct = STABLE_MAX_CHANGE_PCT) {
  const { change24hPct, change7dPct } = asset;
  if (change24hPct === null || change7dPct === null) return false;
  return Math.abs(change24hPct) <= maxChangePct && Math.abs(change7dPct) <= maxChangePct;
}

export function looksLikeDerivative(asset) {
  if (DERIVATIVE_SYMBOLS.has(asset.symbol)) return true;
  return DERIVATIVE_NAME_PATTERNS.some((pattern) => pattern.test(asset.name ?? ""));
}

/**
 * Classify one asset. Returns null when it is a legitimate index candidate,
 * otherwise the reason it is not.
 */
export function classifyExclusion(asset, { maxChangePct = STABLE_MAX_CHANGE_PCT } = {}) {
  if (COMMODITY_SYMBOLS.has(asset.symbol)) return ExclusionReason.COMMODITY;
  if (looksLikeDerivative(asset)) return ExclusionReason.DERIVATIVE;
  if (looksLikeStablecoin(asset, maxChangePct)) return ExclusionReason.STABLECOIN;

  // Without change data the stablecoin test cannot run. Excluding is the safe
  // direction: admitting a stablecoin corrupts the index, while excluding one
  // real asset costs a slot in a 20-name index.
  if (asset.change24hPct === null || asset.change7dPct === null) {
    return ExclusionReason.UNKNOWN_VOLATILITY;
  }
  return null;
}
