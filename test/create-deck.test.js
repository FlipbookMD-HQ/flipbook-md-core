import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DeckExistsError, KitNotFoundError, ValidationError, createDeck, discoverPresentation, evaluateBlueprint, loadGroup, normalizeBlueprint, pageTypeFromFilename } from "@flipbook-md/core";

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-create-")));
}

async function withHome(files, fn) {
  const previous = process.env.FLIPBOOK_HOME;
  const home = await tempRoot();
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(home, name)), { recursive: true });
    await fs.writeFile(path.join(home, name), body);
  }
  process.env.FLIPBOOK_HOME = home;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.FLIPBOOK_HOME;
    else process.env.FLIPBOOK_HOME = previous;
  }
}

// Evaluates the blueprint against the slide files as written, independent of the loader.
async function evaluate(deckPath, group) {
  const deck = await discoverPresentation(deckPath);
  const manifest = parseYaml(await fs.readFile(path.join(deckPath, "presentation.yml"), "utf8"));
  const slides = await Promise.all(manifest.slides.map(async (source) => ({
    source,
    type: pageTypeFromFilename(source),
    markdown: await fs.readFile(path.join(deckPath, source), "utf8"),
    template: "flow",
    templateExplicit: false
  })));
  const kit = await loadGroup(group);
  return { deck, violations: evaluateBlueprint({ slides }, normalizeBlueprint(kit.blueprint, kit.templates)) };
}

test("a blank folder deck has presentation.yml and one slide, and loads", async () => withHome({}, async () => {
  const root = await tempRoot();
  const { path: deckPath } = await createDeck(root, { name: "my-talk", title: "My talk", kind: "folder", group: null });
  assert.equal(deckPath, path.join(root, "my-talk"));
  const manifest = parseYaml(await fs.readFile(path.join(deckPath, "presentation.yml"), "utf8"));
  assert.deepEqual(manifest, { title: "My talk", slides: ["slides/01_slide.slide.md"] });
  const deck = await discoverPresentation(deckPath);
  assert.equal(deck.title, "My talk");
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.slides[0].title, "My talk");
}));

test("a blank single-file deck has frontmatter and one slide, and loads", async () => withHome({}, async () => {
  const root = await tempRoot();
  const { path: file } = await createDeck(root, { name: "notes", title: "Notes: a \"quoted\" title", kind: "single" });
  assert.equal(file, path.join(root, "notes.slide.md"));
  const deck = await discoverPresentation(file);
  assert.equal(deck.title, "Notes: a \"quoted\" title");
  assert.equal(deck.slides.length, 1);
}));

test("a folder deck from marvel_content_guide gets one placeholder per required step and passes its blueprint", async () => withHome({}, async () => {
  const root = await tempRoot();
  const { path: deckPath } = await createDeck(root, { name: "guide", title: "Guide", kind: "folder", group: "marvel_content_guide" });
  const manifest = parseYaml(await fs.readFile(path.join(deckPath, "presentation.yml"), "utf8"));
  assert.equal(manifest.group, "marvel_content_guide");
  // cover is required once; timeline has repeat.min 0.
  assert.deepEqual(manifest.slides, ["slides/01_cover.slide.md"]);
  const { deck, violations } = await evaluate(deckPath, "marvel_content_guide");
  assert.equal(deck.group, "marvel_content_guide");
  assert.equal(deck.slides[0].type, "cover");
  assert.equal(deck.slides[0].template, "marvel_content_guide_cover");
  assert.deepEqual(violations, []);
}));

test("every built-in kit makes a valid deck of both kinds", async () => withHome({}, async () => {
  for (const group of ["marvel_content_guide", "marvel_content_character", "marvel_content_item", "marvel_content_place"]) {
    for (const kind of ["folder", "single"]) {
      const root = await tempRoot();
      const { path: deckPath } = await createDeck(root, { name: "deck", title: `A ${group} deck`, kind, group });
      const deck = await discoverPresentation(deckPath); // Throws BlueprintError on any violation.
      assert.ok(deck.slides.length >= 1, `${group} ${kind}`);
      assert.equal(deck.group, group);
    }
  }
}));

test("required steps repeat min times, any: steps use their first type, and a kit with no required step gets one slide", async () => withHome({
  "templates/demo_kit.yml": `name: demo_kit
themes: [marvel-jarvis]
style: marvel-jarvis
templates: {}
blueprint:
  pages:
    - type: intro
    - any: [point, aside]
      repeat: { min: 2, max: 4 }
    - type: outro
      repeat: { min: 0, max: 1 }
  types:
    intro: { require: [heading], max_chars: 40 }
    point: { allow: [heading, list], require: [list], max_items: 1 }
    aside: { allow: [blockquote] }
    outro: {}
`,
  "templates/open_kit.yml": `name: open_kit
themes: [marvel-jarvis]
style: marvel-jarvis
templates: {}
blueprint:
  pages:
    - type: note
      repeat: { min: 0, max: 3 }
  types:
    note: { allow: [paragraph] }
`
}, async () => {
  const root = await tempRoot();
  const long = "A title that is much longer than the forty characters this intro allows";
  const { path: demo } = await createDeck(root, { name: "demo", title: long, kind: "folder", group: "demo_kit" });
  const manifest = parseYaml(await fs.readFile(path.join(demo, "presentation.yml"), "utf8"));
  assert.deepEqual(manifest.slides, ["slides/01_intro.slide.md", "slides/02_point.slide.md", "slides/03_point.slide.md"]);
  const deck = await discoverPresentation(demo);
  assert.deepEqual(deck.slides.map((slide) => slide.type), ["intro", "point", "point"]);

  const { path: open } = await createDeck(root, { name: "open", title: "Open", kind: "single", group: "open_kit" });
  const openDeck = await discoverPresentation(open);
  assert.deepEqual(openDeck.slides.map((slide) => slide.type), ["note"]);
}));

test("an existing name is refused, including one that differs only in case, and nothing is overwritten", async () => withHome({}, async () => {
  const root = await tempRoot();
  await createDeck(root, { name: "talk", title: "Talk", kind: "folder" });
  const before = await fs.readFile(path.join(root, "talk", "presentation.yml"), "utf8");
  await assert.rejects(createDeck(root, { name: "talk", title: "Again", kind: "folder" }), DeckExistsError);
  await fs.mkdir(path.join(root, "Shout"));
  await assert.rejects(createDeck(root, { name: "shout", title: "Shout", kind: "folder" }), { code: "DECK_EXISTS" });
  await fs.writeFile(path.join(root, "Single.slide.md"), "# keep\n");
  await assert.rejects(createDeck(root, { name: "single", title: "S", kind: "single" }), DeckExistsError);
  assert.equal(await fs.readFile(path.join(root, "talk", "presentation.yml"), "utf8"), before);
  assert.equal(await fs.readFile(path.join(root, "Single.slide.md"), "utf8"), "# keep\n");
}));

test("invalid fields and unknown kits are refused before anything is written", async () => withHome({}, async () => {
  const root = await tempRoot();
  await assert.rejects(createDeck(root, { name: "Bad Name", title: "", kind: "deck" }), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(error.fields.map((field) => field.path), ["name", "title", "kind"]);
    return true;
  });
  await assert.rejects(createDeck(root, { name: "x".repeat(61), title: "T", kind: "folder" }), ValidationError);
  await assert.rejects(createDeck(root, { name: "kit", title: "T", kind: "folder", group: "no_such_kit" }), (error) => {
    assert.ok(error instanceof KitNotFoundError);
    assert.equal(error.code, "KIT_NOT_FOUND");
    return true;
  });
  assert.deepEqual(await fs.readdir(root), []);
}));
