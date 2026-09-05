/**
 * Resident market-data cache.
 *
 * Every paid route reads from this snapshot rather than calling a provider, which
 * decouples request rate from upstream rate. That separation is the whole point:
 * `/v1/index/tick` is priced to be polled continuously, and the four free price
 * APIs behind it would rate-limit long before the process broke a sweat. What
 * bounds upstream load is the refresh interval, not the number of paying callers.
 *
 * Two clocks, because the inputs move at different speeds and cost different
 * amounts to fetch:
 *
 *   prices       — 4 sources, reconciled by median. Cheap, refreshed every
 *                  `priceTtlSeconds`. This is what the index level marks against.
 *   fundamentals — market cap, volume, listing age, 24h/7d change for the whole
 *                  screening universe. ~150 assets across two providers, so it is
 *                  refreshed on a much slower clock.
 *
 * Failures never propagate. A refresh that throws leaves the previous snapshot in
 * place and records the error; routes then decide whether the snapshot is still
 * fresh enough to sell, using `priceMaxStaleSeconds`. Serving a silently stale
 * price is worse than returning 503, because the caller cannot tell the
 * difference — so staleness is enforced at read time, not hoped for at write time.
 */
import { collectFundamentals, collectQuotes, createSymbolResolver, reconcileAll } from "@indexfeed-algorand/engine";

/** How many names beyond the basket to keep priced, for the per-asset routes. */
const DEFAULT_QUOTE_UNIVERSE = 30;

export function createMarketData({
  sources,
  fundamentalsProviders,
  priceTtlSeconds = 20,
  fundamentalsTtlSeconds = 300,
  quoteUniverseSize = DEFAULT_QUOTE_UNIVERSE,
  extraSymbols = () => [],
  now = () => Date.now(),
}) {
  let universe = [];
  let universeAt = null;
  let resolver = null;

  let prices = new Map();
  let pricesAt = null;
  let priceMeta = { rejected: [], sourceErrors: [] };

  let lastError = null;
  let timers = [];
  /** In-flight refresh, so concurrent callers share one upstream fetch. */
  let priceRefresh = null;
  let fundamentalsRefresh = null;

  /** Symbols worth pricing: the basket first, then the largest names. */
  function pricedSymbols() {
    const top = universe.slice(0, quoteUniverseSize).map((a) => a.symbol);
    return [...new Set([...extraSymbols(), ...top])];
  }

  async function refreshFundamentals() {
    const { universe: fetched, providerErrors } = await collectFundamentals(fundamentalsProviders);
    if (fetched.length === 0) throw new Error("no fundamentals available from any provider");
    // Sorted by market cap so `quoteUniverseSize` means "the largest N" rather
    // than "whichever N the provider happened to return first".
    universe = [...fetched].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
    resolver = createSymbolResolver(universe);
    universeAt = now();
    return { universeSize: universe.length, providerErrors };
  }

  async function refreshPrices() {
    // Aggregator adapters need the resolver, which only exists once fundamentals
    // have been fetched, so the first price refresh depends on the first
    // fundamentals refresh rather than racing it.
    if (!resolver) await refreshFundamentals();
    const symbols = pricedSymbols();
    if (symbols.length === 0) throw new Error("no symbols to price");

    const priceSources = typeof sources === "function" ? sources(resolver) : sources;
    const { quotesBySymbol, sourceErrors } = await collectQuotes(priceSources, symbols);
    const { prices: reconciled, rejected } = reconcileAll(quotesBySymbol);
    if (reconciled.size === 0) throw new Error("no symbol reached price consensus");

    prices = reconciled;
    pricesAt = now();
    priceMeta = { rejected, sourceErrors };
    return { priced: prices.size, rejected: rejected.length };
  }

  /** Wrap a refresh so it is single-flight and never throws at the caller. */
  function guarded(run, slot) {
    const inflight = slot === "prices" ? priceRefresh : fundamentalsRefresh;
    if (inflight) return inflight;
    const promise = run()
      .then((result) => {
        lastError = null;
        return result;
      })
      .catch((err) => {
        lastError = { at: new Date(now()).toISOString(), slot, message: String(err?.message ?? err) };
        return null;
      })
      .finally(() => {
        if (slot === "prices") priceRefresh = null;
        else fundamentalsRefresh = null;
      });
    if (slot === "prices") priceRefresh = promise;
    else fundamentalsRefresh = promise;
    return promise;
  }

  return {
    /** Fetch both inputs once. Awaited at startup so the API boots warm. */
    async warm() {
      await guarded(refreshFundamentals, "fundamentals");
      await guarded(refreshPrices, "prices");
      return this.status();
    },

    /** Background refresh on the two clocks. Timers are unref'd so tests exit. */
    start() {
      if (timers.length) return;
      const price = setInterval(() => guarded(refreshPrices, "prices"), priceTtlSeconds * 1000);
      const fundamentals = setInterval(
        () => guarded(refreshFundamentals, "fundamentals"),
        fundamentalsTtlSeconds * 1000,
      );
      timers = [price, fundamentals];
      for (const t of timers) t.unref?.();
    },

    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },

    /** Age of the price snapshot in seconds, or null if never fetched. */
    priceAgeSeconds() {
      return pricesAt === null ? null : (now() - pricesAt) / 1000;
    },

    /** Consensus price for one symbol, or null. */
    priceFor(symbol) {
      return prices.get(symbol.toUpperCase()) ?? null;
    },

    /** Full price map. Callers must not mutate it. */
    allPrices() {
      return prices;
    },

    /** Fundamentals row for one symbol, or null. */
    assetFor(symbol) {
      const wanted = symbol.toUpperCase();
      return universe.find((a) => a.symbol === wanted) ?? null;
    },

    /** The screening universe, largest first. */
    allAssets() {
      return universe;
    },

    status() {
      return {
        priceAgeSeconds: this.priceAgeSeconds(),
        pricedSymbols: prices.size,
        universeSize: universe.length,
        universeAgeSeconds: universeAt === null ? null : (now() - universeAt) / 1000,
        priceRejections: priceMeta.rejected.length,
        sourceErrors: priceMeta.sourceErrors,
        lastError,
      };
    },
  };
}
