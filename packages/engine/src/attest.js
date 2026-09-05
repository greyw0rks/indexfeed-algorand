/**
 * Attestation over a published epoch.
 *
 * The Stellar edition of IndexFeed gets its verifiability from a contract: the
 * level, weights, and methodology hash are written on-chain, so a reader can
 * check them without trusting the server. There is no contract on this rail, so
 * that guarantee has to be reconstructed off-chain, and the honest version of it
 * is narrower than "on-chain" — it proves *who* produced a record and that the
 * record has not changed since, not that it was produced at a particular time.
 *
 * Two independent digests are published with every epoch:
 *
 *   methodologyHash — over the rulebook (see methodology.js). Tells a consumer
 *     whether two epochs were computed under the same rules.
 *   epochDigest     — over the epoch payload itself. Tells a consumer whether
 *     the record they hold is byte-identical to the one that was signed.
 *
 * The signature is Ed25519 over `epochDigest`, from a key that exists only to
 * attest. It is deliberately *not* the payTo account key: that key receives
 * USDC, and a signing key has to be loaded into the API process, so keeping them
 * separate means a compromised API server cannot move funds.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/**
 * Stable stringify. Key order must not affect the digest, or reordering a field
 * in a response builder would invalidate every previously published epoch.
 *
 * Mirrors `canonicalize` in methodology.js rather than importing it, because the
 * two digests must stay independent: a change to how the rulebook is hashed
 * should not silently reinterpret every epoch digest as well.
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** 32-byte digest over an epoch payload, hex encoded. */
export function epochDigest(payload) {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

/** Generate an attestation keypair, PEM encoded. For `npm run attest:new`. */
export function generateAttestationKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * Build a signer from a PEM private key.
 *
 * Returns null when no key is configured, and callers serve epochs unsigned
 * rather than failing. An unsigned epoch is still digest-checkable, so a missing
 * key degrades the guarantee instead of taking the API down — but the digest
 * alone proves only integrity, not origin, so `/` reports `signed: false` so a
 * consumer is never misled about which of the two they are getting.
 */
export function createAttestor(privateKeyPem) {
  if (!privateKeyPem) return null;
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();

  return {
    publicKeyPem,
    /** Base64url Ed25519 signature over the hex digest string. */
    sign(digest) {
      return sign(null, Buffer.from(digest, "utf8"), privateKey).toString("base64url");
    },
  };
}

/** Verify a signature produced by `createAttestor().sign`. */
export function verifyAttestation({ digest, signature, publicKeyPem }) {
  try {
    return verify(null, Buffer.from(digest, "utf8"), createPublicKey(publicKeyPem), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/**
 * Attach `digest` and, when a key is configured, `signature` to a payload.
 *
 * The digest covers the payload *without* the attestation block, so a verifier
 * reproduces it by deleting `attestation` and re-canonicalizing — no field
 * ordering knowledge required.
 */
export function attest(payload, attestor) {
  const digest = epochDigest(payload);
  const attestation = { alg: "sha256", digest };
  if (attestor) {
    attestation.alg = "ed25519-sha256";
    attestation.signature = attestor.sign(digest);
  }
  return { ...payload, attestation };
}
