/**
 * API configuration.
 *
 * The API holds no payout key — `payTo` is a public address and the process never
 * signs an Algorand transaction. Its only secret is the attestation key, which
 * signs epoch digests and cannot move funds (see engine/attest.js for why those
 * are deliberately different keys).
 */
import { loadEnv } from "@indexfeed-algorand/engine/env";
import {
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  isValidAlgorandAddress,
} from "@x402/avm";

loadEnv(process.cwd());

/**
 * Network config keyed by the friendly name used in env.
 *
 * The CAIP-2 string is built from the genesis-hash constant rather than using the
 * exported `ALGORAND_*_CAIP2` constants, and that is not a stylistic choice — it is
 * a compatibility fix found by running against the live service.
 *
 * `@x402/avm` 2.24 exports `ALGORAND_MAINNET_CAIP2` truncated to 32 characters per
 * the CAIP-2 reference limit (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k`), while
 * the GoPlausible facilitator advertises the full base64 genesis hash in
 * `/supported` (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`). The
 * package ships `normalizeAlgorandNetwork` to bridge the two, but
 * `x402ResourceServer` does **not** apply it when matching a route's network
 * against the facilitator's supported kinds — so quoting the exported constant
 * makes every paid route fail with `missing_facilitator` and a 500, while
 * `/supported`, `/health`, and the middleware's own startup sync all look fine.
 *
 * Both sides have to agree, so the client builds its CAIP-2 the same way. See
 * `assertFacilitatorSupport` for the check that turns a recurrence of this into a
 * boot failure instead of a per-request 500.
 */
export const NETWORKS = {
  mainnet: { caip2: `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`, usdcAsa: USDC_MAINNET_ASA_ID },
  testnet: { caip2: `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`, usdcAsa: USDC_TESTNET_ASA_ID },
};

/** The tag that makes an endpoint countable for the Global x402 Challenge. */
export const CHALLENGE_TAG = "x402-global-challenge";

/**
 * Default price grid, in the units `@x402/core` parses from a "$" string.
 *
 * `tick` is priced an order of magnitude below everything else on purpose. It is
 * the only route designed to be polled continuously, so it has to be cheap enough
 * that a caller running it every few seconds is buying data rather than making a
 * donation — and the challenge ranks on sustained usage, which means the price
 * has to make sustained usage rational for the payer, not just for us.
 */
const DEFAULT_PRICES = {
  tick: "$0.001",
  latest: "$0.01",
  constituents: "$0.01",
  history: "$0.02",
  quote: "$0.005",
  market: "$0.01",
  asset: "$0.005",
};

export function loadApiConfig(env = process.env) {
  const network = env.ALGORAND_NETWORK ?? "testnet";
  const chain = NETWORKS[network];
  if (!chain) {
    throw new Error(`unknown ALGORAND_NETWORK ${network}; expected mainnet or testnet`);
  }

  /**
   * Fixture mode must resolve to the same directory the engine writes to, or the
   * API reads an empty epoch store while the rebalancer happily publishes into
   * `state/fixtures` — an "index not published yet" 503 with a published index
   * sitting on disk. The engine applies this suffix in its own loadConfig; it is
   * repeated rather than imported because the two configs are otherwise separate
   * and a shared helper would couple payment config to index config.
   */
  const useFixtures = env.USE_FIXTURE_PRICES === "1";
  const baseStateDir = env.STATE_DIR ?? "./state";

  const config = {
    port: Number(env.PORT ?? 3002),
    network,
    caip2: chain.caip2,
    usdcAsa: env.USDC_ASA_ID ?? chain.usdcAsa,
    facilitatorUrl: env.X402_FACILITATOR_URL ?? "https://facilitator.goplausible.xyz",
    /** Where USDC lands. Must be opted in to the USDC ASA before it can be paid. */
    payTo: env.X402_PAY_TO,
    challengeTag: env.X402_CHALLENGE_TAG ?? CHALLENGE_TAG,
    /**
     * Public origin, used to build the `resource` URL advertised to the Bazaar.
     * Behind Railway's proxy the request host is only correct once express trusts
     * the proxy, and a resource URL of `http://localhost:3002/...` would list an
     * unreachable endpoint in the catalog — so this is set explicitly in prod.
     */
    publicBaseUrl: env.PUBLIC_BASE_URL?.replace(/\/$/, "") || undefined,
    stateDir: useFixtures ? `${baseStateDir}/fixtures` : baseStateDir,
    useFixtures,
    prices: { ...DEFAULT_PRICES, ...readPriceOverrides(env) },
    /**
     * Seconds a cached market snapshot is served for. Bounds upstream provider
     * load: the tick route is meant to be hammered, and four free price APIs will
     * rate-limit long before Railway breaks a sweat, so the refresh interval —
     * not the request rate — is what has to stay inside the providers' budget.
     */
    priceTtlSeconds: Number(env.PRICE_TTL_SECONDS ?? 20),
    /** Fail a market read rather than serve a snapshot older than this. */
    priceMaxStaleSeconds: Number(env.PRICE_MAX_STALE_SECONDS ?? 180),
  };

  if (!config.payTo) {
    throw new Error("missing required env: X402_PAY_TO (Algorand address that receives USDC)");
  }
  if (!isValidAlgorandAddress(config.payTo)) {
    throw new Error(`X402_PAY_TO is not a valid Algorand address: ${config.payTo}`);
  }

  return config;
}

/** `PRICE_TICK=$0.002` style overrides, so the grid is tunable without a deploy. */
function readPriceOverrides(env) {
  const overrides = {};
  for (const key of Object.keys(DEFAULT_PRICES)) {
    const value = env[`PRICE_${key.toUpperCase()}`];
    if (value) overrides[key] = value;
  }
  return overrides;
}
