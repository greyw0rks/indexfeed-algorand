/**
 * Opt an account in to USDC.
 *
 * An Algorand account cannot hold an ASA it has not opted in to, and the failure
 * mode is the expensive kind: `/verify` is a signature and balance check that
 * passes fine, so the whole x402 integration looks healthy and only `/settle`
 * fails — after a caller has already committed to paying. Run this before the
 * endpoint is ever advertised.
 *
 * An opt-in is a zero-amount asset transfer from the account to itself. It costs
 * one minimum fee and raises the account's minimum balance by 0.1 ALGO.
 *
 * Usage:
 *   ALGORAND_NETWORK=mainnet node scripts/optin-usdc.js "<25-word mnemonic>"
 *   ALGORAND_NETWORK=testnet node scripts/optin-usdc.js "<25-word mnemonic>"
 *
 * The mnemonic is taken as an argument rather than from .env so it never has to be
 * written to a file. Prefix the command with a space if your shell records history.
 */
import algosdk from "algosdk";
import { USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";

const NODES = {
  mainnet: { url: "https://mainnet-api.algonode.cloud", asa: Number(USDC_MAINNET_ASA_ID) },
  testnet: { url: "https://testnet-api.algonode.cloud", asa: Number(USDC_TESTNET_ASA_ID) },
};

async function main() {
  const network = process.env.ALGORAND_NETWORK ?? "testnet";
  const node = NODES[network];
  if (!node) throw new Error(`unknown ALGORAND_NETWORK ${network}; expected mainnet or testnet`);

  const mnemonic = process.argv.slice(2).join(" ").trim();
  if (!mnemonic) throw new Error('pass the mnemonic as an argument: node scripts/optin-usdc.js "word word …"');

  const account = algosdk.mnemonicToSecretKey(mnemonic);
  const address = account.addr.toString();
  const client = new algosdk.Algodv2("", node.url, "");

  console.log(`network  ${network}`);
  console.log(`account  ${address}`);
  console.log(`usdc asa ${node.asa}`);

  const info = await client.accountInformation(address).do();
  const balance = Number(info.amount) / 1e6;
  console.log(`balance  ${balance} ALGO`);

  const alreadyIn = (info.assets ?? []).some((a) => Number(a.assetId ?? a["asset-id"]) === node.asa);
  if (alreadyIn) {
    console.log("\nalready opted in to USDC — nothing to do");
    return;
  }

  // 0.1 ALGO per ASA of minimum balance, plus the fee, plus the base minimum.
  if (balance < 0.21) {
    throw new Error(
      `balance too low to opt in: ${balance} ALGO. Fund the account with ~0.3 ALGO first ` +
        "(0.1 base minimum + 0.1 per-ASA minimum + fee).",
    );
  }

  const params = await client.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: node.asa,
    suggestedParams: params,
  });

  const signed = txn.signTxn(account.sk);
  const { txid } = await client.sendRawTransaction(signed).do();
  console.log(`\nsubmitted ${txid}`);

  const confirmed = await algosdk.waitForConfirmation(client, txid, 10);
  console.log(`confirmed in round ${confirmed.confirmedRound ?? confirmed["confirmed-round"]}`);
  console.log(`explorer  https://allo.info/tx/${txid}`);
  console.log("\nopted in. This account can now receive USDC.");
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
