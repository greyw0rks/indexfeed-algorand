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
