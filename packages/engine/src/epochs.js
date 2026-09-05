/**
 * Published epoch store — the off-chain stand-in for the oracle contract.
 *
 * The Soroban edition of IndexFeed gets one property from the chain for free:
 * epoch N is accepted only when N equals head + 1, which makes every published
 * epoch immutable by construction. Republishing and gap-skipping are both
 * rejected, so a bad update is superseded by the next epoch rather than edited.
 *
 * That invariant is worth keeping, so it is reproduced here — but by this module,
 * not by a chain. `append` refuses to overwrite an existing epoch and refuses to
 * skip one. Be honest about what that buys: a consumer is trusting the operator
 * not to delete the directory, where on Soroban they were trusting no one. The
 * signed digest in attest.js is what narrows that gap.
 *
 * Layout under `dir`:
 *   epochs/epoch-00000.json   one immutable record per epoch
 *   epochs/head.json          {epoch} pointer, written last
 *   state.json                basket + divisor for continuity (see state.js)
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pad = (epoch) => String(epoch).padStart(5, "0");

export function epochStore(dir) {
  const epochDir = join(dir, "epochs");
  const headPath = join(epochDir, "head.json");
  const recordPath = (epoch) => join(epochDir, `epoch-${pad(epoch)}.json`);

  async function readJson(path) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  /** Atomic write — a crash mid-write must not leave a truncated record. */
  async function writeJson(path, value) {
    await mkdir(epochDir, { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }

  return {
    epochDir,

    /** Head epoch number, or null when nothing has been published. */
    async head() {
      const head = await readJson(headPath);
      return head?.epoch ?? null;
    },

    /** A single published epoch, or null if it was never published. */
    async at(epoch) {
      if (!Number.isInteger(epoch) || epoch < 0) return null;
      return readJson(recordPath(epoch));
    },

    /** The most recently published epoch, or null. */
    async latest() {
      const head = await this.head();
      return head === null ? null : this.at(head);
    },

    /** Every published epoch number, ascending. */
    async list() {
      try {
        const files = await readdir(epochDir);
        return files
          .filter((f) => /^epoch-\d{5}\.json$/.test(f))
          .map((f) => Number(f.slice(6, 11)))
          .sort((a, b) => a - b);
      } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
      }
    },

    /**
     * Append the next epoch. Rejects anything that is not exactly head + 1.
     *
     * The record is written before the head pointer moves, so an interrupted
     * append leaves an orphan record that the next attempt overwrites — the
     * failure mode is a wasted file, never a head pointing at nothing.
     */
    async append(record) {
      const head = await this.head();
      const expected = head === null ? 0 : head + 1;
      if (record.epoch !== expected) {
        throw new Error(
          `epoch ${record.epoch} rejected: expected ${expected} (head is ${head === null ? "empty" : head})`,
        );
      }
      if (await this.at(record.epoch)) {
        throw new Error(`epoch ${record.epoch} already published; epochs are immutable`);
      }
      await writeJson(recordPath(record.epoch), record);
      await writeJson(headPath, { epoch: record.epoch, publishedAt: record.publishedAt });
      return recordPath(record.epoch);
    },
  };
}
