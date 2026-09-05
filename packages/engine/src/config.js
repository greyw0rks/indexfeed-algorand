/**
 * Configuration, loaded from the environment.
 *
 * This is the *engine's* config and covers only what the index computation needs:
 * where state lives, how big a universe to screen, and whether to run offline.
 * Payment, network, and pricing config belong to the API and live there — the
 * engine must stay unaware of Algorand and x402.
 */
import { loadEnv, resolveStateDir } from "./env.js";
import {
  bitfinexSource,
  bitstampSource,
  coingeckoSource,
  coinpaprikaSource,
  fixtureSource,
} from "./sources.js";
import {
  coingeckoFundamentals,
  coinpaprikaFundamentals,
  fixtureFundamentals,
} from "./fundamentals.js";
import { METHODOLOGY } from "./methodology.js";
import { FIXTURE_UNIVERSE } from "./fixtures.js";

loadEnv();

export function loadConfig(env = process.env) {
  /**
   * Offline mode swaps live providers and venues for fixtures; never enable in
   * production. It exists so the pipeline is runnable and testable without
   * network access.
   */
  const useFixtures = env.USE_FIXTURE_PRICES === "1";
  const stateDir = resolveStateDir(env.STATE_DIR);

  return {
    /**
     * Fixture runs get their own state directory. Sharing one would let a
     * fixture-computed divisor become the continuity basis for a real epoch,
     * which would corrupt the published index — and conversely a fixture run
     * would fail trying to price real constituents it has no data for.
     */
    stateDir: useFixtures ? `${stateDir}/fixtures` : stateDir,
    useFixtures,
    universeSize: Number(env.UNIVERSE_SIZE ?? METHODOLOGY.fundamentals.universeSize),
    /** PEM Ed25519 key used to sign published epochs. Optional; see attest.js. */
    attestPrivateKey: decodePem(env.ATTEST_PRIVATE_KEY),
  };
}

/**
 * Accept an attestation key either as raw PEM or base64-wrapped PEM.
 *
 * Railway and most CI secret stores mangle multi-line values, so a PEM pasted
 * directly arrives with its newlines flattened and `createPrivateKey` rejects it
 * with an opaque error. Base64 is the escape hatch; `\n` escapes are also
 * unwrapped because that is what a JSON-encoded secret produces.
 */
function decodePem(value) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) return trimmed.replace(/\\n/g, "\n");
  return Buffer.from(trimmed, "base64").toString("utf8");
}

/**
 * Fundamentals providers — these determine what the index *contains*.
 *
 * CoinGecko is capped at 100 per page by the free tier, so a larger universe
 * costs extra requests; CoinPaprika returns ~2000 in one call and is trimmed
 * client-side.
 */
export function buildFundamentalsProviders(config) {
  if (config.useFixtures) {
    return [fixtureFundamentals("fixture-provider", FIXTURE_UNIVERSE)];
  }
  return [
    coingeckoFundamentals({ pages: Math.ceil(config.universeSize / 100), perPage: 100 }),
    coinpaprikaFundamentals({ limit: config.universeSize }),
  ];
}

/**
 * Price sources — these determine what the index is *worth*.
 *
 * Returned as a function of the symbol resolver rather than a plain array: the
 * aggregator adapters need each provider's opaque slug for an asset, which is
 * only known after fundamentals have been fetched.
 */
export function buildSources(config) {
  if (config.useFixtures) {
    // Three fixtures with a small spread, so reconciliation is exercised
    // rather than bypassed.
    const prices = Object.fromEntries(FIXTURE_UNIVERSE.map((a) => [a.symbol, a.priceUsd]));
    const skew = (f) => Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, v * f]));
    return () => [
      fixtureSource("fixture-a", prices),
      fixtureSource("fixture-b", skew(1.001)),
      fixtureSource("fixture-c", skew(0.999)),
    ];
  }

  // Two independent exchanges plus two aggregators. The exchanges are what make
  // reconciliation meaningful; the aggregators are composites and would agree
  // with each other even when both are stale.
  return (resolver) => [
    bitstampSource(),
    bitfinexSource(),
    coingeckoSource(resolver),
    coinpaprikaSource(resolver),
  ];
}
