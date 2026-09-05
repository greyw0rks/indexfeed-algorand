import assert from "node:assert/strict";
import { test } from "node:test";
import { collectFundamentals, fixtureFundamentals } from "../src/fundamentals.js";

const row = (symbol, over = {}) => ({
  symbol,
  providerId: symbol.toLowerCase(),
  name: symbol,
  marketCapUsd: 1_000e9,
  volume24hUsd: 20e6,
  listingAgeDays: 400,
  priceUsd: 100,
  change24hPct: -2,
  change7dPct: -5,
  ...over,
});

test("numeric fields are medianed across providers", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("p1", [row("BTC", { marketCapUsd: 1_000e9, volume24hUsd: 20e6 })]),
    fixtureFundamentals("p2", [row("BTC", { marketCapUsd: 1_002e9, volume24hUsd: 24e6 })]),
  ]);
  assert.equal(universe.length, 1);
  assert.equal(universe[0].marketCapUsd, 1_001e9);
  assert.equal(universe[0].volume24hUsd, 22e6);
  assert.deepEqual(universe[0].sources, ["p1", "p2"]);
});

test("listing age takes the oldest claim, not the median", async () => {
  // A provider that started tracking an asset late is wrong in a knowable
  // direction, so the oldest claim is the better lower bound.
  const { universe } = await collectFundamentals([
    fixtureFundamentals("p1", [row("BTC", { listingAgeDays: 120 })]),
    fixtureFundamentals("p2", [row("BTC", { listingAgeDays: 5_889 })]),
  ]);
  assert.equal(universe[0].listingAgeDays, 5_889);
});

test("a null age is ignored when another provider has one", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("gecko", [row("BTC", { listingAgeDays: null })]),
    fixtureFundamentals("paprika", [row("BTC", { listingAgeDays: 400 })]),
  ]);
  assert.equal(universe[0].listingAgeDays, 400);
});

test("an age no provider reported stays null", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("gecko", [row("BTC", { listingAgeDays: null })]),
  ]);
  // null is not 0 — the screen treats unknown age as failing, and a 0 here
  // would read as a brand-new listing instead.
  assert.equal(universe[0].listingAgeDays, null);
});

test("a single-provider asset is kept but flagged as such", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("p1", [row("BTC"), row("OBSCURE")]),
    fixtureFundamentals("p2", [row("BTC")]),
  ]);
  const obscure = universe.find((a) => a.symbol === "OBSCURE");
  assert.deepEqual(obscure.sources, ["p1"]);
});

test("a failing provider is recorded and the rest still count", async () => {
  const broken = { name: "broken", async fetch() { throw new Error("rate limited"); } };
  const { universe, providerErrors } = await collectFundamentals([
    fixtureFundamentals("p1", [row("BTC")]),
    broken,
  ]);
  assert.equal(universe.length, 1);
  assert.deepEqual(providerErrors, [{ provider: "broken", error: "rate limited" }]);
});

test("the universe is ordered by market cap", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("p1", [
      row("SMALL", { marketCapUsd: 1e9 }),
      row("BIG", { marketCapUsd: 900e9 }),
      row("MID", { marketCapUsd: 50e9 }),
    ]),
  ]);
  assert.deepEqual(universe.map((a) => a.symbol), ["BIG", "MID", "SMALL"]);
});

test("provider ids are kept per provider so slugs resolve later", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("coingecko", [row("AVAX", { providerId: "avalanche-2" })]),
    fixtureFundamentals("coinpaprika", [row("AVAX", { providerId: "avax-avalanche" })]),
  ]);
  assert.deepEqual(universe[0].providerIds, {
    coingecko: "avalanche-2",
    coinpaprika: "avax-avalanche",
  });
});

test("a change window no provider reported is null, not zero", async () => {
  const { universe } = await collectFundamentals([
    fixtureFundamentals("p1", [row("BTC", { change7dPct: null })]),
    fixtureFundamentals("p2", [row("BTC", { change7dPct: null })]),
  ]);
  // Zero would read as a perfectly flat asset, which classifies as a stablecoin.
  assert.equal(universe[0].change7dPct, null);
  assert.equal(universe[0].change24hPct, -2);
});
