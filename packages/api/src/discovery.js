/**
 * Free routes: service description, health, and the files Bazaar crawls.
 *
 * Everything here is deliberately unpaid. A caller cannot decide to pay for a
 * route until it knows the price, the network, and the asset, so putting the
 * service description behind a paywall makes the API undiscoverable — and none of
 * it leaks index or price data. `/health` reports a level only as `null` or an
 * age, never a value.
 *
 * The discovery files exist because the Bazaar enrichment engine crawls each
 * merchant domain at most daily and reads OpenGraph metadata, `llms.txt`, and
 * agent well-knowns. A tagged endpoint with a bare domain still lists, but lists
 * as a URL with no context; these files are what turn it into a catalog entry an
 * agent can act on without a human in the loop.
 */
import { METHODOLOGY, methodologyHash } from "@indexfeed-algorand/engine";
import { describeService } from "./routes.js";

export function registerFreeRoutes(app, { config, market, index, epochs }) {
  const service = () => ({
    service: "IndexFeed",
    edition: "Algorand",
    description:
      "Pay-per-request crypto market and index data for AI agents. Every route is metered in USDC over x402 on Algorand — no key, no account, no subscription.",
    payment: {
      protocol: "x402",
      version: 2,
      scheme: "exact",
      network: config.caip2,
      asset: { type: "ASA", id: config.usdcAsa, symbol: "USDC", decimals: 6 },
      payTo: config.payTo,
      facilitator: config.facilitatorUrl,
      tag: config.challengeTag,
    },
    index: {
      name: "IFX20",
      methodologyVersion: METHODOLOGY.version,
      methodologyHash: methodologyHash(),
      targetSize: METHODOLOGY.targetSize,
      cadenceDays: METHODOLOGY.cadenceDays,
      concentrationCapBps: METHODOLOGY.concentrationCapBps,
    },
    routes: describeService(config),
  });

  app.get("/", (_req, res) => res.json(service()));

  /**
   * Liveness plus data freshness, split apart on purpose.
   *
   * `status` describes the process and stays truthful when every upstream is
   * down; `data` describes whether what the process would sell is actually fit to
   * sell. A single boolean would conflate "the server is up" with "the prices are
   * current", and the second is the one that determines whether a paid response
   * is worth what the caller spent.
   */
  app.get("/health", async (_req, res) => {
    const status = market.status();
    const ageSeconds = status.priceAgeSeconds;
    const fresh = ageSeconds !== null && ageSeconds <= config.priceMaxStaleSeconds;
    res.status(fresh ? 200 : 503).json({
      status: "ok",
      uptimeSeconds: Math.floor(process.uptime()),
      data: {
        fresh,
        priceAgeSeconds: ageSeconds === null ? null : Math.round(ageSeconds),
        maxStaleSeconds: config.priceMaxStaleSeconds,
        pricedSymbols: status.pricedSymbols,
        universeSize: status.universeSize,
        head: await epochs.head(),
        lastError: status.lastError,
      },
    });
  });

  /**
   * Machine-readable service descriptor at a conventional location, so an agent
   * that has the origin but not the catalog entry can still find the routes.
   */
  app.get("/.well-known/x402", (_req, res) => res.json(service()));

  // llms.txt, per the llmstxt.org convention the enrichment engine probes for.
  app.get("/llms.txt", (_req, res) => {
    res.type("text/plain").send(llmsTxt(config));
  });

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nAllow: /\n");
  });
}

function llmsTxt(config) {
  const rows = describeService(config)
    .map(({ route, price, description }) => `- \`${route}\` — ${price} — ${description}`)
    .join("\n");

  return `# IndexFeed — Algorand edition

> Pay-per-request crypto market and index data for AI agents, metered in USDC over
> x402 on Algorand. There is no API key and no account: call a route, receive HTTP
> 402 with payment requirements, pay, and the data is returned on the retry.

## Payment

- Protocol: x402 v2, scheme \`exact\`
- Network: \`${config.caip2}\` (Algorand ${config.network})
- Asset: USDC, ASA \`${config.usdcAsa}\`, 6 decimals
- Facilitator: ${config.facilitatorUrl}
- Pay to: \`${config.payTo}\`

## Routes

${rows}

## What makes the index checkable

IFX20 is rules-based, not curated. Constituents are screened on free-float market
cap, 24h turnover, and listing age, then weighted by market cap under a
${METHODOLOGY.concentrationCapBps / 100}% single-name cap, and rebalanced every
${METHODOLOGY.cadenceDays} days. The rulebook hashes to
\`${methodologyHash()}\` (methodology v${METHODOLOGY.version}); every published
epoch carries that hash plus its own signed digest, so a consumer can tell whether
two epochs were computed under the same rules and whether the record it holds is
the one that was signed.

Prices are reconciled across four independent feeds — two exchanges and two
aggregators — by median, discarding any source more than
${METHODOLOGY.pricing.maxDeviationBps / 100}% from it. An asset with fewer than
${METHODOLOGY.pricing.minSources} agreeing sources is not priced rather than priced badly.
`;
}
