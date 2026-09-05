import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attest,
  canonicalize,
  createAttestor,
  epochDigest,
  generateAttestationKey,
  verifyAttestation,
} from "../src/attest.js";

describe("attestation", () => {
  it("digests independently of key order", () => {
    // If key order mattered, reordering a field in a response builder would
    // invalidate every previously published epoch.
    const a = { epoch: 1, level: "1000.0", constituents: [{ symbol: "BTC", weightBps: 10_000 }] };
    const b = { constituents: [{ symbol: "BTC", weightBps: 10_000 }], level: "1000.0", epoch: 1 };
    assert.equal(epochDigest(a), epochDigest(b));
  });

  it("distinguishes payloads that differ only in array order", () => {
    // Array order is meaningful — a reordered constituent list is a different
    // basket ranking — so it must move the digest.
    const a = { c: [{ symbol: "BTC" }, { symbol: "ETH" }] };
    const b = { c: [{ symbol: "ETH" }, { symbol: "BTC" }] };
    assert.notEqual(epochDigest(a), epochDigest(b));
  });

  it("distinguishes a numeric weight from its string form", () => {
    assert.notEqual(canonicalize({ w: 2500 }), canonicalize({ w: "2500" }));
  });

  it("digests over the payload excluding the attestation block", () => {
    const payload = { epoch: 0, level: "1000.0" };
    const record = attest(payload, null);
    // A verifier reproduces the digest by deleting `attestation` — no field
    // ordering knowledge required.
    const { attestation, ...rest } = record;
    assert.equal(epochDigest(rest), attestation.digest);
    assert.equal(attestation.alg, "sha256");
    assert.equal(attestation.signature, undefined);
  });

  it("signs and verifies with a generated key", () => {
    const { privateKeyPem, publicKeyPem } = generateAttestationKey();
    const attestor = createAttestor(privateKeyPem);
    const record = attest({ epoch: 3, level: "1234.5" }, attestor);

    assert.equal(record.attestation.alg, "ed25519-sha256");
    assert.ok(record.attestation.signature);
    assert.equal(
      verifyAttestation({
        digest: record.attestation.digest,
        signature: record.attestation.signature,
        publicKeyPem,
      }),
      true,
    );
  });

  it("rejects a signature against a tampered digest", () => {
    const { privateKeyPem, publicKeyPem } = generateAttestationKey();
    const attestor = createAttestor(privateKeyPem);
    const record = attest({ epoch: 3, level: "1234.5" }, attestor);

    // Edit the level and re-digest: the old signature must not carry over.
    const tampered = epochDigest({ epoch: 3, level: "9999.9" });
    assert.equal(
      verifyAttestation({ digest: tampered, signature: record.attestation.signature, publicKeyPem }),
      false,
    );
  });

  it("rejects a signature from a different key", () => {
    const signer = createAttestor(generateAttestationKey().privateKeyPem);
    const other = generateAttestationKey();
    const record = attest({ epoch: 1 }, signer);
    assert.equal(
      verifyAttestation({
        digest: record.attestation.digest,
        signature: record.attestation.signature,
        publicKeyPem: other.publicKeyPem,
      }),
      false,
    );
  });

  it("returns no attestor without a key, so epochs degrade rather than fail", () => {
    assert.equal(createAttestor(undefined), null);
    assert.equal(createAttestor(""), null);
  });

  it("does not throw on a malformed signature", () => {
    const { publicKeyPem } = generateAttestationKey();
    assert.equal(verifyAttestation({ digest: "abc", signature: "not-base64url!!", publicKeyPem }), false);
    assert.equal(verifyAttestation({ digest: "abc", signature: "AAAA", publicKeyPem: "not-a-key" }), false);
  });
});
