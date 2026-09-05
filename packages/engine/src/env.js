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
import { dirname, join, resolve } from "node:path";
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
