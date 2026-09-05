import assert from "node:assert/strict";
import { test } from "node:test";
import { bitfinexPair, bitstampPair, createSymbolResolver } from "../src/symbols.js";

test("bitstamp pairs are the lowercased ticker plus usd", () => {
  assert.equal(bitstampPair("BTC"), "btcusd");
  assert.equal(bitstampPair("AVAX"), "avaxusd");
});

test("bitfinex switches form above three characters", () => {
  // v2 returns "Unknown symbol" rather than an error for the wrong form, so the
  // asset would silently lose a source instead of failing loudly.
  assert.equal(bitfinexPair("BTC"), "tBTCUSD");
  assert.equal(bitfinexPair("AVAX"), "tAVAX:USD");
});

const universe = [
  { symbol: "BTC", providerIds: { coingecko: "bitcoin", coinpaprika: "btc-bitcoin" } },
  { symbol: "AVAX", providerIds: { coingecko: "avalanche-2" } },
  { symbol: "NOIDS" },
];

test("the resolver returns each provider's own slug", () => {
  const resolver = createSymbolResolver(universe);
  assert.equal(resolver.idFor("coingecko", "BTC"), "bitcoin");
  assert.equal(resolver.idFor("coinpaprika", "BTC"), "btc-bitcoin");
});

test("a symbol a provider never reported resolves to undefined", () => {
  const resolver = createSymbolResolver(universe);
  // The adapter skips it, and reconciliation treats it as a missing source.
  assert.equal(resolver.idFor("coinpaprika", "AVAX"), undefined);
  assert.equal(resolver.idFor("coingecko", "NOIDS"), undefined);
  assert.equal(resolver.idFor("unknown-provider", "BTC"), undefined);
});

test("symbolsFor narrows a batch request to what the provider knows", () => {
  const resolver = createSymbolResolver(universe);
  assert.deepEqual(resolver.symbolsFor("coingecko", ["BTC", "AVAX", "NOIDS"]), ["BTC", "AVAX"]);
  assert.deepEqual(resolver.symbolsFor("coinpaprika", ["BTC", "AVAX"]), ["BTC"]);
  assert.deepEqual(resolver.symbolsFor("unknown-provider", ["BTC"]), []);
});
