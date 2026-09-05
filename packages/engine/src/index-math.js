/**
 * Index level computation.
 *
 * The index is a divisor-based market-cap index: level = totalCap / divisor.
 * At inception the divisor is chosen so the level equals `baseLevel`. On every
 * later rebalance the divisor is re-solved so that changing the constituent set
 * does not, by itself, move the level — only price movement does. This is the
 * same continuity adjustment a traditional index uses.
 */
import { METHODOLOGY, VALUE_SCALE } from "./methodology.js";

/** Capitalization of a constituent set under a given price map. */
function totalCap(constituents, prices) {
  return constituents.reduce((sum, c) => {
    const quote = prices.get(c.symbol);
    if (!quote) throw new Error(`no reconciled price for ${c.symbol}`);
    return sum + quote.price * c.units;
  }, 0);
}

/**
 * Capitalization of a *previous* basket, tolerating constituents that can no
 * longer be priced.
 *
 * A departing constituent may be unpriceable in the same epoch it leaves — it
 * was delisted, or every venue dropped it. Continuity still needs the old
 * basket's value, so each constituent carries the price it was last valued at
 * and that is used as the fallback. This is what a real index does when a name
 * is removed: it is carried at its last known price, not dropped, since dropping
 * it would make the level jump by that name's entire weight.
 *
 * @returns {{cap: number, staleSymbols: string[]}}
 */
function previousCap(constituents, prices) {
  const staleSymbols = [];
  let cap = 0;
  for (const c of constituents) {
    const current = prices.get(c.symbol)?.price;
    if (Number.isFinite(current)) {
      cap += current * c.units;
      continue;
    }
    if (!Number.isFinite(c.lastPrice)) {
      throw new Error(
        `cannot value previous basket: ${c.symbol} has no current price and no recorded last price`,
      );
    }
    cap += c.lastPrice * c.units;
    staleSymbols.push(c.symbol);
  }
  return { cap, staleSymbols };
}

/** Inception divisor: pins the first level to `baseLevel`. */
export function inceptionDivisor(constituents, prices, methodology = METHODOLOGY) {
  return totalCap(constituents, prices) / methodology.baseLevel;
}

/**
 * Level of a previous basket at current prices, carrying unpriceable
 * constituents at their last recorded price.
 */
export function previousBasketLevel(constituents, prices, divisor) {
  if (!(divisor > 0)) throw new Error("divisor must be positive");
  const { cap, staleSymbols } = previousCap(constituents, prices);
  return { level: cap / divisor, staleSymbols };
}

/**
 * Divisor for a rebalance, chosen so the level is continuous across the
 * composition change. `previousLevel` is the level implied by the *old* basket
 * at current prices.
 */
export function rebalanceDivisor(newConstituents, prices, previousLevel) {
  if (!(previousLevel > 0)) throw new Error("previousLevel must be positive");
  return totalCap(newConstituents, prices) / previousLevel;
}

/** Index level as a float, given a basket and a divisor. */
export function level(constituents, prices, divisor) {
  if (!(divisor > 0)) throw new Error("divisor must be positive");
  return totalCap(constituents, prices) / divisor;
}

/**
 * Scale a float level to the i128 the contract stores (7dp).
 *
 * Rounds through a string rather than multiplying in float, so a level like
 * 1234.5678901 does not pick up binary-representation dust in the low digits.
 */
export function toScaledValue(levelFloat) {
  if (!Number.isFinite(levelFloat) || levelFloat <= 0) {
    throw new Error(`index level must be positive and finite, got ${levelFloat}`);
  }
  const [whole, frac = ""] = levelFloat.toFixed(Number(String(VALUE_SCALE).length - 1)).split(".");
  return BigInt(whole) * VALUE_SCALE + BigInt(frac.padEnd(String(VALUE_SCALE).length - 1, "0"));
}

/** Inverse of `toScaledValue`, for display. */
export function fromScaledValue(scaled) {
  const v = BigInt(scaled);
  const whole = v / VALUE_SCALE;
  const frac = (v % VALUE_SCALE).toString().padStart(String(VALUE_SCALE).length - 1, "0");
  return `${whole}.${frac}`;
}

/**
 * Units held per constituent for a target weight vector at current prices.
 * The basket is expressed in units so that between rebalances the weights
 * drift with price, as a real index does, instead of being re-pinned each read.
 *
 * Each entry records the price it was valued at. That is what lets a later epoch
 * value this basket even if a constituent becomes unpriceable — see
 * `previousBasketLevel`.
 */
export function unitsForWeights(weights, prices, notional) {
  return weights.map((w) => {
    const quote = prices.get(w.symbol);
    if (!quote) throw new Error(`no reconciled price for ${w.symbol}`);
    return {
      symbol: w.symbol,
      units: (notional * w.weight) / quote.price,
      lastPrice: quote.price,
    };
  });
}
