import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "@flipbook-md/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function moduleExports() {
  const names = new Set();
  for (const file of await fs.readdir(path.join(root, "src"))) {
    if (!file.endsWith(".js")) continue;
    const module = await import(path.join(root, "src", file));
    for (const name of Object.keys(module)) names.add(name);
  }
  return [...names].sort();
}

test("the package entry exports every name the modules export", async () => {
  const expected = await moduleExports();
  assert.deepEqual(Object.keys(core).sort(), expected);
  for (const name of ["discoverPresentation", "startServer", "exportCarousel", "exportVideo", "PRESETS", "loadGroup", "parsePlacement", "evaluateBlueprint", "parseChrome", "loadThemeCss"]) {
    assert.ok(name in core, `${name} is exported`);
  }
});

test("index.d.ts declares every runtime export", async () => {
  const declarations = await fs.readFile(path.join(root, "index.d.ts"), "utf8");
  const declared = new Set([...declarations.matchAll(/^export (?:declare )?(?:function|const|class) (\w+)/gm)].map((match) => match[1]));
  const missing = Object.keys(core).filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
});

test("deep imports outside the exports map are refused", async () => {
  await assert.rejects(() => import("@flipbook-md/core/src/presentation.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("the packed files include the player and library but no tests or examples", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  const files = JSON.parse(output)[0].files.map((file) => file.path);
  assert.ok(files.includes("index.js"));
  assert.ok(files.includes("index.d.ts"));
  assert.ok(files.some((file) => file.startsWith("public/")), "public/ is packed");
  assert.ok(files.some((file) => file.startsWith("library/templates/")), "library/ is packed");
  assert.equal(files.some((file) => file.startsWith("test/")), false);
  assert.equal(files.some((file) => file.startsWith("examples/")), false);
});
