/**
 * Paid route handlers, and the freshness gate that runs before payment.
 *
 * The gate is the important part. x402 settles the payment inside the middleware,
 * *before* the handler is invoked — so by the time a handler discovers it has
 * nothing fit to sell, the caller's USDC is already gone and the best the API can
 * do is return 503 to someone who has paid for it. That is precisely the failure
 * worth engineering out: the first independent payer of a previous service lost
 * real money to a check that ran too late.
 *
 * So `freshnessGate` is mounted ahead of `paymentMiddleware` and refuses the
 * request while it is still free. A caller polling the tick route through a
 * provider outage gets an unpaid 503 and can back off, instead of buying a
 * sequence of increasingly stale index levels it has no way to identify as stale.
 */
import { METHODOLOGY, TOTAL_WEIGHT_BPS, fromScaledValue, screen } from "@indexfeed-algorand/engine";

/** Routes that cannot be served from a stale price snapshot. */
const NEEDS_FRESH_PRICES = [/^\/v1\/index\/tick/, /^\/v1\/assets\//, /^\/v1\/asset\//];

/**
 * Reject stale-data requests before the payment middleware sees them.
 *
 * Epoch reads are deliberately exempt: a published epoch is a committed historical
 * record and is exactly as valid when the live feed is down. Gating them on price
 * freshness would take the archive offline for an unrelated outage.
 */
export function freshnessGate({ market, config }) {
  return (req, res, next) => {
    if (!NEEDS_FRESH_PRICES.some((pattern) => pattern.test(req.path))) return next();

    const ageSeconds = market.priceAgeSeconds();
    if (ageSeconds === null) {
      return res.status(503).json({
        error: "no price snapshot yet; the service has not finished warming up",
        retryAfterSeconds: config.priceTtlSeconds,
      });
    }
    if (ageSeconds > config.priceMaxStaleSeconds) {
      // Signalled before payment on purpose — see the note at the top of this file.
      res.set("Retry-After", String(config.priceTtlSeconds));
      return res.status(503).json({
        error: "price snapshot is stale; refusing to sell data that is out of date",
        priceAgeSeconds: Math.round(ageSeconds),
        maxStaleSeconds: config.priceMaxStaleSeconds,
        retryAfterSeconds: config.priceTtlSeconds,
      });
    }
    return next();
  };
}

export function registerPaidRoutes(app, { config, market, index }) {
  const wrap = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      next(err);
    }
  };

  app.get("/v1/index/tick", wrap(async (_req, res) => res.json(await index.tick())));
  app.get("/v1/index/latest", wrap(async (_req, res) => res.json(await index.latest())));
  app.get("/v1/index/constituents", wrap(async (_req, res) => res.json(await index.constituents())));

  app.get("/v1/index/history", wrap(async (_req, res) => res.json(await index.history())));
  app.get(
    "/v1/index/history/:epoch",
    wrap(async (req, res) => {
      const epoch = Number(req.params.epoch);
      if (!Number.isInteger(epoch) || epoch < 0) {
        return res.status(400).json({ error: "epoch must be a non-negative integer" });
      }
      res.json(await index.history(epoch));
    }),
  );

  /**
   * Reconciled prices for an explicit symbol list.
   *
   * Unknown and unpriced symbols are reported separately rather than merged:
   * "we have never heard of this ticker" and "no two venues agreed on a price
   * this refresh" call for different actions from the caller.
   */
  app.get(
    "/v1/assets/quote",
    wrap(async (req, res) => {
      const requested = String(req.query.symbols ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);

      if (requested.length === 0) {
        return res.status(400).json({ error: "symbols is required, e.g. ?symbols=BTC,ETH,ALGO" });
      }
      if (requested.length > 50) {
        return res.status(400).json({ error: "at most 50 symbols per request" });
      }

      const quotes = [];
      const unpriced = [];
      const unknown = [];
      for (const symbol of requested) {
        const quote = market.priceFor(symbol);
        if (quote) {
          quotes.push({
            symbol,
            price: quote.price,
            sources: quote.sources,
            discarded: quote.discarded ?? [],
          });
        } else if (market.assetFor(symbol)) {
          unpriced.push(symbol);
        } else {
          unknown.push(symbol);
        }
      }

      res.json({
        asOf: new Date().toISOString(),
        priceAgeSeconds: round(market.priceAgeSeconds(), 1),
        quotes,
        ...(unpriced.length ? { unpriced } : {}),
        ...(unknown.length ? { unknown } : {}),
      });
    }),
  );

  /** Ranked market table over the screening universe. */
  app.get(
    "/v1/assets/market",
    wrap(async (_req, res) => {
      const limit = clamp(Number(_req.query.limit ?? 25), 1, 250);
      const inIndex = await indexMembership(index);
      const assets = market
        .allAssets()
        .slice(0, limit)
        .map((asset, i) => ({ rank: i + 1, ...describeAsset(asset, market, inIndex) }));

      res.json({
        asOf: new Date().toISOString(),
        priceAgeSeconds: round(market.priceAgeSeconds(), 1),
        count: assets.length,
        universeSize: market.allAssets().length,
        assets,
      });
    }),
  );

  /** One asset in full, including why it is or is not in the index. */
  app.get(
    "/v1/asset/:symbol",
    wrap(async (req, res) => {
      const symbol = String(req.params.symbol).toUpperCase();
      const asset = market.assetFor(symbol);
      if (!asset) {
        return res.status(404).json({ error: `${symbol} is not in the screening universe` });
      }

      const inIndex = await indexMembership(index);
      // Screen the whole universe rather than this asset alone: `below_target_size`
      // is a statement about rank, so it only exists relative to the other
      // candidates and cannot be decided from one row.
      const { excluded } = screen(market.allAssets(), METHODOLOGY);
      const exclusion = excluded.find((e) => e.symbol === symbol);

      res.json({
        ...describeAsset(asset, market, inIndex),
        asOf: new Date().toISOString(),
        priceAgeSeconds: round(market.priceAgeSeconds(), 1),
        eligibility: exclusion
          ? { eligible: false, reason: exclusion.reason, ...(exclusion.detail ? { detail: exclusion.detail } : {}) }
          : { eligible: true },
        methodologyVersion: METHODOLOGY.version,
      });
    }),
  );
}

/** Symbols in the head epoch, or an empty set before the first publish. */
async function indexMembership(index) {
  try {
    const { constituents } = await index.constituents();
    return new Set(constituents.map((c) => c.symbol));
  } catch {
    return new Set();
  }
}

function describeAsset(asset, market, inIndex) {
  const quote = market.priceFor(asset.symbol);
  const turnoverBps =
    asset.marketCapUsd > 0 ? round((asset.volume24hUsd / asset.marketCapUsd) * TOTAL_WEIGHT_BPS, 1) : null;

  return {
    symbol: asset.symbol,
    name: asset.name ?? null,
    // Reconciled price when several venues agreed; otherwise the provider's own
    // price, flagged, because a single-source price is a different product from a
    // reconciled one and the caller has to be able to tell them apart.
    price: quote?.price ?? asset.priceUsd ?? null,
    priceSources: quote?.sources ?? null,
    reconciled: Boolean(quote),
    marketCapUsd: asset.marketCapUsd ?? null,
    volume24hUsd: asset.volume24hUsd ?? null,
    turnoverBps,
    listingAgeDays: asset.listingAgeDays ?? null,
    change24hPct: asset.change24hPct ?? null,
    change7dPct: asset.change7dPct ?? null,
    providers: asset.sources ?? [],
    inIndex: inIndex.has(asset.symbol),
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function round(value, dp) {
  return value === null || value === undefined ? null : Number(value.toFixed(dp));
}

export { fromScaledValue };
