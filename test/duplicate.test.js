import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeckExistsError, KitExistsError, KitNotFoundError, ValidationError, copyKit, discoverPresentation, duplicateDeck, loadPresentation, readKit } from "@flipbook-md/core";

// US-20 · 1.1.1 and 1.1.2: duplicateDeck and copyKit (tech-spec D26, D27).

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-duplicate-")));
}

async function write(root, files) {
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
}

/** Every file under `dir` as { relative path: bytes }, hidden entries included. */
async function snapshot(dir) {
  const files = {};
  async function walk(at, rel) {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) files[next] = `-> ${await fs.readlink(path.join(at, entry.name))}`;
      else if (entry.isDirectory()) await walk(path.join(at, entry.name), next);
      else files[next] = (await fs.readFile(path.join(at, entry.name))).toString("base64");
    }
  }
  await walk(dir, "");
  return files;
}

async function withHome(fn) {
  const previous = process.env.FLIPBOOK_HOME;
  const home = await tempRoot();
  process.env.FLIPBOOK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous == null) delete process.env.FLIPBOOK_HOME;
    else process.env.FLIPBOOK_HOME = previous;
  }
}

const MANIFEST = "# The talk deck\ntitle: Talk  # shown on the cover\ntheme: dark\nslides:\n  - slides/01-intro.slide.md\n  - slides/02-more.slide.md\n";

async function folderDeck() {
  const root = await tempRoot();
  await write(root, {
    "talk/presentation.yml": MANIFEST,
    "talk/configuration.yml": "transition: fade\n",
    "talk/presentation.css": ".slide { color: red; }\n",
    "talk/slides/01-intro.slide.md": "# Intro\n\n![chart](../assets/chart.png)\n",
    "talk/slides/02-more.slide.md": "# More\n\nNotes: say hi\n",
    "talk/assets/chart.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    "talk/notes.txt": "my own file\n",
    "talk/dist/talk.pdf": "big export",
    "talk/.git/HEAD": "ref: refs/heads/main\n",
    "talk/.DS_Store": "x"
  });
  return { root, deck: path.join(root, "talk") };
}

test("duplicateDeck copies a folder deck beside itself and changes only the title", async () => {
  const { root, deck } = await folderDeck();
  const before = await snapshot(deck);
  const result = await duplicateDeck(deck, { name: "talk-copy", title: "Talk (copy)" });
  assert.deepEqual(result, { path: path.join(root, "talk-copy"), skipped: [] });

  const copy = await snapshot(result.path);
  const expected = Object.fromEntries(Object.entries(before).filter(([name]) => !/^(dist\/|\.)/.test(name)));
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(expected).sort());
  for (const [name, bytes] of Object.entries(expected)) {
    if (name !== "presentation.yml") assert.equal(copy[name], bytes, `${name} is identical`);
  }
  assert.equal(
    await fs.readFile(path.join(result.path, "presentation.yml"), "utf8"),
    MANIFEST.replace("title: Talk  #", "title: Talk (copy)  #")
  );
  assert.deepEqual(await snapshot(deck), before, "the original is untouched");
  assert.deepEqual((await fs.readdir(root)).sort(), ["talk", "talk-copy"], "no temp folder left behind");

  const original = await discoverPresentation(deck);
  const duplicate = await discoverPresentation(result.path);
  assert.equal(duplicate.title, "Talk (copy)");
  assert.equal(duplicate.slides.length, original.slides.length);
});

test("duplicateDeck gives the copy the same blueprint result as the original", async () => {
  const root = await tempRoot();
  await write(root, {
    "kit/presentation.yml": "title: Kit\ngroup: marvel_content_guide\nslides:\n  - slides/01_cover.slide.md\n",
    "kit/slides/01_cover.slide.md": "# Kit\n"
  });
  const { path: copy } = await duplicateDeck(path.join(root, "kit"), { name: "kit-2", title: "Kit 2" });
  const codes = async (dir) => (await loadPresentation(dir, { blueprint: "evaluate" })).violations.map((v) => `${v.code}:${v.slide ?? ""}`);
  assert.deepEqual(await codes(copy), await codes(path.join(root, "kit")));
});

test("duplicateDeck leaves symlinks out and lists them", async () => {
  const { root, deck } = await folderDeck();
  const outside = await tempRoot();
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(deck, "assets", "link.txt"));
  await fs.symlink(outside, path.join(deck, "shared"));
  const result = await duplicateDeck(deck, { name: "linked", title: "Linked" });
  assert.deepEqual(result.skipped.sort(), ["assets/link.txt", "shared"]);
  await assert.rejects(fs.lstat(path.join(root, "linked", "shared")), { code: "ENOENT" });
  await assert.rejects(fs.lstat(path.join(root, "linked", "assets", "link.txt")), { code: "ENOENT" });
});

test("duplicateDeck copies a single-file deck beside it, sharing assets/", async () => {
  const root = await tempRoot();
  const text = "---\n# keep me\ntitle: \"Solo\"\ntheme: dark\n---\n\n# One\n\n![x](assets/x.png)\n\n---\n\n# Two\n";
  await write(root, { "solo.slide.md": text, "assets/x.png": "png" });
  const result = await duplicateDeck(path.join(root, "solo.slide.md"), { name: "solo-copy", title: "Solo: copy" });
  assert.deepEqual(result, { path: path.join(root, "solo-copy.slide.md"), skipped: [] });
  const copied = await fs.readFile(result.path, "utf8");
  assert.equal(copied, text.replace('title: "Solo"', "title: \"Solo: copy\""));
  assert.equal(await fs.readFile(path.join(root, "solo.slide.md"), "utf8"), text);
  assert.deepEqual((await fs.readdir(root)).sort(), ["assets", "solo-copy.slide.md", "solo.slide.md"]);
  const deck = await discoverPresentation(result.path);
  assert.equal(deck.title, "Solo: copy");
  assert.equal(deck.slides.length, 2);
});

test("duplicateDeck adds a title to a single-file deck without frontmatter", async () => {
  const root = await tempRoot();
  await write(root, { "bare.slide.md": "# Bare\n" });
  const { path: copy } = await duplicateDeck(path.join(root, "bare.slide.md"), { name: "bare-2", title: "Bare 2" });
  assert.equal(await fs.readFile(copy, "utf8"), "---\ntitle: Bare 2\n---\n\n# Bare\n");
  assert.equal((await discoverPresentation(copy)).title, "Bare 2");
});

test("duplicateDeck refuses a taken name, in any case, before writing", async () => {
  const { root, deck } = await folderDeck();
  await write(root, { "other/presentation.yml": "title: Other\nslides: []\n", "solo.slide.md": "# Solo\n", "taken.slide.md": "# T\n" });
  const before = (await fs.readdir(root)).sort();
  await assert.rejects(duplicateDeck(deck, { name: "other", title: "X" }), DeckExistsError);
  await assert.rejects(duplicateDeck(deck, { name: "talk", title: "X" }), DeckExistsError);
  await assert.rejects(duplicateDeck(path.join(root, "solo.slide.md"), { name: "taken", title: "X" }), DeckExistsError);
  assert.deepEqual((await fs.readdir(root)).sort(), before);
});

test("duplicateDeck validates the name and title", async () => {
  const { deck } = await folderDeck();
  for (const options of [{ name: "Bad Name", title: "X" }, { name: "../up", title: "X" }, { name: "ok", title: "  " }, { name: "ok", title: "x".repeat(121) }]) {
    await assert.rejects(duplicateDeck(deck, options), (error) => error instanceof ValidationError && error.code === "VALIDATION_FAILED");
  }
});

test("duplicateDeck refuses a missing deck or one that doesn't load", async () => {
  const root = await tempRoot();
  await write(root, { "broken/presentation.yml": "title: [unclosed\n" });
  await assert.rejects(duplicateDeck(path.join(root, "nope"), { name: "x", title: "X" }), { code: "DECK_NOT_FOUND" });
  await assert.rejects(duplicateDeck(path.join(root, "broken"), { name: "x", title: "X" }), { code: "DECK_LOAD_FAILED" });
  assert.deepEqual((await fs.readdir(root)).sort(), ["broken"]);
});

test("duplicateDeck removes its temp folder when the copy fails part-way", async () => {
  const { root, deck } = await folderDeck();
  await fs.chmod(path.join(deck, "notes.txt"), 0o000);
  try {
    await assert.rejects(duplicateDeck(deck, { name: "half", title: "Half" }));
  } finally {
    await fs.chmod(path.join(deck, "notes.txt"), 0o644);
  }
  assert.deepEqual(await fs.readdir(root), ["talk"]);
});

test("copyKit copies a built-in theme into the library byte for byte", async () => {
  await withHome(async (home) => {
    const builtIn = await readKit({ kind: "theme", name: "marvel-jarvis", scope: "builtin" });
    const copied = await copyKit({ kind: "theme", name: "marvel-jarvis" }, "my-theme");
    assert.deepEqual(copied.ref, { kind: "theme", name: "my-theme", scope: "library" });
    assert.equal(copied.path, path.join(home, "themes", "my-theme.css"));
    assert.equal(await fs.readFile(copied.path, "utf8"), builtIn.source);
  });
});

test("copyKit copies library templates and blueprints, preferring the library", async () => {
  await withHome(async (home) => {
    const placement = "# wide quote\ncolumn: 1\nrow: 2\nwidth: 3\nheight: 1\nalign: start\n";
    const blueprint = await fs.readFile(new URL("../examples/blueprint-talk/blueprint.yml", import.meta.url), "utf8");
    await write(home, { "templates/quote.yml": placement, "blueprints/talk.yml": blueprint, "themes/marvel-jarvis.css": "/* mine */\n" });
    const template = await copyKit({ kind: "template", name: "quote", scope: "library" }, "quote_wide");
    assert.equal(await fs.readFile(template.path, "utf8"), placement);
    assert.equal((await readKit(template.ref)).parsed.column, 1);
    const shape = await copyKit({ kind: "blueprint", name: "talk" }, "talk-2");
    assert.equal(await fs.readFile(path.join(home, "blueprints", "talk-2.yml"), "utf8"), blueprint);
    assert.equal(shape.source, blueprint);
    const theme = await copyKit({ kind: "theme", name: "marvel-jarvis" }, "mine-2");
    assert.equal(theme.source, "/* mine */\n", "the library piece wins over the built-in of the same name");
  });
});

test("copyKit passes groups to copyGroup, renaming their templates", async () => {
  await withHome(async (home) => {
    const copied = await copyKit({ kind: "group", name: "marvel_content_guide", scope: "builtin" }, "brand");
    assert.deepEqual(copied.ref, { kind: "group", name: "brand", scope: "library" });
    const source = await fs.readFile(path.join(home, "templates", "brand.yml"), "utf8");
    assert.match(source, /brand_/);
    assert.doesNotMatch(source, /marvel_content_guide_/);
  });
});

test("copyKit refuses taken names, bad names, unknown sources and deck scope", async () => {
  await withHome(async (home) => {
    await write(home, { "themes/taken.css": "/* */\n" });
    await assert.rejects(copyKit({ kind: "theme", name: "marvel-jarvis" }, "taken"), KitExistsError);
    assert.equal(await fs.readFile(path.join(home, "themes", "taken.css"), "utf8"), "/* */\n");
    await assert.rejects(copyKit({ kind: "theme", name: "marvel-jarvis" }, "Bad Name"), { code: "VALIDATION_FAILED" });
    await assert.rejects(copyKit({ kind: "blueprint", name: "nope" }, "x"), KitNotFoundError);
    await assert.rejects(copyKit({ kind: "group", name: "nope" }, "x"), KitNotFoundError);
    await assert.rejects(copyKit({ kind: "blueprint", name: "x", scope: "deck" }, "y"), { code: "VALIDATION_FAILED" });
    assert.deepEqual(await fs.readdir(path.join(home, "themes")), ["taken.css"]);
  });
});
