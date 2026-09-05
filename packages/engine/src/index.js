/**
 * Public surface of the index engine, re-exported for the API, the rebalancer,
 * and tests.
 *
 * Everything here is chain-free by design. This package computes and attests the
 * index; nothing in it knows about Algorand, x402, or HTTP. The Soroban edition's
 * `publisher.js` is deliberately absent — its replacement is `epochs.js` plus
 * `attest.js`, which reproduce the contract's append-only invariant off-chain.
 */
export {
  METHODOLOGY,
  methodologyHash,
  cadenceGate,
  CADENCE_TOLERANCE,
  VALUE_DECIMALS,
  VALUE_SCALE,
  TOTAL_WEIGHT_BPS,
} from "./methodology.js";
export { reconcile, reconcileAll, RejectReason } from "./prices.js";
export { screen, weight, toBasisPoints } from "./weighting.js";
export {
  inceptionDivisor,
  rebalanceDivisor,
  previousBasketLevel,
  level,
  toScaledValue,
  fromScaledValue,
  unitsForWeights,
} from "./index-math.js";
export { runRebalance } from "./rebalance.js";
export { stateStore } from "./state.js";
export { epochStore } from "./epochs.js";
export {
  attest,
  canonicalize,
  epochDigest,
  createAttestor,
  generateAttestationKey,
  verifyAttestation,
} from "./attest.js";
export {
  collectQuotes,
  fixtureSource,
  coingeckoSource,
  coinpaprikaSource,
  bitstampSource,
  bitfinexSource,
} from "./sources.js";
export {
  collectFundamentals,
  coingeckoFundamentals,
  coinpaprikaFundamentals,
  fixtureFundamentals,
} from "./fundamentals.js";
export {
  classifyExclusion,
  looksLikeStablecoin,
  looksLikeDerivative,
  ExclusionReason,
  STABLE_MAX_CHANGE_PCT,
  STABLE_MAX_CHANGE_30D_PCT,
} from "./classify.js";
export { createSymbolResolver, bitstampPair, bitfinexPair } from "./symbols.js";
export { FIXTURE_UNIVERSE } from "./fixtures.js";
export { loadConfig, buildSources, buildFundamentalsProviders } from "./config.js";
