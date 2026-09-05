/**
 * Reference consumer: an agent that buys index data on a schedule and does
 * something with it.
 *
 * This is the demo of the pitch — an autonomous caller with a wallet, no API key,
 * and no account, paying per request — and it is also what produces sustained
 * on-chain usage through the measurement window. It deliberately does more than
 * fire requests: it keeps a local time series, detects moves against a threshold,
 * and writes what it bought to disk. A poller that discards its purchases is a
 * traffic generator, not a consumer, and the difference shows in the artifacts.
 *
 * Two honest caveats, kept here rather than in a README nobody reads:
 *
 *   1. Traffic this process generates is *first-party*. It is real USDC settling
 *      on MainNet, but it moves from a wallet we control to a wallet we control,
 *      and the facilitator absorbs the fee — so it costs us the float and nothing
 *      else. Whether that counts the same as third-party demand is the organizers'
 *      call, not ours, and a leaderboard built on it is fragile in a way one built
 *      on outside callers is not.
 *
 *   2. It spends real money at real rates. At $0.001 a tick, one call every five
 *      seconds is ~$17/day. `MAX_SPEND_USDC` is a hard stop, checked before every
 *      request, because an unattended loop with a wallet is the kind of thing that
 *      empties an account over a weekend.
 *
 * Usage:
 *   node packages/client/src/poller.js
 *
 * Env: POLL_URL, POLL_INTERVAL_SECONDS, MAX_SPEND_USDC, POLL_PRICE_USDC,
 *      POLL_OUT_DIR, PAYER_MNEMONIC, ALGORAND_NETWORK
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadEnv } from "@indexfeed-algorand/engine/env";
import { createPayingClient, paidGet } from "./index.js";

loadEnv(process.cwd());

const config = {
  url: process.env.POLL_URL ?? "http://127.0.0.1:3002/v1/index/tick",
  intervalSeconds: Number(process.env.POLL_INTERVAL_SECONDS ?? 30),
  maxSpendUsdc: Number(process.env.MAX_SPEND_USDC ?? 1),
  pricePerCallUsdc: Number(process.env.POLL_PRICE_USDC ?? 0.001),
  outDir: process.env.POLL_OUT_DIR ?? "./state/consumer",
  network: process.env.ALGORAND_NETWORK ?? "testnet",
  /** Log a move when the level changes by more than this, in basis points. */
  moveThresholdBps: Number(process.env.POLL_MOVE_THRESHOLD_BPS ?? 25),
};

async function main() {
  const client = createPayingClient({ mnemonic: process.env.PAYER_MNEMONIC, network: config.network });
  await mkdir(config.outDir, { recursive: true });
  const seriesPath = join(config.outDir, "tick-series.jsonl");

  console.log(`consumer agent starting`);
  console.log(`  paying as   ${client.address} (${config.network})`);
  console.log(`  polling     ${config.url} every ${config.intervalSeconds}s`);
  console.log(`  budget      $${config.maxSpendUsdc} at ~$${config.pricePerCallUsdc}/call ` +
    `(~${Math.floor(config.maxSpendUsdc / config.pricePerCallUsdc)} calls, ` +
    `~${((config.maxSpendUsdc / config.pricePerCallUsdc) * config.intervalSeconds / 3600).toFixed(1)}h)`);
  console.log(`  writing     ${seriesPath}`);

  let calls = 0;
  let settled = 0;
  let spent = 0;
  let failures = 0;
  let lastLevel = null;
  let stopping = false;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: stopping after ${calls} calls, ${settled} settled, ~$${spent.toFixed(4)} spent`);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  for (;;) {
    // Checked before the request, not after: the point of a budget is to not
    // spend the money, and x402 settles inside the fetch.
    if (spent + config.pricePerCallUsdc > config.maxSpendUsdc) {
      console.log(`\nbudget reached: ~$${spent.toFixed(4)} of $${config.maxSpendUsdc}. Stopping.`);
      break;
    }

    const at = new Date().toISOString();
    try {
      const { status, ok, body, settlement } = await paidGet(client, config.url);
      calls += 1;

      if (!ok) {
        failures += 1;
        // A 503 from the freshness gate is unpaid by design, so it must not be
        // counted against the budget — see the gate in the API's handlers.js.
        console.log(`${at}  ${status}  ${typeof body === "object" ? body?.error : body}`);
      } else {
        if (settlement?.transaction) {
          settled += 1;
          spent += config.pricePerCallUsdc;
        }
        const level = body?.level;
        const moveBps = lastLevel === null ? 0 : ((level - lastLevel) / lastLevel) * 10_000;
        lastLevel = level;

        await appendFile(
          seriesPath,
          `${JSON.stringify({
            at,
            epoch: body?.epoch,
            level,
            priceAgeSeconds: body?.priceAgeSeconds,
            stale: body?.stale ?? [],
            txid: settlement?.transaction ?? null,
          })}\n`,
        );

        const flag = Math.abs(moveBps) >= config.moveThresholdBps ? `  MOVE ${moveBps > 0 ? "+" : ""}${moveBps.toFixed(1)}bps` : "";
        console.log(
          `${at}  level ${String(level).padEnd(14)} epoch ${body?.epoch}  ` +
            `${settlement?.transaction ? settlement.transaction.slice(0, 8) + "…" : "unsettled"}${flag}`,
        );
      }
    } catch (err) {
      failures += 1;
      console.log(`${at}  error  ${String(err?.message ?? err)}`);
    }

    // Consecutive failures back off rather than hammering a service that is down.
    const delay = failures > 3 ? config.intervalSeconds * 4 : config.intervalSeconds;
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    if (failures > 3) failures = 0;
  }

  console.log(`\ndone: ${calls} calls, ${settled} settled, ~$${spent.toFixed(4)} spent`);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
