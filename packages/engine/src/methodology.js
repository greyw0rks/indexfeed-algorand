/**
 * Methodology constants and the versioning hash.
 *
 * Everything the index's composition depends on lives here. The hash of this
 * object is published on-chain with every update, so a reader can tell whether
 * two epochs were computed under the same rules.
 */
import { createHash } from "node:crypto";

/** Weights on-chain are basis points summing to 10_000. */
export const TOTAL_WEIGHT_BPS = 10_000;

/** Index level is stored at 7dp. Comments do not enter the hash, so this
 * wording can change without moving the methodology hash. */
export const VALUE_DECIMALS = 7;
export const VALUE_SCALE = 10n ** BigInt(VALUE_DECIMALS);

/**
 * Bump `version` on any change to these rules. Because the hash covers the
 * whole object, forgetting to bump is still detectable — the hash moves anyway.
 */
export const METHODOLOGY = {
  version: "1.2.0",
  /** Target constituent count for the flagship index. */
  targetSize: 20,
  /** No single name may exceed this share, applied iteratively. */
  concentrationCapBps: 2_500,
  eligibility: {
    /**
     * Minimum market cap in USD, on circulating supply. Circulating supply is
     * the closest free-data proxy for free float — it excludes unissued supply
     * but not locked, treasury, or team holdings, so it overstates float for
     * assets with large vesting schedules.
     */
    minMarketCapUsd: 50_000_000,
    /** Minimum 24h volume in USD. An absolute floor on tradeability. */
    minVolume24hUsd: 1_000_000,
    /**
     * Minimum 24h volume as a fraction of market cap, in basis points.
     *
     * This is the load-bearing liquidity rule and the absolute floor above is
     * only a backstop. Weights are market-cap proportional, so an illiquid
     * mega-cap receives a large weight its order book cannot support — the
     * index would claim exposure that could not actually be traded. Turnover is
     * scale-invariant and catches exactly that: on 2026-08-31 LEO showed a $8.9B
     * cap against $0.2M of daily volume (0.002%), while AAVE at $1.9B traded
     * $231M (12%). The absolute floor alone would rank LEO 4th by weight.
     */
    minTurnoverBps: 50,
    /** Minimum days since first price data, to exclude launch-price noise. */
    minListingAgeDays: 90,
    /**
     * Stablecoins track the dollar, wrapped and staked assets duplicate exposure
     * already in the index, and commodity tokens are not crypto exposure. All
     * three are excluded by classification rather than by denylist — see
     * `classify.js` for how each is detected and why.
     */
    excludeNonConstituents: true,
    /** Max |% change| over both 24h and 7d for an asset to count as stable. */
    stableMaxChangePct: 0.5,
    /**
     * Max |% change| over 30d for an asset to still count as stable.
     *
     * A veto, not a third AND-condition: exceed this and the asset is *not* a
     * stablecoin however quiet its 24h and 7d windows were. Two short windows
     * cannot tell a peg from a flat week, and on 2026-09-05 they did not — ETH
     * printed +0.42% over 24h and +0.40% over 7d and was classified as a
     * stablecoin, which would have shipped a top-20 crypto index with no ETH in
     * it. Over 30d the same day separates cleanly: USDT and USDC at 0.1%, ETH at
     * 28.5%, BTC at 23.3%, and the quietest real asset in the universe (TRX) at
     * 2.1%.
     *
     * Set at 2.0 rather than tighter so that yield-bearing stables, which drift
     * upward by design, stay caught: 2%/30d is roughly 26%/yr of accrual.
     */
    stableMaxChange30dPct: 2.0,
  },
  /** Rebalance cadence in days. Epoch N is published every `cadenceDays`. */
  cadenceDays: 7,
  pricing: {
    /** Minimum independent sources required before a price is usable. */
    minSources: 2,
    /**
     * A source is discarded when it deviates from the median by more than this.
     * Guards against a single venue printing a bad tick or being manipulated.
     */
    maxDeviationBps: 500,
  },
  fundamentals: {
    /**
     * Minimum providers that must report an asset for its fundamentals to be
     * trusted. Set to 1 because the two free providers disagree on 24h volume by
     * 8–25% for the same asset on the same day (measured 2026-08-31), so
     * requiring corroboration would not make volume more accurate — it would
     * only shrink the universe. Market caps agree within 0.2%, which is why
     * ranking is done on market cap and volume is only ever a threshold test.
     */
    minProviders: 1,
    /** How many assets to pull from each provider before screening. */
    universeSize: 150,
  },
  /** Divisor anchoring the index to its base level of 1000 at inception. */
  baseLevel: 1_000,
};

/**
 * Stable stringify — key order must not affect the hash, or an innocuous
 * refactor of this file would look like a methodology change on-chain.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 32-byte methodology hash, hex encoded, as published on-chain. */
export function methodologyHash(methodology = METHODOLOGY) {
  return createHash("sha256").update(canonicalize(methodology)).digest("hex");
}

/**
 * Fraction of the cadence that must elapse before the next epoch is due.
 *
 * Not 1.0, because a scheduled publisher drifts: GitHub's cron fires late under
 * load, so a run following a delayed one is slightly under a full cadence and
 * must not be treated as off-cadence. 0.9 of seven days leaves about 17 hours of
 * slack — enough to absorb drift, tight enough to still block a second publish
 * in the same day.
 */
export const CADENCE_TOLERANCE = 0.9;

/**
 * Whether the next epoch is due, given when the head epoch was published.
 *
 * The contract enforces epoch *succession* but never looks at the clock, so the
 * cadence is a methodology commitment that has to be checked off-chain. Without
 * it a manual trigger can stack an epoch minutes after a scheduled one, and the
 * published interval stops matching the documented one.
 */
export function cadenceGate({
  publishedAtSeconds,
  now = Date.now(),
  methodology = METHODOLOGY,
  tolerance = CADENCE_TOLERANCE,
}) {
  const elapsedMs = now - publishedAtSeconds * 1000;
  const dueAfterMs = methodology.cadenceDays * 86_400_000 * tolerance;
  return {
    isDue: elapsedMs >= dueAfterMs,
    elapsedMs,
    remainingMs: Math.max(0, dueAfterMs - elapsedMs),
  };
}
