/**
 * The rebalance pipeline: fundamentals + prices -> screen -> weight -> level.
 *
 * `runRebalance` is pure with respect to the chain — it computes an update and
 * returns it along with an audit record. Publishing is a separate step so a dry
 * run is exactly the same computation minus the transaction.
 *
 * Fundamentals and prices are fetched from different providers and serve
 * different roles: fundamentals decide what the index *contains*, prices decide
 * what it is *worth*. Fundamentals carry a price too, but it is not used for the
 * level — provider prices are single-source, and the level goes on-chain.
 */
import { METHODOLOGY, methodologyHash } from "./methodology.js";
import { collectQuotes } from "./sources.js";
import { collectFundamentals } from "./fundamentals.js";
import { createSymbolResolver } from "./symbols.js";
import { reconcileAll } from "./prices.js";
import { screen, weight, toBasisPoints } from "./weighting.js";
import {
  inceptionDivisor,
  rebalanceDivisor,
  previousBasketLevel,
  level,
  toScaledValue,
  unitsForWeights,
  fromScaledValue,
} from "./index-math.js";

/** Notional used to express the basket in units. Cancels out of the level. */
const BASKET_NOTIONAL_USD = 1_000_000;

/**
 * Compute the next epoch.
 *
 * @param {object} params
 * @param {Array|Function} params.sources price source adapters, or a function
 *   receiving the symbol resolver and returning adapters (aggregator adapters
 *   need the resolver, which only exists after fundamentals are fetched)
 * @param {Array} [params.fundamentalsProviders] fundamentals providers; when
 *   omitted, `universe` must be supplied directly
 * @param {Array} [params.universe] pre-fetched candidate universe, for tests
 * @param {object|null} params.previousState `{epoch, basket, divisor}` from the
 *   last epoch, or null at inception
 * @returns {Promise<{update: object, state: object, audit: object}>}
 */
export async function runRebalance({
  sources,
  fundamentalsProviders,
  universe: providedUniverse,
  previousState = null,
  methodology = METHODOLOGY,
}) {
  let universe = providedUniverse;
  let providerErrors = [];
  if (!universe) {
    if (!fundamentalsProviders?.length) {
      throw new Error("runRebalance needs either a universe or fundamentalsProviders");
    }
    ({ universe, providerErrors } = await collectFundamentals(fundamentalsProviders));
    if (universe.length === 0) {
      throw new Error("no fundamentals available; refusing to publish");
    }
  }

  // Screen before pricing. Screening reads provider data already in hand, so
  // doing it first avoids fetching exchange quotes for names that cannot enter.
  const { eligible: screened, excluded } = screen(universe, methodology);
  if (screened.length === 0) {
    throw new Error("no eligible constituents after screening; refusing to publish");
  }

  const symbols = screened.map((a) => a.symbol);
  const resolver = createSymbolResolver(universe);
  const priceSources = typeof sources === "function" ? sources(resolver) : sources;

  // Price the incoming constituents *and* the outgoing basket. Continuity is
  // computed from the old basket at current prices, so a departing name still
  // needs a price this epoch — fetching only the new set would make every
  // rebalance that drops a constituent unvaluable.
  const previousSymbols = previousState?.basket.map((c) => c.symbol) ?? [];
  const toPrice = [...new Set([...symbols, ...previousSymbols])];

  const { quotesBySymbol, sourceErrors } = await collectQuotes(priceSources, toPrice);
  const { prices, rejected } = reconcileAll(quotesBySymbol, methodology);

  // An asset without a consensus price cannot be weighted. It passed screening,
  // so this is a pricing failure rather than an eligibility one, and it is
  // reported separately.
  const eligible = screened.filter((a) => prices.has(a.symbol));
  if (eligible.length === 0) {
    throw new Error("no eligible constituent could be priced; refusing to publish");
  }

  const weights = weight(eligible, methodology);
  const basket = unitsForWeights(weights, prices, BASKET_NOTIONAL_USD);

  // Continuity: the level just before the composition change is the level of
  // the *old* basket at *current* prices. At inception there is no old basket,
  // so the divisor is solved to hit the base level instead.
  let divisor;
  let previousLevel = null;
  let staleSymbols = [];
  if (previousState) {
    ({ level: previousLevel, staleSymbols } = previousBasketLevel(
      previousState.basket,
      prices,
      previousState.divisor,
    ));
    divisor = rebalanceDivisor(basket, prices, previousLevel);
  } else {
    divisor = inceptionDivisor(basket, prices, methodology);
  }

  const levelFloat = level(basket, prices, divisor);
  const epoch = previousState ? previousState.epoch + 1 : 0;
  const hash = methodologyHash(methodology);

  const update = {
    epoch,
    value: toScaledValue(levelFloat).toString(),
    constituents: toBasisPoints(weights),
    methodologyHash: hash,
  };

  return {
    update,
    state: { epoch, basket, divisor, methodologyHash: hash },
    audit: {
      computedAt: new Date().toISOString(),
      methodologyVersion: methodology.version,
      methodologyHash: hash,
      levelDisplay: fromScaledValue(update.value),
      previousLevel,
      /**
       * Constituents of the previous basket carried at their last recorded price
       * because no venue could price them this epoch. A name appearing here
       * repeatedly means it left the tradeable universe.
       */
      staleCarriedForward: staleSymbols,
      universeSize: universe.length,
      fundamentals: Object.fromEntries(
        eligible.map((a) => [
          a.symbol,
          {
            marketCapUsd: a.marketCapUsd,
            volume24hUsd: a.volume24hUsd,
            listingAgeDays: a.listingAgeDays,
            sources: a.sources,
          },
        ]),
      ),
      prices: Object.fromEntries(
        [...prices].map(([symbol, p]) => [symbol, { price: p.price, sources: p.sources }]),
      ),
      priceRejections: rejected,
      sourceErrors,
      providerErrors,
      excluded,
    },
  };
}
