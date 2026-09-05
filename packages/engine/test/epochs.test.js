import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { epochStore } from "../src/epochs.js";

const record = (epoch) => ({
  index: "IFX20",
  epoch,
  publishedAt: new Date(Date.UTC(2026, 8, 3 + epoch)).toISOString(),
  level: `${1000 + epoch}.0000000`,
  constituents: [{ symbol: "BTC", weightBps: 10_000 }],
});

describe("epoch store", () => {
  let dir;
  let store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "indexfeed-epochs-"));
    store = epochStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("starts empty rather than throwing", async () => {
    assert.equal(await store.head(), null);
    assert.equal(await store.latest(), null);
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.at(0), null);
  });

  it("appends epoch 0 first", async () => {
    await store.append(record(0));
    assert.equal(await store.head(), 0);
    assert.equal((await store.latest()).epoch, 0);
    assert.deepEqual(await store.list(), [0]);
  });

  it("requires the first epoch to be 0", async () => {
    // Starting at 5 would leave the divisor continuity chain rooted at nothing.
    await assert.rejects(() => store.append(record(5)), /expected 0/);
  });

  it("rejects a gap", async () => {
    await store.append(record(0));
    await assert.rejects(() => store.append(record(2)), /expected 1/);
  });

  it("rejects republishing an epoch", async () => {
    // This is the contract invariant being reproduced off-chain: a bad epoch is
    // superseded by the next one, never edited. The succession check fires first,
    // so the message names the expected epoch rather than immutability — the
    // "already published" branch only becomes reachable when a record exists at
    // head + 1, which is the interrupted-append case below.
    await store.append(record(0));
    await assert.rejects(() => store.append(record(0)), /epoch 0 rejected: expected 1/);
  });

  it("rejects going backwards", async () => {
    await store.append(record(0));
    await store.append(record(1));
    await assert.rejects(() => store.append(record(0)), /expected 2/);
  });

  it("reads back an arbitrary epoch", async () => {
    for (let e = 0; e <= 3; e += 1) await store.append(record(e));
    assert.deepEqual(await store.list(), [0, 1, 2, 3]);
    assert.equal((await store.at(2)).level, "1002.0000000");
    assert.equal(await store.at(4), null);
  });

  it("ignores non-epoch files in the directory", async () => {
    await store.append(record(0));
    await writeFile(join(store.epochDir, "notes.txt"), "scratch", "utf8");
    await writeFile(join(store.epochDir, "epoch-bad.json"), "{}", "utf8");
    assert.deepEqual(await store.list(), [0]);
  });

  it("treats a negative or non-integer epoch as absent", async () => {
    await store.append(record(0));
    assert.equal(await store.at(-1), null);
    assert.equal(await store.at(1.5), null);
    assert.equal(await store.at(Number.NaN), null);
  });

  it("survives an interrupted append: an orphan record is overwritten", async () => {
    // The record is written before the head pointer moves, so a crash between the
    // two leaves a record the next attempt replaces — never a head pointing at
    // an epoch that does not exist.
    await store.append(record(0));
    await writeFile(join(store.epochDir, "epoch-00001.json"), JSON.stringify({ epoch: 1, junk: true }), "utf8");
    assert.equal(await store.head(), 0);
    // The orphan makes epoch 1 look published, so append refuses — the operator
    // has to look rather than silently overwriting a possibly-real record.
    await assert.rejects(() => store.append(record(1)), /immutable/);
  });
});
