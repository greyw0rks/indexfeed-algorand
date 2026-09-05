import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcile, RejectReason } from "../src/prices.js";
import { METHODOLOGY } from "../src/methodology.js";

test("takes the median of agreeing sources", () => {
  const r = reconcile([
    { source: "a", price: 100 },
    { source: "b", price: 101 },
    { source: "c", price: 102 },
  ]);
  assert.equal(r.price, 101);
  assert.deepEqual(r.sources.sort(), ["a", "b", "c"]);
  assert.deepEqual(r.discarded, []);
});

test("discards a source beyond the deviation band", () => {
  // 500bps band around a median of 100: 200 is a manipulated print.
  const r = reconcile([
    { source: "a", price: 100 },
    { source: "b", price: 101 },
    { source: "c", price: 200 },
  ]);
  assert.equal(r.price, 100.5);
  assert.equal(r.discarded.length, 1);
  assert.equal(r.discarded[0].source, "c");
});

test("rejects when fewer than minSources report", () => {
  const r = reconcile([{ source: "a", price: 100 }]);
  assert.equal(r.rejected, RejectReason.TOO_FEW_SOURCES);
});

test("rejects when too few sources survive trimming", () => {
  // Two sources, wildly apart: the median sits between them and both are
  // outside the band, so there is no consensus to publish.
  const r = reconcile([
    { source: "a", price: 100 },
    { source: "b", price: 300 },
  ]);
  assert.equal(r.rejected, RejectReason.NO_CONSENSUS);
});

test("ignores non-finite and non-positive quotes", () => {
  const r = reconcile([
    { source: "a", price: 100 },
    { source: "b", price: 100 },
    { source: "c", price: 0 },
    { source: "d", price: NaN },
  ]);
  assert.equal(r.price, 100);
  assert.equal(r.sources.length, 2);
});

test("a single outlier cannot move the price by more than the band", () => {
  const base = [
    { source: "a", price: 50 },
    { source: "b", price: 50 },
    { source: "c", price: 50 },
  ];
  const clean = reconcile(base).price;
  const attacked = reconcile([...base, { source: "evil", price: 5_000_000 }]).price;
  const moveBps = Math.abs((attacked - clean) / clean) * 10_000;
  assert.ok(moveBps <= METHODOLOGY.pricing.maxDeviationBps, `moved ${moveBps}bps`);
});
