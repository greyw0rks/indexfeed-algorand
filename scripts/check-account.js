/**
 * Readiness check for the payout account.
 *
 * Read-only: takes an address, needs no key. Answers the one question that decides
 * whether the endpoint can take a real payment — is this account opted in to USDC —
 * and reports the ALGO balance alongside it, because an account can be opted in and
 * still be below its minimum balance.
 *
 * Usage: ALGORAND_NETWORK=mainnet node scripts/check-account.js <address>
 *        (address defaults to X402_PAY_TO from .env)
 */
import algosdk from "algosdk";
import { USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } from "@x402/avm";
import { loadEnv } from "@indexfeed-algorand/engine/env";

loadEnv(process.cwd());

const NODES = {
  mainnet: { url: "https://mainnet-api.algonode.cloud", asa: Number(USDC_MAINNET_ASA_ID) },
  testnet: { url: "https://testnet-api.algonode.cloud", asa: Number(USDC_TESTNET_ASA_ID) },
};

async function main() {
  const network = process.env.ALGORAND_NETWORK ?? "testnet";
  const node = NODES[network];
  if (!node) throw new Error(`unknown ALGORAND_NETWORK ${network}; expected mainnet or testnet`);

  const address = process.argv[2] ?? process.env.X402_PAY_TO;
  if (!address) throw new Error("pass an address, or set X402_PAY_TO in .env");
  if (!algosdk.isValidAddress(address)) throw new Error(`not a valid Algorand address: ${address}`);

  const client = new algosdk.Algodv2("", node.url, "");
  const info = await client.accountInformation(address).do();

  const algo = Number(info.amount) / 1e6;
  const minBalance = Number(info.minBalance ?? info["min-balance"] ?? 0) / 1e6;
  const usdc = (info.assets ?? []).find((a) => Number(a.assetId ?? a["asset-id"]) === node.asa);
  const usdcBalance = usdc ? Number(usdc.amount) / 1e6 : null;

  console.log(`network      ${network}`);
  console.log(`address      ${address}`);
  console.log(`algo         ${algo} (minimum ${minBalance})`);
  console.log(`usdc opt-in  ${usdc ? "yes" : "NO"}`);
  console.log(`usdc balance ${usdcBalance === null ? "n/a" : usdcBalance}`);
  console.log(`explorer     https://allo.info/address/${address}`);

  const blockers = [];
  if (!usdc) blockers.push(`not opted in to USDC ASA ${node.asa} — settlement will fail while /verify still passes`);
  if (algo < minBalance) blockers.push(`below minimum balance (${algo} < ${minBalance} ALGO)`);

  if (blockers.length) {
    console.log(`\nNOT ready to receive payments:`);
    for (const b of blockers) console.log(`  - ${b}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nready to receive USDC payments on ${network}`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
