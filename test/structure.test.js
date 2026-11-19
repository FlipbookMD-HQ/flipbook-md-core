import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileConflictError,
  LastSlideError,
  ValidationError,
  discoverPresentation,
  insertSlide,
  readFileWithHash,
  readSlide,
  removeSlide,
  reorderSlides
} from "@flipbook-md/core";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");
const draft = (patch = {}) => ({ markdown: "# New", template: null, type: null, notes: "", title: null, directives: {}, ...patch });

async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-structure-")));
}

async function copyExample(name) {
  const root = await tempDir();
  await fs.cp(path.join(examples, name), path.join(root, name), { recursive: true });
  return path.join(root, name);
}

async function snapshot(dir) {
  const files = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    files[path.relative(dir, file)] = await fs.readFile(file, "utf8");
  }
  return files;
}

const hashOf = async (file) => (await readFileWithHash(file)).hash;
const manifestHash = (deck) => hashOf(path.join(deck, "presentation.yml"));

const COMMENTED = `# Deck manifest
title: "Deck"
slides:
  # opening
  - "slides/01_intro.slide.md"
  - "slides/02_point.slide.md" # the point
  - "slides/05_end.slide.md"
theme: midnight
`;

async function commentedDeck() {
  const root = path.join(await tempDir(), "deck");
  await fs.mkdir(path.join(root, "slides"), { recursive: true });
  await fs.writeFile(path.join(root, "presentation.yml"), COMMENTED);
  for (const name of ["01_intro", "02_point", "05_end"]) await fs.writeFile(path.join(root, `slides/${name}.slide.md`), `# ${name}\n`);
  return root;
}

test("folder reorder then reverse is byte-identical and never renames files", async () => {
  for (const deck of [await copyExample("database-indexes-project"), await commentedDeck()]) {
    const before = await snapshot(deck);
    const ids = (await discoverPresentation(deck)).slides.map((slide) => slide.source);
    const reversed = [...ids].reverse();
    const first = await reorderSlides(deck, reversed, await manifestHash(deck));
    const after = await snapshot(deck);
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), "no file renamed, added or removed");
    for (const file of Object.keys(before)) if (file !== "presentation.yml") assert.equal(after[file], before[file]);
    assert.deepEqual((await discoverPresentation(deck)).slides.map((slide) => slide.source), reversed);
    await reorderSlides(deck, ids, first.hashes["presentation.yml"]);
    assert.deepEqual(await snapshot(deck), before);
  }
});

test("folder reorder keeps comments, quoting and other keys in place", async () => {
  const deck = await commentedDeck();
  await reorderSlides(deck, ["slides/05_end.slide.md", "slides/01_intro.slide.md", "slides/02_point.slide.md"], await manifestHash(deck));
  assert.equal(
    await fs.readFile(path.join(deck, "presentation.yml"), "utf8"),
    COMMENTED.replace('"slides/01_intro.slide.md"', "A").replace('"slides/02_point.slide.md"', "B").replace('"slides/05_end.slide.md"', "C")
      .replace("A", '"slides/05_end.slide.md"').replace("B", '"slides/01_intro.slide.md"').replace("C", '"slides/02_point.slide.md"')
  );
});

test("single-file reorder then reverse is byte-identical; each chunk keeps its bytes", async () => {
  for (const name of ["database-indexes.slide.md", "system-design.slide.md"]) {
    const dir = await copyExample(name);
    const file = dir;
    const before = await fs.readFile(file, "utf8");
    const count = (await discoverPresentation(file)).slides.length;
    const ids = Array.from({ length: count }, (_, index) => `#${index}`);
    const drafts = await Promise.all(ids.map(async (id) => (await readSlide(file, id)).draft));
    const order = [ids[count - 1], ...ids.slice(1, -1), ids[0]];
    const moved = await reorderSlides(file, order, await hashOf(file));
    const titles = (await discoverPresentation(file)).slides.map((slide) => slide.title);
    assert.equal(titles.length, count);
    for (const [position, id] of order.entries()) {
      assert.deepEqual((await readSlide(file, `#${position}`)).draft, drafts[Number(id.slice(1))]);
    }
    await reorderSlides(file, order, moved.hashes[path.basename(file)]);
    assert.equal(await fs.readFile(file, "utf8"), before);
  }
});

test("insertSlide in a folder deck uses the next free NN after gaps and keeps manifest comments", async () => {
  const deck = await commentedDeck();
  await fs.writeFile(path.join(deck, "slides/07_draft.slide.md"), "# Not in the manifest\n");
  const result = await insertSlide(deck, "slides/01_intro.slide.md", draft({ type: "point", template: "cover" }), await manifestHash(deck));
  assert.equal(result.slideId, "slides/08_point.slide.md");
  const manifest = await fs.readFile(path.join(deck, "presentation.yml"), "utf8");
  assert.match(manifest, /# Deck manifest/);
  assert.match(manifest, /# opening/);
  assert.match(manifest, /# the point/);
  assert.deepEqual(
    (await discoverPresentation(deck)).slides.map((slide) => slide.source),
    ["slides/01_intro.slide.md", "slides/08_point.slide.md", "slides/02_point.slide.md", "slides/05_end.slide.md"]
  );
  assert.equal(await fs.readFile(path.join(deck, result.slideId), "utf8"), "<!-- template: cover -->\n# New\n");
  assert.equal(result.hashes["presentation.yml"], await manifestHash(deck));
  const read = await readSlide(deck, result.slideId);
  assert.deepEqual(read.draft, draft({ type: "point", template: "cover" }));
});

test("insertSlide with afterSlideId null puts the slide first; an untyped slide is NN_slide", async () => {
  const deck = await commentedDeck();
  const result = await insertSlide(deck, null, draft(), await manifestHash(deck));
  assert.equal(result.slideId, "slides/06_slide.slide.md");
  assert.equal((await discoverPresentation(deck)).slides[0].source, "slides/06_slide.slide.md");
});

test("insertSlide in a single-file deck adds a chunk", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "deck.slide.md");
  await fs.writeFile(file, "---\ntitle: Deck\n---\n\n# A\n\n---\n\n# B\n");
  let result = await insertSlide(file, "#0", draft({ type: "point", notes: "Say it" }), await hashOf(file));
  assert.equal(result.slideId, "#1");
  assert.equal(await fs.readFile(file, "utf8"), "---\ntitle: Deck\n---\n\n# A\n\n---\n\n<!-- type: point -->\n# New\n\n<!-- notes:\nSay it\n-->\n\n---\n\n# B\n");
  assert.deepEqual((await readSlide(file, "#1")).draft, draft({ type: "point", notes: "Say it" }));
  result = await insertSlide(file, "#2", draft({ markdown: "# Last" }), result.hashes["deck.slide.md"]);
  assert.equal(result.slideId, "#3");
  assert.deepEqual((await discoverPresentation(file)).slides.map((slide) => slide.title), ["A", "New", "B", "Last"]);
  await assert.rejects(insertSlide(file, null, draft({ markdown: "# X\n\n---\n\nY" }), await hashOf(file)), (error) => error.field === "markdown");
  await assert.rejects(insertSlide(file, null, draft({ title: "T" }), await hashOf(file)), (error) => error.field === "title");
});

test("insert then remove restores both deck kinds byte for byte", async () => {
  const deck = await copyExample("database-indexes-project");
  const before = await snapshot(deck);
  const added = await insertSlide(deck, "slides/03-index-structure.md", draft(), await manifestHash(deck));
  await removeSlide(deck, added.slideId, added.hashes["presentation.yml"]);
  assert.deepEqual(await snapshot(deck), before);

  const file = await copyExample("system-design.slide.md");
  const text = await fs.readFile(file, "utf8");
  for (const after of [null, "#0", "#3"]) {
    const inserted = await insertSlide(file, after, draft(), await hashOf(file));
    await removeSlide(file, inserted.slideId, inserted.hashes["system-design.slide.md"]);
    assert.equal(await fs.readFile(file, "utf8"), text, `after ${after}`);
  }
});

test("removeSlide drops the manifest entry and the file", async () => {
  const deck = await commentedDeck();
  const result = await removeSlide(deck, "slides/02_point.slide.md", await manifestHash(deck));
  assert.equal(await fs.stat(path.join(deck, "slides/02_point.slide.md")).catch(() => null), null);
  assert.deepEqual((await discoverPresentation(deck)).slides.map((slide) => slide.source), ["slides/01_intro.slide.md", "slides/05_end.slide.md"]);
  assert.equal(result.hashes["presentation.yml"], await manifestHash(deck));
  assert.match(await fs.readFile(path.join(deck, "presentation.yml"), "utf8"), /# opening/);
});

test("removing the last slide throws LastSlideError and changes nothing", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "one.slide.md");
  await fs.writeFile(file, "# Only\n");
  await assert.rejects(removeSlide(file, "#0", await hashOf(file)), LastSlideError);
  assert.equal(await fs.readFile(file, "utf8"), "# Only\n");

  const deck = await commentedDeck();
  let hash = await manifestHash(deck);
  for (const id of ["slides/01_intro.slide.md", "slides/02_point.slide.md"]) hash = (await removeSlide(deck, id, hash)).hashes["presentation.yml"];
  await assert.rejects(removeSlide(deck, "slides/05_end.slide.md", hash), (error) => error instanceof LastSlideError && error.code === "LAST_SLIDE");
  assert.ok(await fs.stat(path.join(deck, "slides/05_end.slide.md")));
});

test("reorderSlides rejects a non-permutation", async () => {
  const deck = await commentedDeck();
  const hash = await manifestHash(deck);
  for (const ids of [
    ["slides/01_intro.slide.md", "slides/02_point.slide.md"],
    ["slides/01_intro.slide.md", "slides/01_intro.slide.md", "slides/05_end.slide.md"],
    ["slides/01_intro.slide.md", "slides/02_point.slide.md", "slides/99.slide.md"],
    "nope"
  ]) {
    await assert.rejects(reorderSlides(deck, ids, hash), (error) => error instanceof ValidationError && error.field === "slideIds");
  }
  assert.equal(await fs.readFile(path.join(deck, "presentation.yml"), "utf8"), COMMENTED);
});

test("a stale hash throws FileConflictError for every structure write", async () => {
  const deck = await commentedDeck();
  const stale = await manifestHash(deck);
  await fs.appendFile(path.join(deck, "presentation.yml"), "# edited elsewhere\n");
  const ids = ["slides/05_end.slide.md", "slides/01_intro.slide.md", "slides/02_point.slide.md"];
  await assert.rejects(insertSlide(deck, null, draft(), stale), FileConflictError);
  await assert.rejects(removeSlide(deck, "slides/01_intro.slide.md", stale), FileConflictError);
  await assert.rejects(reorderSlides(deck, ids, stale), (error) => error instanceof FileConflictError && /^[0-9a-f]{64}$/.test(error.currentHash));
  assert.ok(await fs.stat(path.join(deck, "slides/01_intro.slide.md")));
  assert.deepEqual((await fs.readdir(path.join(deck, "slides"))).sort(), ["01_intro.slide.md", "02_point.slide.md", "05_end.slide.md"]);
});

test("unknown slide IDs and templates are refused", async () => {
  const deck = await commentedDeck();
  const hash = await manifestHash(deck);
  await assert.rejects(insertSlide(deck, "slides/99.slide.md", draft(), hash), (error) => error.code === "SLIDE_NOT_FOUND");
  await assert.rejects(removeSlide(deck, "slides/99.slide.md", hash), (error) => error.code === "SLIDE_NOT_FOUND");
  await assert.rejects(insertSlide(deck, null, draft({ template: "nope" }), hash), (error) => error.field === "template");
  assert.equal((await fs.readdir(path.join(deck, "slides"))).length, 3);
});

test("chunkLayout splits a single-file deck and joinLayout puts every byte back", async () => {
  const { chunkLayout, joinLayout } = await import("@flipbook-md/core");
  const text = "﻿---\ntitle: T\n---\n\n# A\n\n<!-- notes:\n---\n-->\n\n---\n\n\n# B\r\n---\n# C\n";
  const layout = chunkLayout(text);
  assert.deepEqual(layout.cores, ["# A\n\n<!-- notes:\n---\n-->", "# B", "# C"]);
  assert.equal(layout.glue.length, layout.cores.length + 1);
  assert.equal(joinLayout(layout), text);
  layout.cores[1] = "# Changed";
  assert.equal(joinLayout(layout), text.replace("# B", "# Changed"));
  assert.deepEqual(chunkLayout("").cores, []);
});
