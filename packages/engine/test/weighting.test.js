import assert from "node:assert/strict";
import { test } from "node:test";
import { screen, weight, toBasisPoints } from "../src/weighting.js";
import { METHODOLOGY, TOTAL_WEIGHT_BPS } from "../src/methodology.js";
import { FIXTURE_UNIVERSE } from "../src/fixtures.js";

/**
 * A candidate that passes every rule, shaped like what `collectFundamentals`
 * emits. Volume scales with cap because turnover is a screening rule — a flat
 * volume would fail the largest names on turnover rather than on the rule the
 * test is actually exercising. The change values sit well outside the stable
 * band: a quiet asset is classified as a stablecoin, and null reads as unknown
 * volatility, so both are exclusions rather than a neutral default.
 */
const asset = (symbol, cap, over = {}) => ({
  symbol,
  name: `Asset ${symbol}`,
  marketCapUsd: cap,
  volume24hUsd: cap * 0.02,
  listingAgeDays: 400,
  change24hPct: -2.5,
  change7dPct: -6,
  ...over,
});

test("screen excludes on each rule and reports why", () => {
  const { eligible, excluded } = screen([
    asset("BIG", 1e11),
    asset("SMALL", 1e6),
    asset("THIN", 1e11, { volume24hUsd: 1_000 }),
    asset("NEW", 1e11, { listingAgeDays: 3 }),
    // Stablecoins are detected from realized volatility, not a flag.
    asset("USDT", 1e11, { change24hPct: -0.03, change7dPct: -0.01 }),
  ]);
  assert.deepEqual(eligible.map((a) => a.symbol), ["BIG"]);
  assert.deepEqual(
    Object.fromEntries(excluded.map((e) => [e.symbol, e.reason])),
    { SMALL: "market_cap", THIN: "volume", NEW: "listing_age", USDT: "stablecoin" },
  );
});

test("the offline fixture universe still exercises every exclusion rule", () => {
  // `USE_FIXTURE_PRICES=1` is the offline dev path. If an edit to the fixture
  // left only clean names in it, that path would wave everything through and
  // stop testing the screen at all — silently.
  const { eligible, excluded } = screen(FIXTURE_UNIVERSE);
  const reasons = new Set(excluded.map((e) => e.reason));
  for (const reason of ["stablecoin", "derivative", "commodity", "volume", "turnover", "listing_age"]) {
    assert.ok(reasons.has(reason), `fixture universe no longer triggers ${reason}`);
  }
  assert.equal(eligible.length, METHODOLOGY.targetSize);
});

test("screen truncates to targetSize, largest first", () => {
  const universe = Array.from({ length: 25 }, (_, i) => asset(`A${i}`, (25 - i) * 1e9));
  const { eligible, excluded } = screen(universe);
  assert.equal(eligible.length, METHODOLOGY.targetSize);
  assert.equal(eligible[0].symbol, "A0");
  assert.equal(excluded.filter((e) => e.reason === "below_target_size").length, 5);
});

test("weights are market-cap proportional when nothing breaches the cap", () => {
  const w = weight([asset("A", 60e9), asset("B", 40e9)], { ...METHODOLOGY, concentrationCapBps: 10_000 });
  assert.equal(w.find((x) => x.symbol === "A").weight.toFixed(4), "0.6000");
  assert.equal(w.find((x) => x.symbol === "B").weight.toFixed(4), "0.4000");
});

test("concentration cap is enforced and excess redistributed", () => {
  // A would be 76% uncapped; the 25% cap moves the excess onto the rest.
  const w = weight([
    asset("A", 800e9), asset("B", 100e9), asset("C", 60e9),
    asset("D", 40e9), asset("E", 30e9), asset("F", 20e9),
  ]);
  const byName = Object.fromEntries(w.map((x) => [x.symbol, x.weight]));
  assert.equal(byName.A.toFixed(4), "0.2500");
  // C..F stay uncapped, so their market-cap ordering survives redistribution.
  assert.ok(byName.C > byName.D && byName.D > byName.E && byName.E > byName.F);
  assert.equal(w.reduce((s, x) => s + x.weight, 0).toFixed(6), "1.000000");
});

test("a cap tight enough to bind every name yields an equal-weight index", () => {
  // 25% cap with exactly 4 names: capping cascades until all four sit at the cap.
  const w = weight([asset("A", 800e9), asset("B", 100e9), asset("C", 60e9), asset("D", 40e9)]);
  for (const x of w) assert.equal(x.weight.toFixed(4), "0.2500");
});

test("capping iterates when redistribution pushes a second name over", () => {
  // A and B are both near-dominant: capping A alone would lift B past 25%.
  const w = weight([asset("A", 500e9), asset("B", 450e9), asset("C", 30e9), asset("D", 20e9)]);
  for (const x of w) {
    assert.ok(x.weight <= METHODOLOGY.concentrationCapBps / TOTAL_WEIGHT_BPS + 1e-9, `${x.symbol} breached cap`);
  }
  assert.equal(w.reduce((s, x) => s + x.weight, 0).toFixed(6), "1.000000");
});

test("an unsatisfiable cap is refused rather than silently exceeded", () => {
  // 25% cap with 3 names cannot sum to 100%.
  assert.throws(() => weight([asset("A", 3e9), asset("B", 2e9), asset("C", 1e9)]), /cannot be met/);
});

test("basis points always sum to exactly 10000", () => {
  // Three equal names each round to 3333bps, leaving a 1bp residual.
  const bps = toBasisPoints([
    { symbol: "A", weight: 1 / 3 },
    { symbol: "B", weight: 1 / 3 },
    { symbol: "C", weight: 1 / 3 },
  ]);
  assert.equal(bps.reduce((s, b) => s + b.weightBps, 0), TOTAL_WEIGHT_BPS);
});

test("basis points sum for a realistic capped vector", () => {
  const w = weight([asset("A", 800e9), asset("B", 100e9), asset("C", 60e9), asset("D", 40e9), asset("E", 7e9)]);
  assert.equal(toBasisPoints(w).reduce((s, b) => s + b.weightBps, 0), TOTAL_WEIGHT_BPS);
});
