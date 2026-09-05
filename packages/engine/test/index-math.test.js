import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inceptionDivisor,
  rebalanceDivisor,
  level,
  toScaledValue,
  fromScaledValue,
  unitsForWeights,
} from "../src/index-math.js";
import { METHODOLOGY } from "../src/methodology.js";

const priceMap = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { price: v, sources: ["a", "b"] }]));

test("inception divisor pins the first level to baseLevel", () => {
  const prices = priceMap({ A: 100, B: 50 });
  const basket = [{ symbol: "A", units: 10 }, { symbol: "B", units: 20 }];
  const d = inceptionDivisor(basket, prices);
  assert.equal(level(basket, prices, d).toFixed(6), METHODOLOGY.baseLevel.toFixed(6));
});

test("level tracks price movement between rebalances", () => {
  const basket = [{ symbol: "A", units: 10 }, { symbol: "B", units: 20 }];
  const d = inceptionDivisor(basket, priceMap({ A: 100, B: 50 }), METHODOLOGY);
  // A doubles; A was half the 2000 basket, so the total rises 50%.
  const after = level(basket, priceMap({ A: 200, B: 50 }), d);
  assert.equal(after.toFixed(4), (METHODOLOGY.baseLevel * 1.5).toFixed(4));
});

test("rebalance divisor makes the level continuous across a composition change", () => {
  const prices = priceMap({ A: 100, B: 50, C: 25 });
  const oldBasket = [{ symbol: "A", units: 10 }, { symbol: "B", units: 20 }];
  const oldDivisor = inceptionDivisor(oldBasket, prices);
  const levelBefore = level(oldBasket, prices, oldDivisor);

  // Swap B out for C entirely — a large composition change.
  const newBasket = [{ symbol: "A", units: 5 }, { symbol: "C", units: 200 }];
  const newDivisor = rebalanceDivisor(newBasket, prices, levelBefore);
  assert.equal(level(newBasket, prices, newDivisor).toFixed(6), levelBefore.toFixed(6));
});

test("unitsForWeights hits the target weights at current prices", () => {
  const prices = priceMap({ A: 200, B: 50 });
  const basket = unitsForWeights([{ symbol: "A", weight: 0.7 }, { symbol: "B", weight: 0.3 }], prices, 1_000);
  assert.equal(basket.find((b) => b.symbol === "A").units, 3.5);
  assert.equal(basket.find((b) => b.symbol === "B").units, 6);
});

test("a missing price is an error, not a silently dropped constituent", () => {
  const prices = priceMap({ A: 100 });
  assert.throws(() => level([{ symbol: "B", units: 1 }], prices, 1), /no reconciled price for B/);
});

test("scaled value round-trips at 7dp", () => {
  assert.equal(toScaledValue(1_000).toString(), "10000000000");
  assert.equal(fromScaledValue("10000000000"), "1000.0000000");
  assert.equal(fromScaledValue(toScaledValue(1234.5678901)), "1234.5678901");
});

test("scaling rejects a non-positive or non-finite level", () => {
  assert.throws(() => toScaledValue(0), /must be positive/);
  assert.throws(() => toScaledValue(NaN), /must be positive/);
});

test("divisors must be positive", () => {
  assert.throws(() => level([{ symbol: "A", units: 1 }], priceMap({ A: 1 }), 0), /divisor must be positive/);
  assert.throws(() => rebalanceDivisor([{ symbol: "A", units: 1 }], priceMap({ A: 1 }), 0), /previousLevel/);
});
