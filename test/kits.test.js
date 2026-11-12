import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BuiltInReadOnlyError,
  FileConflictError,
  KitExistsError,
  KitInvalidError,
  KitNotFoundError,
  ReservedNameError,
  ValidationError,
  discoverPresentation,
  libraryRoot,
  readKit,
  renderSampleDocument,
  resolveKitPath,
  writeKit
} from "@flipbook-md/core";

async function tempDir(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

let home;
beforeEach(async () => {
  home = await tempDir("flipbook-kits-home-");
  process.env.FLIPBOOK_HOME = home;
});

const THEME = ":root {\n  --accent: #ff0055;\n}\n.slide-body h1 { color: var(--accent); }\n";
const PLACEMENT = "# A quote on the right\ncolumn: 2\nrow: 1\nwidth: 2\nheight: 3\nalign: center\nrole: quote\n";
const BLUEPRINT = "pages:\n  - type: cover\n  - type: point\n    repeat: { min: 1, max: 5 }\ntypes:\n  cover: { template: cover }\n  point: { max_chars: 250 }\n";

test("resolveKitPath maps every kind and scope to its file", () => {
  assert.equal(resolveKitPath({ kind: "theme", name: "dusk", scope: "library" }), path.join(home, "themes/dusk.css"));
  assert.equal(resolveKitPath({ kind: "template", name: "aside", scope: "library" }), path.join(home, "templates/aside.yml"));
  assert.equal(resolveKitPath({ kind: "blueprint", name: "talk", scope: "library" }), path.join(home, "blueprints/talk.yml"));
  assert.equal(resolveKitPath({ kind: "group", name: "brand", scope: "library" }), path.join(home, "templates/brand.yml"));
  assert.equal(resolveKitPath({ kind: "theme", name: "x", scope: "deck", deckDir: "/d" }), "/d/presentation.css");
  assert.equal(resolveKitPath({ kind: "template", name: "x", scope: "deck", deckDir: "/d" }), "/d/templates.yml");
  assert.equal(resolveKitPath({ kind: "blueprint", name: "x", scope: "deck", deckDir: "/d" }), "/d/blueprint.yml");
  assert.equal(resolveKitPath({ kind: "theme", name: "marvel-jarvis", scope: "builtin" }), path.join(libraryRoot(), "themes/marvel-jarvis.css"));
  assert.throws(() => resolveKitPath({ kind: "group", name: "x", scope: "deck", deckDir: "/d" }), ValidationError);
});

test("writeKit creates, then updates with the matching hash, and refuses a stale one", async () => {
  const ref = { kind: "theme", name: "dusk", scope: "library" };
  const created = await writeKit(ref, { source: THEME }, null);
  assert.equal(await fs.readFile(path.join(home, "themes/dusk.css"), "utf8"), THEME);
  await assert.rejects(writeKit(ref, { source: THEME }, null), KitExistsError);

  const changed = THEME.replace("#ff0055", "#00ff88");
  const updated = await writeKit(ref, { source: changed }, created.hash);
  assert.notEqual(updated.hash, created.hash);
  await assert.rejects(writeKit(ref, { source: THEME }, created.hash), FileConflictError);

  const read = await readKit(ref);
  assert.deepEqual([read.source, read.hash, read.builtIn], [changed, updated.hash, false]);
});

test("an invalid YAML kit throws KitInvalidError with the normalizer's message and leaves the file untouched", async () => {
  const ref = { kind: "template", name: "aside", scope: "library" };
  const { hash } = await writeKit(ref, { source: PLACEMENT }, null);
  await assert.rejects(writeKit(ref, { source: PLACEMENT.replace("width: 2", "width: 3") }, hash), (error) => {
    assert.ok(error instanceof KitInvalidError);
    assert.equal(error.code, "KIT_INVALID");
    assert.match(error.message, /leaves the 3x3 grid/);
    return true;
  });
  await assert.rejects(writeKit(ref, { source: "column: [" }, hash), /Not valid YAML/);
  assert.equal(await fs.readFile(path.join(home, "templates/aside.yml"), "utf8"), PLACEMENT);

  const blueprint = { kind: "blueprint", name: "talk", scope: "library" };
  await assert.rejects(writeKit(blueprint, { source: "pages: []\ntypes: {}\n" }, null), /non-empty "pages"/);
  await assert.rejects(writeKit(blueprint, { source: BLUEPRINT.replace("template: cover", "template: nowhere") }, null), KitInvalidError);
  await writeKit(blueprint, { source: BLUEPRINT }, null);
  assert.equal((await readKit(blueprint)).parsed.pages.length, 2);
});

test("comments in a kit file survive because the source is written as sent", async () => {
  const ref = { kind: "template", name: "aside", scope: "library" };
  await writeKit(ref, { source: PLACEMENT }, null);
  assert.match(await fs.readFile(path.join(home, "templates/aside.yml"), "utf8"), /^# A quote on the right/);
});

test("built-ins are read-only, reserved and traversal names are refused", async () => {
  const builtin = { kind: "theme", name: "marvel-jarvis", scope: "builtin" };
  const before = await fs.readFile(resolveKitPath(builtin), "utf8");
  assert.equal((await readKit(builtin)).builtIn, true);
  await assert.rejects(writeKit(builtin, { source: THEME }, null), BuiltInReadOnlyError);
  assert.equal(await fs.readFile(resolveKitPath(builtin), "utf8"), before);

  for (const name of ["flow", "cover", "summary"]) {
    await assert.rejects(writeKit({ kind: "template", name, scope: "library" }, { source: PLACEMENT }, null), ReservedNameError);
  }
  for (const name of ["../x", "a/b", "..", "", "UPPER"]) {
    await assert.rejects(writeKit({ kind: "theme", name, scope: "library" }, { source: THEME }, null), ValidationError);
  }
  assert.deepEqual(await fs.readdir(home), []);
  await assert.rejects(readKit({ kind: "theme", name: "missing", scope: "library" }), KitNotFoundError);
  await assert.rejects(writeKit({ kind: "theme", name: "dusk", scope: "library" }, { patch: {} }, null), /Themes are CSS; send source/);
});

test("deck scope writes presentation.css, templates.yml and blueprint.yml in the deck folder", async () => {
  const deckDir = await tempDir("flipbook-kits-deck-");
  await fs.writeFile(path.join(deckDir, "talk.slide.md"), "# One\n");
  await writeKit({ kind: "theme", name: "presentation", scope: "deck", deckDir }, { source: THEME }, null);
  await writeKit({ kind: "template", name: "templates", scope: "deck", deckDir }, { source: "aside:\n  column: 1\n  row: 1\n  width: 1\n  height: 1\n  align: start\n" }, null);
  // A deck blueprint may name the deck's own templates.
  await writeKit({ kind: "blueprint", name: "blueprint", scope: "deck", deckDir }, { source: BLUEPRINT.replace("template: cover", "template: aside") }, null);
  assert.deepEqual((await fs.readdir(deckDir)).sort(), ["blueprint.yml", "presentation.css", "talk.slide.md", "templates.yml"]);
  await assert.rejects(writeKit({ kind: "theme", name: "x", scope: "deck", deckDir: path.join(deckDir, "..") }, { source: THEME }, "0".repeat(64)), FileConflictError);
});

test("a deck with style: <name> loads the library theme Studio wrote", async () => {
  await writeKit({ kind: "theme", name: "dusk", scope: "library" }, { source: THEME }, null);
  const deckDir = await tempDir("flipbook-kits-style-");
  await fs.writeFile(path.join(deckDir, "talk.slide.md"), "---\ntitle: Talk\nstyle: dusk\n---\n# One\n");
  const deck = await discoverPresentation(path.join(deckDir, "talk.slide.md"));
  assert.match(deck.themeCss, /#ff0055/);
});

test("renderSampleDocument renders all five samples for every built-in theme, without scripts", async () => {
  const themes = (await fs.readdir(path.join(libraryRoot(), "themes"))).filter((name) => name.endsWith(".css"));
  assert.ok(themes.length >= 1);
  for (const name of themes) {
    const { source } = await readKit({ kind: "theme", name: name.slice(0, -4), scope: "builtin" });
    const html = await renderSampleDocument({ themeCss: source });
    assert.deepEqual([...html.matchAll(/data-sample="([^"]+)"/g)].map((match) => match[1]), ["cover", "content", "quote", "media", "callout"]);
    assert.doesNotMatch(html, /<script/i);
  }
});

test("renderSampleDocument drops theme references outside the asset root", async () => {
  const root = await tempDir("flipbook-kits-assets-");
  await fs.writeFile(path.join(root, "dot.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  const html = await renderSampleDocument({
    themeCss: ".a{background:url(../../etc/passwd)}.b{background:url('dot.png')}.c{background:url(https://example.com/x.png)}",
    assetRoot: root
  });
  assert.doesNotMatch(html, /etc\/passwd/);
  assert.match(html, /\.a\{background:none\}/);
  assert.match(html, /\.b\{background:url\("data:image\/png;base64,/);
  assert.match(html, /https:\/\/example\.com\/x\.png/);
});

test("renderSampleDocument matches its structural snapshot and uses kit templates by role", async () => {
  const templates = { aside: { name: "aside", column: 2, row: 1, width: 2, height: 3, align: "center", role: "quote", layout: null, density: null, area: { column: "2 / 4", row: "1 / 4" } } };
  const html = await renderSampleDocument({ themeCss: ":root{--accent:#123456}", templates, canvas: "paper" });
  const structure = [...html.matchAll(/data-sample="([^"]+)"[\s\S]*?<main class="content" data-template="([^"]+)"/g)].map((match) => `${match[1]}:${match[2]}`);
  assert.deepEqual(structure, ["cover:cover", "content:flow", "quote:aside", "media:flow", "callout:flow"]);
  assert.match(html, /#f4efe5/); // paper canvas background
  assert.match(html, /--accent:#123456/);
  assert.equal((html.match(/shadowrootmode="open"/g) ?? []).length, 5);
});

test("renderSampleDocument with a presentation shows its first slides in the draft theme", async () => {
  const deck = await discoverPresentation(path.resolve("examples/blueprint-talk"));
  const html = await renderSampleDocument({ themeCss: ":root{--accent:#abcdef}", presentation: deck, count: 3 });
  assert.equal((html.match(/shadowrootmode="open"/g) ?? []).length, 3);
  assert.match(html, /--accent:#abcdef/);
  assert.ok(html.includes(deck.slides[1].html.trim().slice(0, 40)));
  assert.doesNotMatch(html, /<script/i);
});
