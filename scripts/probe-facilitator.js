/**
 * Probe the live facilitator and report what it will actually settle.
 *
 * Written because the published guides for this rail are wrong or incomplete in
 * ways that only show up at settlement time. Two specifics found by probing rather
 * than reading: the walkthrough on dev.algorand.co prints the Algorand CAIP-2 ids
 * as full genesis hashes (`algorand:wGHE…qzkkit8=`) while `@x402/avm` 2.24 exports
 * them truncated to 32 characters per the CAIP-2 spec; and the same walkthrough
 * imports the bazaar extension from `@x402-avm/extensions`, which has not been
 * published since March while the rest of the `@x402/*` line moved to 2.24.
 *
 * So this asserts the four things that have to line up, against the live service:
 *
 *   1. the facilitator is up and reports our network
 *   2. it advertises scheme `exact` for it
 *   3. our configured CAIP-2 string matches what it advertises, after normalization
 *   4. the challenge tag is being applied by somebody, so the field name is right
 *
 * Usage: ALGORAND_NETWORK=mainnet node scripts/probe-facilitator.js
 */
import { isAlgorandNetwork, normalizeAlgorandNetwork } from "@x402/avm";
import { loadEnv } from "@indexfeed-algorand/engine/env";
import { NETWORKS, CHALLENGE_TAG } from "../packages/api/src/config.js";

loadEnv(process.cwd());

const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";

async function getJson(path) {
  const res = await fetch(`${FACILITATOR}${path}`, { headers: { accept: "application/json" } });
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    // The Celo facilitator taught this one: the dashboard host serves HTML for
    // API paths, so a "working" URL can return a web page all day.
    throw new Error(`${path} returned ${type || "no content-type"} (${res.status}), not JSON — wrong host?`);
  }
  return { status: res.status, body: await res.json() };
}

async function main() {
  const network = process.env.ALGORAND_NETWORK ?? "testnet";
  const chain = NETWORKS[network];
  if (!chain) throw new Error(`unknown ALGORAND_NETWORK ${network}`);

  console.log(`facilitator  ${FACILITATOR}`);
  console.log(`network      ${network}`);
  console.log(`configured   ${chain.caip2}`);
  console.log(`usdc asa     ${chain.usdcAsa}\n`);

  const failures = [];

  const health = await getJson("/health");
  const netHealth = Object.entries(health.body.networks ?? {}).find(([n]) => sameNetwork(n, chain.caip2));
  console.log(`health       ${health.body.status} v${health.body.version}, uptime ${health.body.uptime}`);
  if (!netHealth) failures.push(`/health does not list ${network}`);
  else console.log(`             ${network} ${netHealth[1].status}, ${netHealth[1].latency}ms`);

  const supported = await getJson("/supported");
  const kind = (supported.body.kinds ?? []).find(
    (k) => k.scheme === "exact" && sameNetwork(k.network, chain.caip2),
  );
  if (!kind) {
    failures.push(`/supported does not advertise scheme "exact" on ${chain.caip2}`);
  } else {
    console.log(`supported    exact on ${kind.network}`);
    console.log(`             x402Version ${kind.x402Version}`);
    if (kind.extra?.feePayer) {
      // The facilitator paying the fee is its choice and it can change it; if this
      // ever disappears, both payer and payee suddenly need an ALGO balance.
      console.log(`             feePayer ${kind.extra.feePayer} (facilitator absorbs the fee)`);
    } else {
      console.log(`             WARNING: no feePayer advertised — payer may need ALGO for fees`);
    }
    if (normalizeAlgorandNetwork(kind.network) !== normalizeAlgorandNetwork(chain.caip2)) {
      failures.push(`network mismatch after normalization: ${kind.network} vs ${chain.caip2}`);
    }
  }

  // Confirm the tag field name against live data rather than the announcement post.
  const resources = await getJson("/discovery/resources");
  const items = resources.body.items ?? [];
  const tagged = items.filter((r) => (r.accepts ?? []).some((a) => a.extra?.tag === CHALLENGE_TAG));
  console.log(`\ndiscovery    ${items.length} resources listed, ${tagged.length} carrying extra.tag="${CHALLENGE_TAG}"`);
  if (tagged.length === 0) {
    failures.push(`no live resource uses extra.tag="${CHALLENGE_TAG}" — the tag location may have changed`);
  }

  const ours = items.filter((r) => (r.accepts ?? []).some((a) => a.payTo === process.env.X402_PAY_TO));
  console.log(`             ${ours.length} listed for our payTo${process.env.X402_PAY_TO ? "" : " (X402_PAY_TO unset)"}`);
  for (const r of ours) console.log(`               ${r.method} ${r.resourceUrl}`);

  if (failures.length) {
    console.log(`\nNOT ready:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nfacilitator will settle exact/USDC on Algorand ${network}`);
}

/** Compare CAIP-2 ids across the truncated and full genesis-hash spellings. */
function sameNetwork(a, b) {
  if (!isAlgorandNetwork(a) || !isAlgorandNetwork(b)) return a === b;
  return normalizeAlgorandNetwork(a) === normalizeAlgorandNetwork(b);
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
