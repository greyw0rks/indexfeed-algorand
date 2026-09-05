/**
 * API tests.
 *
 * A real paid response cannot be asserted here — that needs a funded Algorand
 * account and a live facilitator, which is what `scripts/probe-facilitator.js` and
 * the paying client cover. What is asserted is everything that decides whether
 * money changes hands correctly: that paid routes are actually gated, that the
 * 402 carries the challenge tag, and that the freshness gate refuses *before* the
 * payment middleware rather than after.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attest, epochStore, stateStore } from "@indexfeed-algorand/engine";
import { loadApiConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const PAY_TO = "7U6BZK7CBIDHVC2IWCW4SVESK5HVL4TARES63CAYQTEJZ2YBEFRQKZSNW4";

/** Prices for the fake basket, as the reconciler would return them. */
function priceMap(entries) {
  return new Map(entries.map(([symbol, price]) => [symbol, { price, sources: ["a", "b"], discarded: [] }]));
}

/**
 * Market cache stub with a settable snapshot age, so the staleness path is
 * testable without waiting three minutes.
 */
function fakeMarket({ ageSeconds = 5 } = {}) {
  const prices = priceMap([
    ["BTC", 100_000],
    ["ETH", 4_000],
  ]);
  const assets = [
    { symbol: "BTC", name: "Bitcoin", marketCapUsd: 2e12, volume24hUsd: 4e10, listingAgeDays: 5000, sources: ["cg"] },
    { symbol: "ETH", name: "Ethereum", marketCapUsd: 5e11, volume24hUsd: 2e10, listingAgeDays: 3600, sources: ["cg"] },
  ];
  return {
    age: ageSeconds,
    warm: async () => ({ pricedSymbols: prices.size, universeSize: assets.length }),
    start() {},
    stop() {},
    priceAgeSeconds() {
      return this.age;
    },
    priceFor: (s) => prices.get(s.toUpperCase()) ?? null,
    allPrices: () => prices,
    assetFor: (s) => assets.find((a) => a.symbol === s.toUpperCase()) ?? null,
    allAssets: () => assets,
    status() {
      return { priceAgeSeconds: this.age, pricedSymbols: prices.size, universeSize: assets.length, lastError: null };
    },
  };
}

/**
 * Facilitator stub.
 *
 * Not an optimisation — the resource server refuses to quote a scheme/network the
 * facilitator has not confirmed, so without this every paid route 500s instead of
 * returning 402. Stubbing the client keeps the tests offline while leaving the
 * production code path (facilitator sync enabled) exactly as it ships.
 */
function fakeFacilitator(caip2) {
  return {
    async getSupported() {
      return {
        x402Version: 2,
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: caip2,
            extra: { feePayer: "ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA" },
          },
        ],
        extensions: [],
        signers: {},
      };
    },
    async verify() {
      throw new Error("verify should not be called in these tests");
    },
    async settle() {
      throw new Error("settle should not be called in these tests");
    },
  };
}

describe("IndexFeed API", () => {
  let dir;
  let config;
  let market;
  let app;
  let server;
  let origin;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "indexfeed-api-"));
    config = loadApiConfig({ X402_PAY_TO: PAY_TO, ALGORAND_NETWORK: "testnet", STATE_DIR: dir, PORT: "0" });

    // A published epoch, written through the real stores so the shape the API
    // reads is the shape the CLI writes.
    const epochs = epochStore(dir);
    const state = stateStore(dir);
    await epochs.append(
      attest(
        {
          index: "IFX20",
          epoch: 0,
          publishedAt: new Date().toISOString(),
          value: "10000000000",
          level: "1000.0000000",
          methodologyHash: "deadbeef",
          constituents: [
            { symbol: "BTC", weightBps: 6000 },
            { symbol: "ETH", weightBps: 4000 },
          ],
        },
        null,
      ),
    );
    await state.save({
      epoch: 0,
      divisor: 1000,
      methodologyHash: "deadbeef",
      basket: [
        { symbol: "BTC", units: 0.006, lastPrice: 100_000 },
        { symbol: "ETH", units: 0.1, lastPrice: 4_000 },
      ],
    });

    market = fakeMarket();
    app = createApp(config, { market, facilitatorClient: fakeFacilitator(config.caip2) });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    app.stop();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("describes itself for free, including price and network", async () => {
    const res = await fetch(`${origin}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.payment.payTo, PAY_TO);
    assert.equal(body.payment.tag, "x402-global-challenge");
    assert.equal(body.payment.asset.id, "10458941");
    assert.equal(body.routes.length, 8);
    // The volume route has to be the cheapest, or continuous polling is irrational.
    const tick = body.routes.find((r) => r.route.endsWith("/v1/index/tick"));
    assert.equal(tick.price, "$0.001");
    assert.ok(
      body.routes.every((r) => Number(r.price.replace("$", "")) >= Number(tick.price.replace("$", ""))),
      "tick must be the cheapest route",
    );
  });

  it("carries the challenge tag on every paid route, in extra and in tags", async () => {
    const { buildRoutes } = await import("../src/routes.js");
    const routes = buildRoutes(config);
    for (const [pattern, cfg] of Object.entries(routes)) {
      // extra.tag is what the leaderboard counts; tags is what the catalog shows.
      // Missing the first is the silent failure, so both are asserted.
      assert.equal(cfg.accepts.extra.tag, "x402-global-challenge", `${pattern} extra.tag`);
      assert.ok(cfg.tags.includes("x402-global-challenge"), `${pattern} tags`);
      assert.equal(cfg.accepts.extra.asset, "10458941", `${pattern} asset`);
      assert.ok(cfg.description.length > 40, `${pattern} needs a concrete description`);
      assert.ok(cfg.extensions?.bazaar, `${pattern} needs a bazaar declaration`);
    }
  });

  it("serves llms.txt so the Bazaar crawler can enrich the listing", async () => {
    const res = await fetch(`${origin}/llms.txt`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /IndexFeed/);
    assert.match(text, /\/v1\/index\/tick/);
    assert.match(text, /x402/);
  });

  it("reports data freshness separately from process health", async () => {
    const res = await fetch(`${origin}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.fresh, true);
    assert.equal(body.data.head, 0);
  });

  for (const path of [
    "/v1/index/tick",
    "/v1/index/latest",
    "/v1/index/constituents",
    "/v1/index/history",
    "/v1/index/history/0",
    "/v1/assets/quote?symbols=BTC",
    "/v1/assets/market",
    "/v1/asset/BTC",
  ]) {
    it(`gates ${path} behind payment`, async () => {
      const res = await fetch(`${origin}${path}`);
      assert.equal(res.status, 402);
      // The requirements travel in this header; a 402 without it is unpayable.
      assert.ok(res.headers.get("payment-required"), "expected a PAYMENT-REQUIRED header");
    });
  }

  it("refuses stale data before charging for it, not after", async () => {
    market.age = config.priceMaxStaleSeconds + 60;
    try {
      const res = await fetch(`${origin}/v1/index/tick`);
      // 503 rather than 402 is the whole point: the caller has not paid, so it
      // can back off without having bought a stale level it cannot identify.
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.match(body.error, /stale/);
      assert.equal(res.headers.get("retry-after"), String(config.priceTtlSeconds));
    } finally {
      market.age = 5;
    }
  });

  it("still serves published epochs when the live feed is stale", async () => {
    market.age = config.priceMaxStaleSeconds + 60;
    try {
      // An epoch is a committed historical record; price staleness is irrelevant
      // to it, so it must stay payable rather than being gated with the tick.
      const res = await fetch(`${origin}/v1/index/latest`);
      assert.equal(res.status, 402);
    } finally {
      market.age = 5;
    }
  });

  it("404s an unknown route without demanding payment for it", async () => {
    const res = await fetch(`${origin}/v1/nope`);
    assert.equal(res.status, 404);
  });
});
