import assert from "node:assert/strict";
import { test } from "node:test";
import { runRebalance } from "../src/rebalance.js";
import { fixtureSource } from "../src/sources.js";
import { METHODOLOGY, TOTAL_WEIGHT_BPS, methodologyHash } from "../src/methodology.js";
import { fromScaledValue } from "../src/index-math.js";

const PRICES = { A: 100, B: 60, C: 30, D: 12, E: 6 };

/**
 * Candidates shaped like `collectFundamentals` output. Volume scales with cap so
 * every name clears the turnover rule, and the change values sit outside the
 * stable band — a quiet asset classifies as a stablecoin and a null one as
 * unknown volatility, either of which would empty the universe before pricing.
 */
const universe = Object.keys(PRICES).map((symbol, i) => {
  const marketCapUsd = (5 - i) * 20e9;
  return {
    symbol,
    name: `Asset ${symbol}`,
    marketCapUsd,
    volume24hUsd: marketCapUsd * 0.02,
    listingAgeDays: 500,
    change24hPct: -2.5,
    change7dPct: -6,
    sources: ["fixture-provider"],
  };
});

/** Three sources within the deviation band, so reconciliation succeeds. */
function sourcesAt(prices) {
  const skew = (f) => Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v * f]));
  return [
    fixtureSource("a", prices),
    fixtureSource("b", skew(1.001)),
    fixtureSource("c", skew(0.999)),
  ];
}

test("inception epoch is 0 and starts at the base level", async () => {
  const { update, state, audit } = await runRebalance({ sources: sourcesAt(PRICES), universe });
  assert.equal(update.epoch, 0);
  assert.equal(fromScaledValue(update.value).split(".")[0], String(METHODOLOGY.baseLevel));
  assert.equal(update.methodologyHash, methodologyHash());
  assert.equal(update.constituents.reduce((s, c) => s + c.weight_bps, 0), TOTAL_WEIGHT_BPS);
  assert.equal(state.epoch, 0);
  assert.equal(audit.previousLevel, null);
});

test("weights respect the concentration cap", async () => {
  const { update } = await runRebalance({ sources: sourcesAt(PRICES), universe });
  for (const c of update.constituents) {
    assert.ok(c.weight_bps <= METHODOLOGY.concentrationCapBps, `${c.symbol} at ${c.weight_bps}bps`);
  }
});

test("a rebalance at unchanged prices leaves the level unchanged", async () => {
  const first = await runRebalance({ sources: sourcesAt(PRICES), universe });
  const second = await runRebalance({
    sources: sourcesAt(PRICES),
    universe,
    previousState: first.state,
  });
  assert.equal(second.update.epoch, 1);
  // Continuity: recomposition alone must not move the level.
  assert.equal(fromScaledValue(second.update.value), fromScaledValue(first.update.value));
});

test("price movement moves the level, recomposition does not", async () => {
  const first = await runRebalance({ sources: sourcesAt(PRICES), universe });
  const doubled = await runRebalance({
    sources: sourcesAt({ ...PRICES, A: PRICES.A * 2 }),
    universe,
    previousState: first.state,
  });
  assert.ok(Number(doubled.audit.levelDisplay) > Number(first.audit.levelDisplay));
});

test("an asset without consensus prices is dropped from the epoch", async () => {
  // Only one source quotes E, below minSources, so it cannot be weighted.
  const sources = [
    fixtureSource("a", PRICES),
    fixtureSource("b", { A: 100, B: 60, C: 30, D: 12 }),
    fixtureSource("c", { A: 100, B: 60, C: 30, D: 12 }),
  ];
  const { update, audit } = await runRebalance({ sources, universe });
  assert.ok(!update.constituents.some((c) => c.symbol === "E"));
  assert.ok(audit.priceRejections.some((r) => r.symbol === "E"));
  assert.equal(update.constituents.reduce((s, c) => s + c.weight_bps, 0), TOTAL_WEIGHT_BPS);
});

test("a failing source is recorded but does not fail the rebalance", async () => {
  const broken = { name: "broken", async quotes() { throw new Error("venue down"); } };
  const { update, audit } = await runRebalance({
    sources: [...sourcesAt(PRICES), broken],
    universe,
  });
  assert.equal(update.epoch, 0);
  assert.deepEqual(audit.sourceErrors, [{ source: "broken", error: "venue down" }]);
});

test("refuses to publish when no constituent survives", async () => {
  const dead = [{ name: "dead", async quotes() { return []; } }];
  await assert.rejects(
    () => runRebalance({ sources: dead, universe }),
    /no eligible constituent could be priced/,
  );
});

test("refuses to publish when screening empties the universe", async () => {
  // Every name is a stablecoin by volatility, so nothing reaches pricing.
  const stable = universe.map((a) => ({ ...a, change24hPct: 0.01, change7dPct: -0.02 }));
  await assert.rejects(
    () => runRebalance({ sources: sourcesAt(PRICES), universe: stable }),
    /no eligible constituents after screening/,
  );
});

test("audit records the price sources behind every constituent", async () => {
  const { update, audit } = await runRebalance({ sources: sourcesAt(PRICES), universe });
  for (const c of update.constituents) {
    assert.ok(audit.prices[c.symbol].sources.length >= METHODOLOGY.pricing.minSources);
  }
});
