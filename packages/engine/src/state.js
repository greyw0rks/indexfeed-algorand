/**
 * Rebalance state persistence.
 *
 * The contract stores the published *result* (level, weights, hash) but not the
 * basket units or divisor, which are what make the next epoch continuous with
 * this one. Those live here. Losing this file means the next rebalance cannot
 * reproduce the divisor, so it is written atomically and kept alongside the
 * per-epoch audit records.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function stateStore(dir) {
  const statePath = join(dir, "state.json");

  return {
    statePath,

    /** Last persisted state, or null if no epoch has been recorded. */
    async load() {
      try {
        const raw = await readFile(statePath, "utf8");
        return JSON.parse(raw);
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
    },

    /** Atomic write — a crash mid-write must not leave a truncated state. */
    async save(state) {
      await mkdir(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(tmp, statePath);
    },

    /** One immutable audit record per epoch, for reproducing a past update. */
    async saveAudit(epoch, audit) {
      const auditDir = join(dir, "audit");
      await mkdir(auditDir, { recursive: true });
      const path = join(auditDir, `epoch-${String(epoch).padStart(5, "0")}.json`);
      await writeFile(path, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
      return path;
    },
  };
}
