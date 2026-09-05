/**
 * Paid route definitions: prices, Bazaar discovery metadata, and the challenge tag.
 *
 * Four things here are load-bearing and easy to get subtly wrong, so they are
 * called out rather than left to be inferred:
 *
 * 1. `extra.tag` is where the challenge tag has to live. Not the route-level
 *    `tags` array, which is Bazaar catalog metadata — the tag the leaderboard
 *    filters on is carried inside the payment requirements. Both are set here,
 *    because `tags` is what a human browsing the catalog sees and `extra.tag` is
 *    what the count is keyed on; setting only the readable one is the silent
 *    failure mode. Verified against live tagged entries in /discovery/resources.
 *
 * 2. `resource` is pinned to the public origin. The middleware would otherwise
 *    derive it from the request, and behind a proxy that yields the internal
 *    host — which lists an unreachable URL in the catalog even though payments
 *    settle fine, so the endpoint looks healthy while being undiscoverable.
 *
 * 3. **Every `pathParams` needs a `pathParamsSchema`, and every `input` needs an
 *    `inputSchema`.** `declareDiscoveryExtension` will happily accept the data
 *    without the schema, then generate an extension its own validator rejects
 *    with `/input: must NOT have additional properties` — because the generated
 *    schema only lists `type`, `method`, and `queryParams` unless the schema is
 *    supplied. The route still serves and still takes payment; it just never
 *    lists. `assertRoutesDiscoverable` below turns that log line into a failure.
 *
 * 4. Path params are named, never wildcards. A `/*` pattern makes the bazaar
 *    extension auto-generate `var1`, `var2`… as parameter names, so the catalog
 *    entry tells an agent nothing about what to put in the URL.
 *
 * Every route declares a real example response. That example is the only thing a
 * paying agent can inspect before spending, so it is kept accurate — a wrong
 * example is worse than none, because it converts a free decision into a paid
 * surprise.
 */
import { declareDiscoveryExtension, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { methodologyHash } from "@indexfeed-algorand/engine";

const SERVICE_NAME = "IndexFeed";

/**
 * Short methodology hash for the advertised examples.
 *
 * Derived rather than pasted. These examples are the only thing a paying agent
 * can inspect before spending, and a literal went stale the moment the rulebook
 * changed — the catalog then advertised a hash no epoch would ever carry.
 */
const HASH_PREVIEW = `${methodologyHash().slice(0, 12)}…`;
const MIME = "application/json";

const str = (properties, required) => ({
  type: "object",
  properties: Object.fromEntries(Object.keys(properties).map((k) => [k, { type: "string" }])),
  ...(required ? { required } : {}),
});

export function buildRoutes(config) {
  const { caip2, payTo, usdcAsa, challengeTag, prices, publicBaseUrl } = config;

  /**
   * One payment option per route. `maxTimeoutSeconds` is generous because the
   * client has to build, sign, and submit an ASA transfer between receiving the
   * 402 and retrying — the facilitator pays the fee, but it is still a chain write.
   */
  const accepts = (price) => ({
    scheme: "exact",
    price,
    network: caip2,
    payTo,
    maxTimeoutSeconds: 120,
    extra: { asset: usdcAsa, tag: challengeTag },
  });

  const route = (path, price, description, discovery, extraTags = []) => ({
    accepts: accepts(price),
    description,
    mimeType: MIME,
    serviceName: SERVICE_NAME,
    tags: [challengeTag, "crypto", "market-data", ...extraTags],
    ...(publicBaseUrl ? { resource: `${publicBaseUrl}${path}` } : {}),
    extensions: declareDiscoveryExtension(discovery),
  });

  const routes = {
    "GET /v1/index/tick": route(
      "/v1/index/tick",
      prices.tick,
      "Live level of the IFX20 crypto index, marked to current reconciled prices, with drifted constituent weights",
      {
        output: {
          example: {
            index: "IFX20",
            epoch: 0,
            level: 1002.4471903,
            asOf: "2026-09-03T08:14:02.118Z",
            priceAgeSeconds: 6.4,
            methodologyHash: HASH_PREVIEW,
            constituents: [{ symbol: "BTC", price: 111842.5, weightBps: 2500 }],
            stale: [],
          },
        },
      },
      ["index", "realtime"],
    ),

    "GET /v1/index/latest": route(
      "/v1/index/latest",
      prices.latest,
      "Latest published IFX20 epoch: committed level, target weights in basis points, methodology hash, and signed attestation digest",
      {
        output: {
          example: {
            index: "IFX20",
            epoch: 0,
            publishedAt: "2026-09-03T08:00:00.000Z",
            value: "10024471903",
            level: "1002.4471903",
            methodologyHash: HASH_PREVIEW,
            constituents: [{ symbol: "BTC", weightBps: 2500 }],
            attestation: { alg: "ed25519-sha256", digest: "9f2c…", signature: "MEUCIQ…" },
          },
        },
      },
      ["index"],
    ),

    "GET /v1/index/constituents": route(
      "/v1/index/constituents",
      prices.constituents,
      "Composition of the latest IFX20 epoch: every constituent with its target weight in basis points, plus the rules it was screened under",
      {
        output: {
          example: {
            index: "IFX20",
            epoch: 0,
            targetSize: 20,
            concentrationCapBps: 2500,
            methodologyHash: HASH_PREVIEW,
            constituents: [{ symbol: "BTC", weightBps: 2500 }],
          },
        },
      },
      ["index", "composition"],
    ),

    "GET /v1/index/history": route(
      "/v1/index/history",
      prices.history,
      "Every published IFX20 epoch number with the current head and rebalance cadence, for walking the index history",
      {
        output: {
          example: { index: "IFX20", head: 2, cadenceDays: 7, epochs: [0, 1, 2] },
        },
      },
      ["index", "history"],
    ),

    "GET /v1/index/history/:epoch": route(
      "/v1/index/history/:epoch",
      prices.history,
      "One historical IFX20 epoch by number, exactly as it was published, with its attestation digest",
      {
        pathParams: { epoch: "0" },
        pathParamsSchema: str({ epoch: "" }, ["epoch"]),
        output: {
          example: {
            index: "IFX20",
            epoch: 0,
            publishedAt: "2026-09-03T08:00:00.000Z",
            level: "1002.4471903",
            constituents: [{ symbol: "BTC", weightBps: 2500 }],
          },
        },
      },
      ["index", "history"],
    ),

    "GET /v1/assets/quote": route(
      "/v1/assets/quote",
      prices.quote,
      "Median-reconciled USD price for one or more crypto assets, with the venues that agreed and the outliers that were discarded",
      {
        input: { symbols: "BTC,ETH,ALGO" },
        inputSchema: str({ symbols: "" }, ["symbols"]),
        output: {
          example: {
            asOf: "2026-09-03T08:14:02.118Z",
            quotes: [
              { symbol: "BTC", price: 111842.5, sources: ["bitstamp", "bitfinex", "coingecko"], discarded: [] },
            ],
          },
        },
      },
      ["prices", "quote"],
    ),

    "GET /v1/assets/market": route(
      "/v1/assets/market",
      prices.market,
      "Ranked crypto market table: price, market cap, 24h volume, turnover, and index membership for the screening universe",
      {
        input: { limit: "25" },
        inputSchema: str({ limit: "" }),
        output: {
          example: {
            asOf: "2026-09-03T08:14:02.118Z",
            count: 25,
            universeSize: 150,
            assets: [
              {
                rank: 1,
                symbol: "BTC",
                name: "Bitcoin",
                price: 111842.5,
                marketCapUsd: 2231000000000,
                volume24hUsd: 41200000000,
                turnoverBps: 185,
                inIndex: true,
              },
            ],
          },
        },
      },
      ["prices", "market"],
    ),

    "GET /v1/asset/:symbol": route(
      "/v1/asset/:symbol",
      prices.asset,
      "Full profile for one crypto asset: reconciled price, fundamentals, index membership, and the exclusion reason if it failed screening",
      {
        pathParams: { symbol: "ALGO" },
        pathParamsSchema: str({ symbol: "" }, ["symbol"]),
        output: {
          example: {
            symbol: "ALGO",
            name: "Algorand",
            asOf: "2026-09-03T08:14:02.118Z",
            price: 0.2417,
            priceSources: ["bitstamp", "bitfinex", "coingecko", "coinpaprika"],
            reconciled: true,
            marketCapUsd: 2310000000,
            volume24hUsd: 81500000,
            turnoverBps: 353,
            listingAgeDays: 2583,
            inIndex: false,
            eligibility: { eligible: false, reason: "below_target_size" },
          },
        },
      },
      ["prices", "asset"],
    ),
  };

  return routes;
}

/**
 * Fail startup on an invalid discovery declaration.
 *
 * The library ships `validateBazaarRouteExtensions`, but it returns void and only
 * *logs* — and a log line is the wrong severity here. An endpoint whose extension
 * is malformed still takes payment and still serves data; it simply never enters
 * the catalog, which is indistinguishable from a healthy endpoint until the
 * leaderboard shows nothing weeks later. So the same check is done here against a
 * value that can be thrown on.
 *
 * The method is injected from the route pattern before validating, because
 * `declareDiscoveryExtension` deliberately leaves `info.input.method` unset — the
 * resource server extension fills it in from the route at request time, so a
 * declaration is *expected* to look incomplete on its own.
 */
export function assertRoutesDiscoverable(routes) {
  const failures = [];

  for (const [pattern, cfg] of Object.entries(routes)) {
    const declared = cfg.extensions?.bazaar;
    if (!declared) continue;

    const [verb] = pattern.includes(" ") ? pattern.split(/\s+/) : ["GET"];
    const candidate = {
      ...declared,
      info: { ...declared.info, input: { ...declared.info.input, method: verb.toUpperCase() } },
    };

    const result = validateDiscoveryExtension(candidate);
    if (result?.valid === false) failures.push(`${pattern}: ${(result.errors ?? []).join("; ")}`);
  }

  if (failures.length) {
    throw new Error(
      `bazaar discovery declarations are invalid — these routes would take payment but never list:\n  ${failures.join("\n  ")}`,
    );
  }
  return true;
}

/** Free service description, so a caller can price the API before paying for it. */
export function describeService(config) {
  return Object.entries(buildRoutes(config)).map(([pattern, cfg]) => ({
    route: pattern,
    price: cfg.accepts.price,
    description: cfg.description,
  }));
}
