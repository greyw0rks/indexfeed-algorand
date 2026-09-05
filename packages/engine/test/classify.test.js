import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ExclusionReason,
  classifyExclusion,
  looksLikeDerivative,
  looksLikeStablecoin,
} from "../src/classify.js";

const candidate = (over = {}) => ({
  symbol: "FOO",
  name: "Foo Network",
  change24hPct: -2.5,
  change7dPct: -6,
  ...over,
});

test("a real constituent is not excluded", () => {
  assert.equal(classifyExclusion(candidate()), null);
});

test("a stablecoin needs both windows quiet", () => {
  assert.ok(looksLikeStablecoin(candidate({ change24hPct: 0.03, change7dPct: -0.01 })));
  // A flat 24h is ordinary for any large asset, so 24h alone must not convict.
  assert.ok(!looksLikeStablecoin(candidate({ change24hPct: 0.03, change7dPct: -4.2 })));
});

test("stablecoin detection is peg-agnostic", () => {
  // sUSDe trades near 1.25 and sUSDS near 1.11; a "price near $1" test misses
  // both. Volatility catches them, so no price is consulted at all.
  const yieldBearing = candidate({ symbol: "YBS", priceUsd: 1.25, change24hPct: 0.04, change7dPct: 0.09 });
  assert.equal(classifyExclusion(yieldBearing), ExclusionReason.STABLECOIN);
});

test("derivatives are caught by ticker and by name", () => {
  assert.ok(looksLikeDerivative(candidate({ symbol: "WBTC", name: "WBTC" })));
  assert.ok(looksLikeDerivative(candidate({ symbol: "XYZ", name: "Lido Staked Ether" })));
  assert.ok(looksLikeDerivative(candidate({ symbol: "XYZ", name: "Bridged USDC" })));
  assert.ok(!looksLikeDerivative(candidate()));
});

test("commodity tokens are excluded as commodities", () => {
  assert.equal(classifyExclusion(candidate({ symbol: "PAXG", name: "PAX Gold" })), ExclusionReason.COMMODITY);
});

test("classification order names the real cause", () => {
  // sUSDe is both a staking derivative and price-stable. The documented order
  // reports the structural reason, which is the one that will not go stale.
  const susde = candidate({ symbol: "SUSDE", name: "Ethena Staked USDe", change24hPct: 0.01, change7dPct: 0.02 });
  assert.equal(classifyExclusion(susde), ExclusionReason.DERIVATIVE);
});

test("missing change data is excluded rather than admitted", () => {
  // The stablecoin test cannot run without both windows. Excluding costs one
  // slot in a 20-name index; admitting a stablecoin corrupts the level.
  assert.equal(
    classifyExclusion(candidate({ change7dPct: null })),
    ExclusionReason.UNKNOWN_VOLATILITY,
  );
});

test("the stable band is configurable", () => {
  const drifting = candidate({ change24hPct: 0.8, change7dPct: -0.9 });
  assert.equal(classifyExclusion(drifting), null);
  assert.equal(classifyExclusion(drifting, { maxChangePct: 1 }), ExclusionReason.STABLECOIN);
});

test("a month of movement vetoes a quiet week", () => {
  // The real reading that produced this test: on 2026-09-05 ETH was +0.42% over
  // 24h and +0.40% over 7d, which convicts on the short windows alone, and
  // +28.5% over 30d, which cannot be a peg. Shipping the short-window verdict
  // would have published a top-20 crypto index with no ETH in it.
  const flatWeek = { symbol: "ETH", name: "Ethereum", change24hPct: 0.42, change7dPct: 0.4 };
  assert.equal(classifyExclusion(flatWeek), ExclusionReason.STABLECOIN, "short windows alone convict");
  assert.equal(classifyExclusion({ ...flatWeek, change30dPct: 28.5 }), null);
});

test("a real stablecoin is still caught once 30d is available", () => {
  // Separation on the same day: USDT and USDC moved 0.1% over 30d against ETH's
  // 28.5%, so the veto has ~200x of headroom rather than the 1.6x the 7d window
  // was relying on.
  const usdt = candidate({ symbol: "USDT", name: "Tether", change24hPct: 0.008, change7dPct: 0.0, change30dPct: 0.1 });
  assert.equal(classifyExclusion(usdt), ExclusionReason.STABLECOIN);
});

test("a yield-bearing stable's accrual does not trip the veto", () => {
  // ~2%/30d is roughly 26%/yr, which is the outer edge of real stablecoin yield.
  // Set the veto tighter than this and sUSDe-style assets escape classification.
  const accruing = candidate({ symbol: "YBS", change24hPct: 0.06, change7dPct: 0.4, change30dPct: 1.9 });
  assert.equal(classifyExclusion(accruing), ExclusionReason.STABLECOIN);
  assert.equal(classifyExclusion({ ...accruing, change30dPct: 2.1 }), null);
});

test("an absent 30d reading leaves the two-window verdict standing", () => {
  // Providers past CoinGecko's first page report no 30d window. Treating that as
  // exculpatory would admit every tail stablecoin; treating it as unclassifiable
  // would empty the tail. It falls back to the older, weaker test on purpose.
  const quiet = candidate({ change24hPct: 0.02, change7dPct: -0.03 });
  assert.equal(classifyExclusion(quiet), ExclusionReason.STABLECOIN);
  assert.equal(classifyExclusion({ ...quiet, change30dPct: null }), ExclusionReason.STABLECOIN);
  assert.ok(looksLikeStablecoin({ ...quiet, change30dPct: undefined }));
});
