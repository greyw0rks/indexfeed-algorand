/**
 * Paying x402 client for IndexFeed.
 *
 * `wrapFetchWithPayment` turns the 402 handshake into a single call: the first
 * request goes out unpaid, the client reads the payment requirements off the
 * response, signs an Algorand USDC transfer, and retries with the payment
 * attached. The caller sees one `fetch` and one body.
 *
 * The signing key encoding is the part worth documenting. `@x402/avm` expects
 * base64 of the 64-byte Ed25519 secret — a 32-byte seed concatenated with the
 * 32-byte public key — which is exactly what algosdk's `mnemonicToSecretKey`
 * already returns as `.sk`. The published walkthrough derives the same bytes via
 * `algokit-utils`' `seedFromMnemonic` and `ed25519SigningKeyFromWrappedSecret`,
 * pinned to an alpha release; going through algosdk gets there in one call with no
 * alpha dependency. `assertSigningKey` checks the derived address round-trips, so
 * if that equivalence ever stops holding it fails here rather than producing
 * signatures the facilitator rejects for reasons that look like anything else.
 */
import algosdk from "algosdk";
import { x402Client, x402HTTPClient, wrapFetchWithPayment } from "@x402/fetch";
import {
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_GENESIS_HASH,
  ExactAvmScheme,
  toClientAvmSigner,
} from "@x402/avm";

/**
 * CAIP-2 ids built from the genesis hash, matching the spelling the facilitator
 * advertises and the API quotes.
 *
 * Not the exported `ALGORAND_*_CAIP2` constants: those are truncated to 32
 * characters and do not match what arrives in the payment requirements, so a
 * client registered against them has no scheme for the network it is asked to pay
 * on. See the note in packages/api/src/config.js for the full story.
 */
export const CAIP2 = {
  mainnet: `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`,
  testnet: `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`,
};

/**
 * Build a paying fetch from a 25-word mnemonic.
 *
 * @param {object} params
 * @param {string} params.mnemonic 25-word Algorand mnemonic for the *payer*
 * @param {"mainnet"|"testnet"} [params.network]
 * @returns {{fetch: Function, address: string, network: string, caip2: string,
 *   settlementOf: (res: Response) => object|null}}
 */
export function createPayingClient({ mnemonic, network = "testnet" }) {
  const caip2 = CAIP2[network];
  if (!caip2) throw new Error(`unknown network ${network}; expected mainnet or testnet`);
  if (!mnemonic) throw new Error("a payer mnemonic is required");

  const account = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const secretKey = Buffer.from(account.sk).toString("base64");
  const signer = toClientAvmSigner(secretKey);
  assertSigningKey(signer, account.addr.toString());

  const client = new x402Client();
  client.register(caip2, new ExactAvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  return {
    address: signer.address,
    network,
    caip2,
    fetch: wrapFetchWithPayment(fetch, client),
    /**
     * Settlement receipt from the response headers, or null when the response
     * was served without a payment. `transaction` is the on-chain txid — the
     * proof a real MainNet payment happened, which is what the challenge
     * ultimately counts.
     */
    settlementOf(res) {
      try {
        return httpClient.getPaymentSettleResponse((name) => res.headers.get(name)) ?? null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The signer's address must match the mnemonic's own.
 *
 * A mismatch means the seed/pubkey concatenation was wrong, which would otherwise
 * surface as a signature the facilitator cannot attribute — an error that reads
 * like a funding or opt-in problem and costs an afternoon to trace.
 */
function assertSigningKey(signer, expectedAddress) {
  if (signer.address !== expectedAddress) {
    throw new Error(
      `signing key derivation mismatch: signer resolved to ${signer.address} but the mnemonic is ${expectedAddress}`,
    );
  }
}

/** Read a paid route and return `{status, body, settlement}`. */
export async function paidGet(client, url) {
  const res = await client.fetch(url, { method: "GET" });
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  return { status: res.status, ok: res.ok, body, settlement: client.settlementOf(res) };
}

/** Probe a route without paying, to read its price off the 402. */
export async function quote(url) {
  const res = await fetch(url, { method: "GET" });
  return {
    status: res.status,
    paymentRequired: res.headers.get("payment-required"),
    body: res.status === 402 ? null : await res.json().catch(() => null),
  };
}
