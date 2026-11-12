import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileConflictError, KitInvalidError, KitNotFoundError, ReservedNameError, hashBytes, libraryRoot, readKit, writeKit } from "@flipbook-md/core";

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

let home;
beforeEach(async () => {
  home = await tempDir("flipbook-patch-home-");
  process.env.FLIPBOOK_HOME = home;
});

/** Copies a file into the library as a kit and returns its ref and hash. */
async function install(kind, name, file) {
  const folder = kind === "blueprint" ? "blueprints" : "templates";
  const bytes = await fs.readFile(file);
  await fs.mkdir(path.join(home, folder), { recursive: true });
  await fs.writeFile(path.join(home, folder, `${name}.yml`), bytes);
  return { ref: { kind, name, scope: "library" }, file: path.join(home, folder, `${name}.yml`), text: bytes.toString("utf8"), hash: hashBytes(bytes) };
}

function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  assert.equal(a.length, b.length, "line count changed");
  return a.map((line, index) => [line, b[index]]).filter(([x, y]) => x !== y);
}

const groups = (await fs.readdir(path.join(libraryRoot(), "templates"))).filter((name) => name.endsWith(".yml"));
const KITS = [
  ...groups.map((name) => ({ kind: "group", name: name.slice(0, -4), file: path.join(libraryRoot(), "templates", name), patch: { description: "A new description." } })),
  { kind: "blueprint", name: "talk", file: path.resolve("examples/blueprint-talk/blueprint.yml"), patch: { types: { conclusion: { max_chars: 300 } } } }
];

for (const kit of KITS) {
  test(`golden: ${kit.kind} ${kit.name} keeps its bytes on an empty patch and changes one line on a one-field patch`, async () => {
    const { ref, file, text, hash } = await install(kit.kind, kit.name, kit.file);
    const empty = await writeKit(ref, { patch: {} }, hash);
    assert.equal(empty.hash, hash);
    assert.equal(await fs.readFile(file, "utf8"), text);

    await writeKit(ref, { patch: kit.patch }, hash);
    const changed = changedLines(text, await fs.readFile(file, "utf8"));
    assert.equal(changed.length, 1, JSON.stringify(changed));
  });
}

test("patches keep comments and key order, delete with null and add new keys at the end", async () => {
  const source = "# Blueprint for talks\npages:\n  - type: cover\n  - type: point\ntypes:\n  cover:\n    template: cover # always the cover\n  # Points stay short.\n  point:\n    max_chars: 200\n    allow: [heading, paragraph]\n";
  await fs.mkdir(path.join(home, "blueprints"));
  await fs.writeFile(path.join(home, "blueprints/talk.yml"), source);
  const ref = { kind: "blueprint", name: "talk", scope: "library" };
  const { hash } = await readKit(ref);

  const first = await writeKit(ref, { patch: { types: { point: { max_chars: 250 } } } }, hash);
  assert.equal(await fs.readFile(path.join(home, "blueprints/talk.yml"), "utf8"), source.replace("max_chars: 200", "max_chars: 250"));

  const second = await writeKit(ref, { patch: { types: { point: { allow: null, max_items: 3 } } } }, first.hash);
  const text = await fs.readFile(path.join(home, "blueprints/talk.yml"), "utf8");
  assert.equal(text, source.replace("max_chars: 200", "max_chars: 250").replace("    allow: [heading, paragraph]\n", "    max_items: 3\n"));
  assert.match(text, /# Points stay short\./);
  assert.match(text, /template: cover # always the cover/);
  await assert.rejects(writeKit(ref, { patch: { types: { point: { max_chars: 1 } } } }, first.hash), FileConflictError);
  void second;
});

test("a patch that makes the kit invalid throws KitInvalidError and leaves the file untouched", async () => {
  const { ref, file, text, hash } = await install("blueprint", "talk", path.resolve("examples/blueprint-talk/blueprint.yml"));
  await assert.rejects(writeKit(ref, { patch: { pages: [] } }, hash), KitInvalidError);
  await assert.rejects(writeKit(ref, { patch: { types: { cover: { template: "nowhere" } } } }, hash), KitInvalidError);
  assert.equal(await fs.readFile(file, "utf8"), text);
});

test("a deck templates.yml patch addresses one template and leaves the other two alone", async () => {
  const deckDir = await tempDir("flipbook-patch-deck-");
  const source = "# Deck templates\nquote:\n  column: 2\n  row: 1\n  width: 2\n  height: 3\n  align: center\naside:\n  column: 1\n  row: 1\n  width: 1\n  height: 1\n  align: start\nwide: {column: 1, row: 3, width: 3, height: 1, align: end}\n";
  await fs.writeFile(path.join(deckDir, "templates.yml"), source);
  const ref = { kind: "template", name: "quote", scope: "deck", deckDir };
  const { hash } = await readKit(ref);
  const patched = await writeKit(ref, { patch: { align: "start" } }, hash);
  assert.equal(await fs.readFile(path.join(deckDir, "templates.yml"), "utf8"), source.replace("  align: center", "  align: start"));

  // A new template is added at the end; null removes one.
  await writeKit({ ...ref, name: "banner" }, { patch: { column: 1, row: 1, width: 3, height: 1, align: "center" } }, patched.hash);
  const added = await readKit(ref);
  assert.deepEqual(Object.keys(added.parsed), ["quote", "aside", "wide", "banner"]);
  await writeKit({ ...ref, name: "aside" }, { patch: null }, added.hash);
  assert.deepEqual(Object.keys((await readKit(ref)).parsed), ["quote", "wide", "banner"]);
  assert.match(await fs.readFile(path.join(deckDir, "templates.yml"), "utf8"), /^# Deck templates\n/);

  await assert.rejects(writeKit({ ...ref, name: "cover" }, { patch: { column: 1 } }, null), ReservedNameError);
  const before = await fs.readFile(path.join(deckDir, "templates.yml"), "utf8");
  await assert.rejects(writeKit(ref, { patch: { width: 3 } }, (await readKit(ref)).hash), /leaves the 3x3 grid/);
  assert.equal(await fs.readFile(path.join(deckDir, "templates.yml"), "utf8"), before);
});

test("patching a missing deck templates.yml creates it; a missing library kit is not found", async () => {
  const deckDir = await tempDir("flipbook-patch-new-");
  await writeKit({ kind: "template", name: "quote", scope: "deck", deckDir }, { patch: { column: 1, row: 2, width: 2, height: 1, align: "start" } }, null);
  assert.equal(await fs.readFile(path.join(deckDir, "templates.yml"), "utf8"), "quote:\n  column: 1\n  row: 2\n  width: 2\n  height: 1\n  align: start\n");
  await assert.rejects(writeKit({ kind: "blueprint", name: "nope", scope: "library" }, { patch: { pages: [] } }, null), KitNotFoundError);
  await assert.rejects(writeKit({ kind: "theme", name: "t", scope: "library" }, { patch: {} }, null), /send source/);
});
