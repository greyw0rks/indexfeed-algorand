/**
 * Loads the monorepo-root `.env`.
 *
 * Packages are run from their own directory (`npm run rebalance` in
 * packages/aggregator), so dotenv's default cwd lookup misses the root file and
 * every command would need its own copy of the secrets. Ambient environment
 * variables still win — dotenv never overrides what is already set — which is
 * what makes container and CI deployments work without a file at all.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/** Walk up from `startDir` looking for a `.env`, stopping at the filesystem root. */
export function findEnvFile(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadEnv(startDir = dirname(fileURLToPath(import.meta.url))) {
  const path = findEnvFile(startDir);
  // `quiet` suppresses dotenv's banner, which otherwise prefixes every CLI
  // command's output and would corrupt piped or parsed output.
  if (path) dotenv.config({ path, quiet: true });
  return path;
}

/**
 * Monorepo root, derived from this file's own location rather than from cwd.
 *
 * `packages/engine/src/env.js` → three levels up. Fragile to moving this file and
 * nothing else, which is a trade for being immune to the thing that actually
 * happens.
 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Resolve a state directory against the repo root, not the working directory.
 *
 * npm runs a workspace script with cwd set to that workspace, so the documented
 * `npm run rebalance --workspace @indexfeed-algorand/engine` resolved `./state`
 * to `packages/engine/state`, while `npm start` resolved the same default to
 * `packages/api/state` — two private directories, neither of them the tracked
 * `state/` at the root that holds the published epochs. The rebalancer wrote
 * epochs the API could not see, and the API reported no published index while
 * looking perfectly healthy.
 *
 * Absolute paths are passed through untouched, so a container mount or a test's
 * temp directory still overrides this completely.
 */
export function resolveStateDir(value) {
  if (!value) return resolve(REPO_ROOT, "state");
  return isAbsolute(value) ? value : resolve(REPO_ROOT, value);
}
