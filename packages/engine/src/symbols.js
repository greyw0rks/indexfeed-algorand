/**
 * Symbol resolution for price sources.
 *
 * The universe is now discovered from fundamentals providers rather than
 * hardcoded, so price adapters cannot rely on a static ticker→pair table. Two
 * mechanisms replace it:
 *
 *   - Exchanges follow derivable conventions (`btcusd`, `tAVAX:USD`), so their
 *     identifiers are computed from the ticker.
 *   - Aggregators use opaque slugs (`avalanche-2`, `sol-solana`), which cannot be
 *     derived. Those come from the fundamentals fetch, which already carries each
 *     provider's own id for every asset it reported.
 *
 * A derived exchange pair may simply not exist — an asset need not be listed on
 * Bitstamp. That is handled by the adapter yielding no quote for it, which
 * reconciliation already treats as a normal missing source.
 */

/** Bitstamp: lowercase ticker + `usd`, e.g. `BTC` -> `btcusd`. */
export function bitstampPair(symbol) {
  return `${symbol.toLowerCase()}usd`;
}

/**
 * Bitfinex v2: `t` + ticker + `USD`, but tickers longer than three characters
 * take a colon-separated form (`tAVAX:USD`). Getting this wrong does not error —
 * v1 returns "Unknown symbol" and the asset silently loses a source.
 */
export function bitfinexPair(symbol) {
  return symbol.length > 3 ? `t${symbol}:USD` : `t${symbol}USD`;
}

/**
 * Build a resolver over a fetched universe.
 *
 * `providerIds` on each row maps provider name to that provider's id, populated
 * by `collectFundamentals`. Symbols absent from a provider resolve to undefined
 * and are skipped by that adapter.
 */
export function createSymbolResolver(universe) {
  const byProvider = new Map();
  for (const asset of universe) {
    for (const [provider, id] of Object.entries(asset.providerIds ?? {})) {
      if (!byProvider.has(provider)) byProvider.set(provider, new Map());
      byProvider.get(provider).set(asset.symbol, id);
    }
  }

  return {
    /** Aggregator slug for `symbol`, or undefined if that provider lacks it. */
    idFor(provider, symbol) {
      return byProvider.get(provider)?.get(symbol);
    },
    /** All symbols a provider reported, for building a batch request. */
    symbolsFor(provider, symbols) {
      const known = byProvider.get(provider);
      return known ? symbols.filter((s) => known.has(s)) : [];
    },
  };
}
