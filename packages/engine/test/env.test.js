/**
 * State directory resolution.
 *
 * The bug this pins is not hypothetical: npm sets cwd to the workspace when
 * running a workspace script, so the default `./state` resolved to
 * `packages/engine/state` for the rebalancer and `packages/api/state` for the
 * server — two private directories, neither of them the tracked `state/` at the
 * repo root. Epochs were published where the API could not read them, and the API
 * reported an unpublished index while otherwise looking healthy.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chdir, cwd } from "node:process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT, resolveStateDir } from "../src/env.js";

test("the repo root is the workspace root, not a package", () => {
  // The anchor for every relative state path, so it is worth asserting directly
  // rather than only through its consequences.
  assert.equal(resolve(REPO_ROOT, "packages/engine"), resolve(import.meta.dirname, ".."));
});

test("a relative state dir is the same directory from any cwd", () => {
  const original = cwd();
  try {
    chdir(resolve(import.meta.dirname, ".."));
    const fromPackage = resolveStateDir("./state");
    chdir(REPO_ROOT);
    const fromRoot = resolveStateDir("./state");
    assert.equal(fromPackage, fromRoot);
    assert.equal(fromRoot, join(REPO_ROOT, "state"));
  } finally {
    chdir(original);
  }
});

test("an unset state dir defaults to the tracked directory", () => {
  assert.equal(resolveStateDir(undefined), join(REPO_ROOT, "state"));
  assert.equal(resolveStateDir(""), join(REPO_ROOT, "state"));
});

test("an absolute state dir is passed through untouched", () => {
  // Container mounts and the temp directories tests run in must override
  // completely, or every test would share the repo's real epoch store.
  const abs = join(tmpdir(), "indexfeed-somewhere");
  assert.equal(resolveStateDir(abs), abs);
});
