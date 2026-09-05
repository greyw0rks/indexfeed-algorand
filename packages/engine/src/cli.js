/**
 * Rebalance CLI — computes the next epoch and publishes it to the epoch store.
 *
 * On the Soroban edition this step submitted a transaction, and the chain
 * enforced that epoch N could only follow N-1. Here the same invariant is
 * enforced by `epochStore.append`, and the ordering of the three writes is what
 * keeps the two stores consistent:
 *
 *   1. append the epoch record   — rejected outright if it is not head + 1
 *   2. save the continuity state — basket units and divisor for the next epoch
 *   3. save the audit record     — full inputs, for reproducing the computation
 *
 * The epoch is written first because it is the immutable one. If step 2 fails the
 * next rebalance cannot compute a continuous divisor and says so loudly; if the
 * order were reversed, a saved state with no matching epoch would silently make
 * the *next* epoch continuous with an epoch nobody can read.
 *
 * Usage:
 *   node src/cli.js rebalance [--dry-run] [--force]
 *   node src/cli.js status
 *   node src/cli.js attest-key
 */
import { buildFundamentalsProviders, buildSources, loadConfig } from "./config.js";
import { runRebalance } from "./rebalance.js";
import { stateStore } from "./state.js";
import { epochStore } from "./epochs.js";
import { fromScaledValue } from "./index-math.js";
import { METHODOLOGY, cadenceGate, methodologyHash } from "./methodology.js";
import { attest, createAttestor, generateAttestationKey } from "./attest.js";

const INDEX_NAME = process.env.INDEX_NAME ?? "IFX20";

async function main() {
  const [command = "rebalance", ...flags] = process.argv.slice(2);
  const config = loadConfig();
  const state = stateStore(config.stateDir);
  const epochs = epochStore(config.stateDir);

  if (command === "attest-key") return printAttestKey();
  if (command === "status") return printStatus({ epochs, state, config });
  if (command !== "rebalance") {
    throw new Error(`unknown command ${command}; expected rebalance, status, or attest-key`);
  }

  const dryRun = flags.includes("--dry-run");
  const force = flags.includes("--force");
  const previousState = await state.load();

  // The cadence is a methodology commitment and nothing enforces it but this
  // check: without it a manual trigger stacks an epoch minutes after a scheduled
  // one, and the published interval stops matching the documented one.
  if (previousState && !force) {
    const head = await epochs.at(previousState.epoch);
    const publishedAtSeconds = head?.publishedAt ? Date.parse(head.publishedAt) / 1000 : null;
    if (publishedAtSeconds) {
      const { isDue, remainingMs } = cadenceGate({ publishedAtSeconds });
      if (!isDue) {
        console.log(
          `epoch ${previousState.epoch + 1} is not due for another ${(remainingMs / 3_600_000).toFixed(1)}h ` +
            `(cadence ${METHODOLOGY.cadenceDays}d). Use --force to override.`,
        );
        return;
      }
    }
  }

  console.log(`computing epoch ${previousState ? previousState.epoch + 1 : 0}${config.useFixtures ? " (fixtures)" : ""}…`);
  const { update, state: nextState, audit } = await runRebalance({
    sources: buildSources(config),
    fundamentalsProviders: buildFundamentalsProviders(config),
    previousState,
  });

  const attestor = createAttestor(config.attestPrivateKey);
  const record = attest(
    {
      index: INDEX_NAME,
      epoch: update.epoch,
      publishedAt: new Date().toISOString(),
      value: update.value,
      level: fromScaledValue(update.value),
      methodologyVersion: METHODOLOGY.version,
      methodologyHash: update.methodologyHash,
      constituents: update.constituents,
      universeSize: audit.universeSize,
      candidatesScreened: audit.universeSize,
      excludedCount: audit.excluded.length,
    },
    attestor,
  );

  console.log(`  level        ${record.level}`);
  console.log(`  constituents ${record.constituents.length}`);
  console.log(`  screened     ${audit.universeSize} candidates, ${audit.excluded.length} excluded`);
  console.log(`  methodology  v${METHODOLOGY.version} ${update.methodologyHash.slice(0, 12)}…`);
  console.log(`  digest       ${record.attestation.digest.slice(0, 12)}… (${record.attestation.alg})`);
  if (!attestor) {
    console.log("  WARNING: no ATTEST_PRIVATE_KEY set — epoch is digest-checkable but unsigned");
  }

  if (dryRun) {
    console.log("dry run: nothing written");
    return;
  }

  const path = await epochs.append(record);
  await state.save(nextState);
  const auditPath = await state.saveAudit(update.epoch, audit);
  console.log(`published epoch ${update.epoch}`);
  console.log(`  ${path}`);
  console.log(`  ${state.statePath}`);
  console.log(`  ${auditPath}`);
}

function printAttestKey() {
  const { privateKeyPem, publicKeyPem } = generateAttestationKey();
  console.log("# Attestation keypair. The private key signs epoch digests and CANNOT move funds.");
  console.log("# Store the private key as ATTEST_PRIVATE_KEY (base64 form avoids newline mangling).");
  console.log(`\nATTEST_PRIVATE_KEY_BASE64=${Buffer.from(privateKeyPem).toString("base64")}`);
  console.log(`\n${publicKeyPem}`);
}

async function printStatus({ epochs, state, config }) {
  const head = await epochs.head();
  const published = await epochs.list();
  const current = await state.load();
  console.log(`state dir    ${config.stateDir}`);
  console.log(`methodology  v${METHODOLOGY.version} ${methodologyHash()}`);
  console.log(`head epoch   ${head === null ? "(none published)" : head}`);
  console.log(`published    [${published.join(", ")}]`);
  console.log(`continuity   ${current ? `divisor ${current.divisor}, ${current.basket.length} constituents` : "(none)"}`);
  if (head !== null) {
    const record = await epochs.at(head);
    const { isDue, remainingMs } = cadenceGate({ publishedAtSeconds: Date.parse(record.publishedAt) / 1000 });
    console.log(`next epoch   ${isDue ? "due now" : `in ${(remainingMs / 3_600_000).toFixed(1)}h`}`);
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
