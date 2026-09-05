/**
 * Price reconciliation across independent sources.
 *
 * The point of multiple sources is that no single venue can move the index. A
 * quote is only usable when `minSources` venues agree within
 * `maxDeviationBps` of their median; outliers are dropped, and if too few
 * survive the asset is excluded from the epoch rather than priced badly.
 */
import { METHODOLOGY } from "./methodology.js";

/** A price is rejected for one of these reasons, recorded for the audit trail. */
export const RejectReason = {
  TOO_FEW_SOURCES: "too_few_sources",
  NO_CONSENSUS: "no_consensus",
};

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Reduce many quotes for one asset to a single consensus price.
 *
 * @param {Array<{source: string, price: number}>} quotes
 * @returns {{price: number, sources: string[], discarded: Array<{source: string, deviationBps: number}>}
 *   | {rejected: string, sources: string[]}}
 */
export function reconcile(quotes, methodology = METHODOLOGY) {
  const { minSources, maxDeviationBps } = methodology.pricing;
  const usable = quotes.filter((q) => Number.isFinite(q.price) && q.price > 0);

  if (usable.length < minSources) {
    return { rejected: RejectReason.TOO_FEW_SOURCES, sources: usable.map((q) => q.source) };
  }

  // Median first, then trim: the median is robust to the very outlier we are
  // trying to remove, whereas a mean would be dragged toward it.
  const ref = median(usable.map((q) => q.price).sort((a, b) => a - b));
  const discarded = [];
  const kept = [];
  for (const q of usable) {
    const deviationBps = Math.abs((q.price - ref) / ref) * 10_000;
    if (deviationBps > maxDeviationBps) discarded.push({ source: q.source, deviationBps });
    else kept.push(q);
  }

  if (kept.length < minSources) {
    return { rejected: RejectReason.NO_CONSENSUS, sources: usable.map((q) => q.source) };
  }

  return {
    price: median(kept.map((q) => q.price).sort((a, b) => a - b)),
    sources: kept.map((q) => q.source),
    discarded,
  };
}

/**
 * Reconcile a whole universe.
 *
 * @param {Map<string, Array<{source: string, price: number}>>} quotesBySymbol
 * @returns {{prices: Map<string, {price: number, sources: string[]}>, rejected: Array}}
 */
export function reconcileAll(quotesBySymbol, methodology = METHODOLOGY) {
  const prices = new Map();
  const rejected = [];
  for (const [symbol, quotes] of quotesBySymbol) {
    const result = reconcile(quotes, methodology);
    if (result.rejected) rejected.push({ symbol, ...result });
    else prices.set(symbol, result);
  }
  return { prices, rejected };
}
