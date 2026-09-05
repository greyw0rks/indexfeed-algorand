/**
 * CLI for the paying client. One paid read, reported in full.
 *
 * Usage:
 *   node packages/client/src/cli.js <url>            pay for one route
 *   node packages/client/src/cli.js --quote <url>    read the price, pay nothing
 *
 * Reads PAYER_MNEMONIC and ALGORAND_NETWORK from .env.
 */
import { loadEnv } from "@indexfeed-algorand/engine/env";
import { createPayingClient, paidGet, quote } from "./index.js";

loadEnv(process.cwd());

async function main() {
  const args = process.argv.slice(2);
  const quoteOnly = args.includes("--quote");
  const url = args.find((a) => a.startsWith("http"));
  if (!url) throw new Error("pass a URL, e.g. node packages/client/src/cli.js https://host/v1/index/tick");

  if (quoteOnly) {
    const result = await quote(url);
    console.log(`status ${result.status}`);
    if (result.paymentRequired) {
      console.log("payment-required header present (route is metered)");
      // The header is a signed token; the readable price lives in the free
      // service description, so point there rather than pretending to decode it.
      console.log("read prices from the service root: GET /");
    }
    if (result.body) console.log(JSON.stringify(result.body, null, 2));
    return;
  }

  const network = process.env.ALGORAND_NETWORK ?? "testnet";
  const client = createPayingClient({ mnemonic: process.env.PAYER_MNEMONIC, network });
  console.log(`paying as ${client.address} on ${network}`);

  const started = Date.now();
  const { status, ok, body, settlement } = await paidGet(client, url);
  console.log(`\n${status} in ${Date.now() - started}ms`);

  if (settlement) {
    console.log("\nsettlement:");
    console.log(`  success     ${settlement.success}`);
    console.log(`  payer       ${settlement.payer}`);
    console.log(`  transaction ${settlement.transaction}`);
    console.log(`  network     ${settlement.network}`);
    if (settlement.transaction) console.log(`  explorer    https://allo.info/tx/${settlement.transaction}`);
  } else {
    console.log("\nno settlement header — the response was not paid for");
  }

  console.log(`\nbody:\n${typeof body === "string" ? body : JSON.stringify(body, null, 2)}`);
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err?.response?.data?.error ?? err?.message ?? err));
  process.exit(1);
});
