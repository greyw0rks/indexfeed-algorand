/**
 * Price source adapters.
 *
 * Each source is an independent feed returning `{symbol, price}` quotes. They
 * are deliberately thin and failure-tolerant: a source that errors or times out
 * yields no quotes rather than failing the rebalance, and reconciliation then
 * decides whether enough sources survived.
 *
 * Two kinds of source are mixed on purpose. Exchanges (Bitstamp, Bitfinex) are
 * independent venues — a manipulated print on one does not appear on the other.
 * Aggregators (CoinGecko, CoinPaprika) are volume-weighted composites across
 * many venues, which makes them robust individually but *not* independent of
 * each other. Reconciliation needs at least one exchange plus one aggregator to
 * be meaningful; three aggregators would agree with each other while all being
 * wrong in the same direction.
 *
 * Reachability is not uniform: Binance, Kraken, Coinbase, and OKX are
 * geo-restricted or blocked from some hosts, which is precisely why the
 * pipeline treats a dead source as normal rather than fatal.
 *
 * Exchange adapters derive their pair names from the ticker; aggregator adapters
 * take a resolver built from the fundamentals fetch, since their ids are opaque
 * slugs that cannot be derived. See `symbols.js`.
 */
import { bitfinexPair, bitstampPair } from "./symbols.js";

/** Per-source timeout. A slow venue must not stall the rebalance. */
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchJson(url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

/** CoinGecko simple-price. Aggregator, free tier, no key. */
export function coingeckoSource(resolver) {
  return {
    name: "coingecko",
    kind: "aggregator",
    async quotes(symbols) {
      const wanted = symbols.filter((s) => resolver.idFor("coingecko", s));
      if (wanted.length === 0) return [];
      const ids = wanted.map((s) => resolver.idFor("coingecko", s)).join(",");
      const data = await fetchJson(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      );
      return wanted
        .map((symbol) => ({ symbol, price: data[resolver.idFor("coingecko", symbol)]?.usd }))
        .filter((q) => Number.isFinite(q.price));
    },
  };
}

/**
 * CoinPaprika tickers. Aggregator, free, no key. One request covers everything.
 *
 * Matched by paprika id rather than ticker: several distinct assets share a
 * ticker (`SOL` is both `sol-solana` and `sol-binance-peg-sol`), so matching on
 * symbol would silently price a wrapped derivative as the real asset.
 */
export function coinpaprikaSource(resolver) {
  return {
    name: "coinpaprika",
    kind: "aggregator",
    async quotes(symbols) {
      const wanted = symbols.filter((s) => resolver.idFor("coinpaprika", s));
      if (wanted.length === 0) return [];
      const all = await fetchJson("https://api.coinpaprika.com/v1/tickers", { timeoutMs: 20_000 });
      const byId = new Map(all.map((t) => [t.id, t]));
      return wanted
        .map((symbol) => ({
          symbol,
          price: byId.get(resolver.idFor("coinpaprika", symbol))?.quotes?.USD?.price,
        }))
        .filter((q) => Number.isFinite(q.price));
    },
  };
}

/**
 * Bitstamp spot, USD-quoted. An independent venue, one request per pair.
 *
 * A pair that does not exist returns 404, which `Promise.allSettled` absorbs —
 * an unlisted asset loses this source rather than failing the rebalance.
 */
export function bitstampSource() {
  return {
    name: "bitstamp",
    kind: "exchange",
    async quotes(symbols) {
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => {
          const data = await fetchJson(`https://www.bitstamp.net/api/v2/ticker/${bitstampPair(symbol)}`);
          return { symbol, price: Number(data.last) };
        }),
      );
      return results
        .filter((r) => r.status === "fulfilled" && Number.isFinite(r.value.price))
        .map((r) => r.value);
    },
  };
}

/**
 * Bitfinex spot, USD-quoted. An independent venue.
 *
 * Uses the v2 batch endpoint: v1 rejects the `AVAX:USD`-style symbols that
 * Bitfinex uses for longer tickers, so v1 silently loses those assets.
 * In v2's array response, index 7 is the last price. Unknown pairs are simply
 * absent from the response.
 */
export function bitfinexSource() {
  const LAST_PRICE_INDEX = 7;
  return {
    name: "bitfinex",
    kind: "exchange",
    async quotes(symbols) {
      if (symbols.length === 0) return [];
      const byPair = new Map(symbols.map((s) => [bitfinexPair(s), s]));
      const rows = await fetchJson(
        `https://api-pub.bitfinex.com/v2/tickers?symbols=${[...byPair.keys()].join(",")}`,
      );
      return rows
        .map((row) => ({ symbol: byPair.get(row[0]), price: Number(row[LAST_PRICE_INDEX]) }))
        .filter((q) => q.symbol && Number.isFinite(q.price));
    },
  };
}

/** Deterministic in-process source, for tests and offline dry runs. */
export function fixtureSource(name, pricesBySymbol) {
  return {
    name,
    kind: "fixture",
    async quotes(symbols) {
      return symbols
        .filter((s) => Number.isFinite(pricesBySymbol[s]))
        .map((symbol) => ({ symbol, price: pricesBySymbol[symbol] }));
    },
  };
}

/**
 * Query every source concurrently and group quotes by symbol.
 *
 * @returns {Promise<{quotesBySymbol: Map<string, Array<{source: string, price: number}>>,
 *   sourceErrors: Array<{source: string, error: string}>}>}
 */
export async function collectQuotes(sources, symbols) {
  const settled = await Promise.allSettled(sources.map((s) => s.quotes(symbols)));
  const quotesBySymbol = new Map(symbols.map((s) => [s, []]));
  const sourceErrors = [];

  settled.forEach((result, i) => {
    const source = sources[i].name;
    if (result.status === "rejected") {
      sourceErrors.push({ source, error: String(result.reason?.message ?? result.reason) });
      return;
    }
    for (const quote of result.value) {
      quotesBySymbol.get(quote.symbol)?.push({ source, price: quote.price });
    }
  });

  return { quotesBySymbol, sourceErrors };
}
