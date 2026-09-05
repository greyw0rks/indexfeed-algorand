/**
 * Client tests. Offline: no facilitator, no chain, no funded account.
 *
 * What is worth testing without a network is the signing-key derivation, because
 * it is the one place this client deliberately diverges from the published
 * walkthrough. The docs route a mnemonic through `algokit-utils`
 * (`seedFromMnemonic` → `ed25519SigningKeyFromWrappedSecret`) pinned to an alpha
 * release; this client takes algosdk's `.sk` directly, on the basis that it is
 * already the 64-byte seed||pubkey concatenation `@x402/avm` wants. If that
 * equivalence ever breaks, the symptom in production is a signature the
 * facilitator cannot attribute — an error that reads like a funding or opt-in
 * problem. So it is asserted here instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import algosdk from "algosdk";
import { ALGORAND_MAINNET_GENESIS_HASH, ALGORAND_TESTNET_GENESIS_HASH } from "@x402/avm";
import { CAIP2, createPayingClient } from "../src/index.js";

describe("paying client", () => {
  it("derives the signer address from the mnemonic via algosdk's secret key", () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

    const client = createPayingClient({ mnemonic, network: "testnet" });

    assert.equal(client.address, account.addr.toString());
    assert.equal(client.caip2, `algorand:${ALGORAND_TESTNET_GENESIS_HASH}`);
  });

  it("registers the mainnet scheme when asked for mainnet", () => {
    const account = algosdk.generateAccount();
    const client = createPayingClient({
      mnemonic: algosdk.secretKeyToMnemonic(account.sk),
      network: "mainnet",
    });
    assert.equal(client.caip2, `algorand:${ALGORAND_MAINNET_GENESIS_HASH}`);
  });

  it("spells CAIP-2 as the facilitator does, not as the truncated constant", () => {
    // The resource server compares network strings by exact equality, so a client
    // registered against the truncated `ALGORAND_*_CAIP2` constants has no scheme
    // for the network it is asked to pay on. The full genesis hash ends in "=".
    for (const caip2 of Object.values(CAIP2)) {
      assert.match(caip2, /^algorand:[A-Za-z0-9+/]{43}=$/);
    }
  });

  it("exposes both networks and nothing else", () => {
    assert.deepEqual(Object.keys(CAIP2).sort(), ["mainnet", "testnet"]);
  });

  it("refuses an unknown network rather than defaulting to one", () => {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);
    // Defaulting here would be the dangerous kind of convenience: a typo in
    // ALGORAND_NETWORK must not silently pay on the wrong chain.
    assert.throws(() => createPayingClient({ mnemonic, network: "mainnnet" }), /unknown network/);
  });

  it("requires a mnemonic", () => {
    assert.throws(() => createPayingClient({ network: "testnet" }), /mnemonic is required/);
  });

  it("reports no settlement for an unpaid response", () => {
    const account = algosdk.generateAccount();
    const client = createPayingClient({
      mnemonic: algosdk.secretKeyToMnemonic(account.sk),
      network: "testnet",
    });
    const res = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(client.settlementOf(res), null);
  });
});
