import assert from "node:assert/strict";
import { test } from "node:test";
import { CADENCE_TOLERANCE, METHODOLOGY, cadenceGate } from "../src/methodology.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 10, 3, 17);
/** `days` before NOW, expressed in the seconds the contract stores. */
const gate = (days) => cadenceGate({ publishedAtSeconds: (NOW - days * DAY) / 1000, now: NOW });

test("a full cadence is due", () => {
  const g = gate(METHODOLOGY.cadenceDays);
  assert.ok(g.isDue);
  assert.equal(g.remainingMs, 0);
});

test("the tolerance absorbs a scheduler firing early", () => {
  // A run following a delayed one sits under a full cadence through no fault of
  // its own, and must not read as off-cadence.
  const dueAfterDays = METHODOLOGY.cadenceDays * CADENCE_TOLERANCE;
  assert.ok(gate(dueAfterDays + 0.01).isDue);
  assert.ok(!gate(dueAfterDays - 0.01).isDue);
  // For a weekly cadence that slack is about 17 hours.
  assert.ok(gate(6.5).isDue);
});

test("a second publish the same day is not due", () => {
  // The hazard the gate exists for: a manual trigger stacking an epoch onto a
  // scheduled one, which is how epochs 0 and 1 ended up 84 minutes apart.
  const g = gate(0.02);
  assert.ok(!g.isDue);
  assert.ok(g.remainingMs > 6 * DAY);
});

test("elapsed time is reported so the caller can explain the refusal", () => {
  const g = gate(21);
  assert.ok(g.isDue);
  assert.equal(g.elapsedMs, 21 * DAY);
});

test("the cadence is not part of the hash input by accident", () => {
  // cadenceGate and CADENCE_TOLERANCE are helpers, not methodology fields: the
  // tolerance is an operational allowance for scheduler drift, so folding it
  // into METHODOLOGY would change the on-chain hash for a non-rule change.
  assert.ok(!("tolerance" in METHODOLOGY));
  assert.equal(typeof METHODOLOGY.cadenceDays, "number");
});
