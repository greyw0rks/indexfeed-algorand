/**
 * IndexFeed x402-metered API — Algorand edition.
 *
 * Payment is the access control. There are no API keys and no accounts: a paid
 * route returns 402 with payment requirements until a valid USDC payment is
 * presented, and `@x402/express` settles it through the GoPlausible facilitator
 * before the handler runs. Free routes are limited to service metadata, health,
 * and the agent-discovery files — none of which carry index or price data.
 *
 * `paymentMiddleware` is used rather than the shorter `paymentMiddlewareFromConfig`
 * because the Bazaar discovery extension has to be registered on the resource
 * server itself, and the `FromConfig` variant builds that server internally with
 * no seam to reach it. Without the extension the endpoint still takes payments
 * perfectly well — it just never appears in the catalog, which is the failure that
 * looks like success.
 */
import express from "express";
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import {
  METHODOLOGY,
  buildFundamentalsProviders,
  buildSources,
  createAttestor,
  epochStore,
  loadConfig,
  methodologyHash,
  stateStore,
} from "@indexfeed-algorand/engine";
import { loadApiConfig } from "./config.js";
import { assertRoutesDiscoverable, buildRoutes, describeService } from "./routes.js";
import { assertFacilitatorSupport } from "./facilitator.js";
import { createMarketData } from "./marketdata.js";
import { EpochNotFoundError, IndexUnavailableError, createIndexService } from "./index-service.js";
import { registerFreeRoutes } from "./discovery.js";
import { freshnessGate, registerPaidRoutes } from "./handlers.js";

export const INDEX_NAME = "IFX20";

export function createApp(config, deps = {}) {
  const engineConfig = loadConfig();
  const state = deps.state ?? stateStore(config.stateDir);
  const epochs = deps.epochs ?? epochStore(config.stateDir);
  const attestor = deps.attestor ?? createAttestor(engineConfig.attestPrivateKey);

  /**
   * Constituent symbols of the head epoch, cached so the price refresh does not
   * read state.json on every tick. Declared before the market cache because the
   * cache closes over it.
   */
  let basketSymbols = [];
  const refreshBasketSymbols = async () => {
    const current = await state.load().catch(() => null);
    basketSymbols = current?.basket?.map((c) => c.symbol) ?? [];
  };

  const market =
    deps.market ??
    createMarketData({
      sources: buildSources(engineConfig),
      fundamentalsProviders: buildFundamentalsProviders(engineConfig),
      priceTtlSeconds: config.priceTtlSeconds,
      // Price whatever is in the basket even if it has fallen out of the top of
      // the universe, or the tick route cannot value the index it publishes.
      extraSymbols: () => basketSymbols,
    });

  const index = deps.index ?? createIndexService({ epochs, state, market, attestor, indexName: INDEX_NAME });

  const app = express();
  app.disable("x-powered-by");
  // Railway terminates TLS upstream; without this the middleware sees http and
  // an internal host, so advertised resource URLs and settlement records would
  // both reference an origin no caller can reach.
  app.set("trust proxy", true);

  const routes = buildRoutes(config);
  assertRoutesDiscoverable(routes);
  registerFreeRoutes(app, { config, market, index, epochs, routes });

  // Ahead of the payment middleware: x402 settles before a handler runs, so any
  // check that can refuse the request has to happen while the request is still
  // free. See handlers.js for why this one matters.
  app.use(freshnessGate({ market, config }));

  const facilitator = deps.facilitatorClient ?? new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const server = new x402ResourceServer(facilitator);
  server.register(config.caip2, new ExactAvmScheme());
  server.registerExtension(bazaarResourceServerExtension);

  /**
   * The middleware fetches the facilitator's /supported before it can build
   * payment requirements — it will not quote a scheme/network the facilitator has
   * not confirmed it settles, so this is not an optional warm-up: with it
   * disabled, every paid route 500s instead of returning 402. Tests inject a stub
   * facilitator rather than turning it off, so the code path under test is the
   * one that runs in production.
   */
  app.use(paymentMiddleware(routes, server));

  registerPaidRoutes(app, { config, market, index });

  // Errors are mapped by cause: a missing epoch is the caller's request being
  // wrong, an unpublished index or a stale snapshot is this service failing to
  // hold up its end. The distinction matters more than usual here, because the
  // caller has already paid by the time a handler runs — so a 5xx has to be
  // unambiguous enough to justify a refund conversation.
  app.use((err, _req, res, _next) => {
    if (err instanceof EpochNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof IndexUnavailableError) return res.status(503).json({ error: err.message });
    console.error("request failed:", String(err?.message ?? err));
    res.status(502).json({ error: "market data read failed" });
  });

  return Object.assign(app, {
    /**
     * Confirm the facilitator, then warm the cache and start the refresh clocks.
     *
     * The facilitator check runs first and is fatal. A process that boots without
     * it looks entirely healthy — the root, health, and llms.txt all serve — and
     * only fails once a caller reaches a paid route, which is the worst possible
     * time to discover a network-string mismatch.
     */
    async warm({ checkFacilitator = true } = {}) {
      if (checkFacilitator) {
        await assertFacilitatorSupport({ facilitatorUrl: config.facilitatorUrl, caip2: config.caip2 });
      }
      await refreshBasketSymbols();
      const status = await market.warm();
      await refreshBasketSymbols();
      market.start();
      return status;
    },
    stop() {
      market.stop();
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadApiConfig();
  const app = createApp(config);

  app.warm()
    .then((status) => {
      app.listen(config.port, () => {
        console.log(`IndexFeed API on :${config.port}`);
        console.log(`  network      ${config.network}  ${config.caip2}`);
        console.log(`  usdc asa     ${config.usdcAsa}`);
        console.log(`  payTo        ${config.payTo}`);
        console.log(`  facilitator  ${config.facilitatorUrl}`);
        console.log(`  tag          ${config.challengeTag}`);
        console.log(`  origin       ${config.publicBaseUrl ?? "(derived from request)"}`);
        console.log(`  methodology  v${METHODOLOGY.version} ${methodologyHash().slice(0, 12)}…`);
        console.log(`  warm         ${status.pricedSymbols} priced, universe ${status.universeSize}`);
        for (const { route, price } of describeService(config)) console.log(`  ${price.padEnd(8)} ${route}`);
      });
    })
    .catch((err) => {
      // A cold start that cannot price anything must not begin selling data.
      console.error("startup failed:", String(err?.message ?? err));
      process.exit(1);
    });
}
