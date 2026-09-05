/**
 * Index reads: published epochs, and the live level between them.
 *
 * The distinction matters for what a caller is buying. An *epoch* is a committed
 * record — fixed weights, a methodology hash, a signed digest — and it only
 * changes on the rebalance cadence. A *tick* is that same basket marked to
 * current prices, so it moves continuously, exactly as a real index does between
 * reconstitutions. Weights drift with price between epochs because the basket is
 * held in units, not re-pinned to target weights on every read.
 *
 * The tick is valued with `previousBasketLevel` rather than `level`, even though
 * the basket is current. `level` throws when any constituent has no consensus
 * price, which would make the route designed for continuous polling the most
 * fragile one in the API; `previousBasketLevel` carries an unpriceable name at the
 * price it was last valued at and reports it in `stale`. The caller can see the
 * degradation instead of getting a 503 because one venue dropped one ticker.
 */
import { METHODOLOGY, attest, fromScaledValue, previousBasketLevel } from "@indexfeed-algorand/engine";

export class IndexUnavailableError extends Error {}
export class EpochNotFoundError extends Error {}

export function createIndexService({ epochs, state, market, attestor = null, indexName = "IFX20" }) {
  /** Continuity state (basket units + divisor) for the head epoch. */
  async function requireState() {
    const current = await state.load();
    if (!current?.basket?.length || !(current.divisor > 0)) {
      throw new IndexUnavailableError("no index epoch has been published yet");
    }
    return current;
  }

  return {
    /**
     * Live level. Cheap, changes every refresh — the route meant to be polled.
     *
     * Returns the drifted weights alongside the level so a caller polling this
     * route never needs the dearer `/latest` just to know what it is tracking.
     */
    async tick() {
      const current = await requireState();
      const prices = market.allPrices();
      const { level, staleSymbols } = previousBasketLevel(current.basket, prices, current.divisor);

      const valued = current.basket.map((c) => {
        const price = prices.get(c.symbol)?.price ?? c.lastPrice;
        return { symbol: c.symbol, price, value: price * c.units, stale: !prices.has(c.symbol) };
      });
      const total = valued.reduce((sum, v) => sum + v.value, 0);

      return {
        index: indexName,
        epoch: current.epoch,
        level: round(level, 7),
        asOf: new Date().toISOString(),
        priceAgeSeconds: round(market.priceAgeSeconds() ?? 0, 1),
        methodologyHash: current.methodologyHash,
        constituents: valued.map((v) => ({
          symbol: v.symbol,
          price: v.price,
          // Live weight, not the target weight the epoch was struck at.
          weightBps: Math.round((v.value / total) * 10_000),
          ...(v.stale ? { stale: true } : {}),
        })),
        stale: staleSymbols,
      };
    },

    /** The head epoch as published: fixed weights, digest, signature. */
    async latest() {
      const record = await epochs.latest();
      if (!record) throw new IndexUnavailableError("no index epoch has been published yet");
      return record;
    },

    /** Composition only — the cheapest way to ask "what is in the index". */
    async constituents() {
      const record = await this.latest();
      return {
        index: record.index,
        epoch: record.epoch,
        publishedAt: record.publishedAt,
        methodologyHash: record.methodologyHash,
        targetSize: METHODOLOGY.targetSize,
        concentrationCapBps: METHODOLOGY.concentrationCapBps,
        constituents: record.constituents,
        attestation: record.attestation,
      };
    },

    /** One historical epoch, or the whole list when no epoch is given. */
    async history(epoch) {
      if (epoch === undefined) {
        const published = await epochs.list();
        const head = await epochs.head();
        return attest(
          {
            index: indexName,
            head,
            cadenceDays: METHODOLOGY.cadenceDays,
            epochs: published,
          },
          attestor,
        );
      }
      const record = await epochs.at(epoch);
      if (!record) throw new EpochNotFoundError(`epoch ${epoch} has not been published`);
      return record;
    },
  };
}

/** Round for transport. Full precision stays in the scaled epoch value. */
function round(value, dp) {
  return Number(value.toFixed(dp));
}

/** Format a scaled epoch value for display alongside the raw string. */
export { fromScaledValue };
