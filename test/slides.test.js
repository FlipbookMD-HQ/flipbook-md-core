import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  FileConflictError,
  ValidationError,
  discoverPresentation,
  readSlide,
  renderExportDocument,
  renderSlideDocument,
  PRESETS,
  updateSlide
} from "@flipbook-md/core";

const examples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../examples");

async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-slides-")));
}

async function folderDeck(slides, extra = "") {
  const root = await tempDir();
  await fs.mkdir(path.join(root, "slides"));
  const names = Object.keys(slides);
  await fs.writeFile(path.join(root, "presentation.yml"), `title: Deck\n${extra}slides:\n${names.map((name) => `  - ${name}\n`).join("")}`);
  for (const [name, body] of Object.entries(slides)) await fs.writeFile(path.join(root, name), body);
  return root;
}

async function singleDeck(text) {
  const root = await tempDir();
  const file = path.join(root, "deck.slide.md");
  await fs.writeFile(file, text);
  return file;
}

/** Changed lines between two texts after removing the common prefix and suffix. */
function changedLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  return { removed: a.slice(start, a.length - end), added: b.slice(start, b.length - end) };
}

async function slideIds(deckPath) {
  if (deckPath.endsWith(".slide.md")) {
    const deck = await discoverPresentation(deckPath);
    return deck.slides.map((_, index) => `#${index}`);
  }
  return parseYaml(await fs.readFile(path.join(deckPath, "presentation.yml"), "utf8")).slides.map((item) => (typeof item === "string" ? item : item.file));
}

async function copyExamples() {
  const root = await tempDir();
  await fs.cp(examples, root, { recursive: true });
  return (await fs.readdir(root)).map((name) => path.join(root, name));
}

// ---------- readSlide ----------

test("readSlide reads fields and where each came from", async () => {
  const root = await folderDeck({
    "slides/01_cover.slide.md": "---\ntemplate: cover\ntitle: Front\nnotes: Say hi.\n---\n# Welcome\n",
    "slides/02_point.slide.md": "<!-- template: summary -->\n<!-- eyebrow: Chapter 1 -->\n# Point\n\nText.\n\n<!-- notes: Remember the demo. -->\n",
    "slides/03.slide.md": "<!-- type: aside -->\n# Aside\n"
  });
  const cover = await readSlide(root, "slides/01_cover.slide.md");
  assert.deepEqual(cover.draft, { markdown: "# Welcome", template: "cover", type: "cover", notes: "Say hi.", title: "Front", directives: {} });
  assert.deepEqual(cover.locations, { template: "frontmatter", type: "filename", title: "frontmatter", notes: "frontmatter", directives: {} });
  assert.match(cover.hash, /^[0-9a-f]{64}$/);

  const point = await readSlide(root, "slides/02_point.slide.md");
  assert.deepEqual(point.draft, { markdown: "# Point\n\nText.", template: "summary", type: "point", notes: "Remember the demo.", title: null, directives: { eyebrow: "Chapter 1" } });
  assert.deepEqual(point.locations, { template: "comment", type: "filename", title: null, notes: "comment", directives: { eyebrow: "comment" } });

  const aside = await readSlide(root, "slides/03.slide.md");
  assert.equal(aside.draft.type, "aside");
  assert.equal(aside.locations.type, "comment");

  await assert.rejects(readSlide(root, "slides/99.slide.md"), { code: "SLIDE_NOT_FOUND" });
});

test("readSlide indexes single-file chunks with #n and keeps --- inside notes in the note", async () => {
  const file = await singleDeck("---\ntitle: Single\n---\n# One\n\n---\n\n# Two\n\n<!-- notes:\nFirst part\n---\nSecond part\n-->\n\n---\n\n<!-- type: outro -->\n# Three\n");
  const two = await readSlide(file, "#1");
  assert.equal(two.draft.markdown, "# Two");
  assert.equal(two.draft.notes, "First part\n---\nSecond part");
  const three = await readSlide(file, "#2");
  assert.equal(three.draft.markdown, "# Three");
  assert.equal(three.draft.type, "outro");
  assert.equal(three.draft.title, null);
  await assert.rejects(readSlide(file, "#3"), { code: "SLIDE_NOT_FOUND" });
  await assert.rejects(readSlide(file, "slides/x.slide.md"), { code: "SLIDE_NOT_FOUND" });
});

// ---------- updateSlide: golden round trips ----------

test("for every slide of every example deck, an unchanged draft leaves the file byte-for-byte identical", async () => {
  let checked = 0;
  for (const deckPath of await copyExamples()) {
    for (const slideId of await slideIds(deckPath)) {
      const before = await fs.readFile((await readSlide(deckPath, slideId)).file);
      const { draft, hash } = await readSlide(deckPath, slideId);
      const result = await updateSlide(deckPath, slideId, draft, hash);
      assert.equal(result.slideId, slideId);
      const after = await fs.readFile((await readSlide(deckPath, slideId)).file);
      assert.ok(before.equals(after), `${path.basename(deckPath)} ${slideId} changed`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `checked ${checked} slides`);
});

test("changing only the template changes exactly one line in every example slide", async () => {
  for (const deckPath of await copyExamples()) {
    for (const slideId of await slideIds(deckPath)) {
      const { draft, hash, file } = await readSlide(deckPath, slideId);
      const before = await fs.readFile(file, "utf8");
      const template = draft.template === "summary" ? "cover" : "summary";
      await updateSlide(deckPath, slideId, { ...draft, template }, hash);
      const after = await fs.readFile(file, "utf8");
      const { removed, added } = changedLines(before, after);
      assert.ok(removed.length <= 1 && added.length === 1, `${path.basename(deckPath)} ${slideId}: -${removed.length} +${added.length}`);
      assert.match(added[0], new RegExp(`template: ${template}`));
      assert.equal((await readSlide(deckPath, slideId)).draft.template, template);
    }
  }
});

test("edits keep CRLF, the BOM and a missing trailing newline", async () => {
  const root = await folderDeck({
    "slides/01_crlf.slide.md": "---\r\ntitle: Win\r\n---\r\n# CRLF\r\n\r\nBody.\r\n",
    "slides/02_bom.slide.md": "﻿# BOM\n\nBody.\n",
    "slides/03_bare.slide.md": "# Bare\n\nNo newline at the end"
  });
  for (const id of ["slides/01_crlf.slide.md", "slides/02_bom.slide.md", "slides/03_bare.slide.md"]) {
    const { draft, hash } = await readSlide(root, id);
    await updateSlide(root, id, { ...draft, markdown: `${draft.markdown}\n\nAdded.` }, hash);
  }
  assert.equal(await fs.readFile(path.join(root, "slides/01_crlf.slide.md"), "utf8"), "---\r\ntitle: Win\r\n---\r\n# CRLF\r\n\r\nBody.\r\n\r\nAdded.\r\n");
  assert.equal(await fs.readFile(path.join(root, "slides/02_bom.slide.md"), "utf8"), "﻿# BOM\n\nBody.\n\nAdded.\n");
  assert.equal(await fs.readFile(path.join(root, "slides/03_bare.slide.md"), "utf8"), "# Bare\n\nNo newline at the end\n\nAdded.");
});

test("round-trips a frontmatter-only slide, an empty body and a code fence with ---", async () => {
  const slides = {
    "slides/01_meta.slide.md": "---\ntitle: Only meta\ntemplate: cover\n---\n",
    "slides/02_empty.slide.md": "",
    "slides/03_code.slide.md": "# Code\n\n```yaml\n---\nkey: value\n---\n```\n"
  };
  const root = await folderDeck(slides);
  for (const id of Object.keys(slides)) {
    const { draft, hash } = await readSlide(root, id);
    await updateSlide(root, id, draft, hash);
    assert.equal(await fs.readFile(path.join(root, id), "utf8"), slides[id], id);
  }
  const code = await readSlide(root, "slides/03_code.slide.md");
  assert.equal(code.draft.markdown, "# Code\n\n```yaml\n---\nkey: value\n---\n```");

  const empty = await readSlide(root, "slides/02_empty.slide.md");
  await updateSlide(root, "slides/02_empty.slide.md", { ...empty.draft, markdown: "# Filled" }, empty.hash);
  assert.equal(await fs.readFile(path.join(root, "slides/02_empty.slide.md"), "utf8"), "# Filled\n");

  const meta = await readSlide(root, "slides/01_meta.slide.md");
  await updateSlide(root, "slides/01_meta.slide.md", { ...meta.draft, markdown: "# Body" }, meta.hash);
  assert.equal(await fs.readFile(path.join(root, "slides/01_meta.slide.md"), "utf8"), "---\ntitle: Only meta\ntemplate: cover\n---\n# Body\n");
});

test("a stale baseHash throws FileConflictError with the current hash", async () => {
  const root = await folderDeck({ "slides/01_a.slide.md": "# A\n" });
  const { draft, hash } = await readSlide(root, "slides/01_a.slide.md");
  await fs.writeFile(path.join(root, "slides/01_a.slide.md"), "# Edited elsewhere\n");
  await assert.rejects(updateSlide(root, "slides/01_a.slide.md", { ...draft, markdown: "# Mine" }, hash), (error) => {
    assert.ok(error instanceof FileConflictError);
    assert.notEqual(error.currentHash, hash);
    return true;
  });
  assert.equal(await fs.readFile(path.join(root, "slides/01_a.slide.md"), "utf8"), "# Edited elsewhere\n");
});

// ---------- updateSlide: where fields go ----------

test("fields are updated where they live; new fields become directive comments", async () => {
  const root = await folderDeck({
    "slides/01_a.slide.md": "---\ntitle: A # keep this comment\nnotes: Old notes.\n---\n# A\n",
    "slides/02_b.slide.md": "<!-- template:   cover   -->\n# B\n\n<!-- notes:\nLine one\nLine two\n-->\n",
    "slides/03_c.slide.md": "# C\n"
  });
  let slide = await readSlide(root, "slides/01_a.slide.md");
  await updateSlide(root, "slides/01_a.slide.md", { ...slide.draft, title: "Alpha", notes: "New notes." }, slide.hash);
  assert.equal(await fs.readFile(path.join(root, "slides/01_a.slide.md"), "utf8"), "---\ntitle: Alpha # keep this comment\nnotes: New notes.\n---\n# A\n");

  slide = await readSlide(root, "slides/02_b.slide.md");
  await updateSlide(root, "slides/02_b.slide.md", { ...slide.draft, template: "summary", notes: "Only line" }, slide.hash);
  assert.equal(await fs.readFile(path.join(root, "slides/02_b.slide.md"), "utf8"), "<!-- template:   summary   -->\n# B\n\n<!-- notes:\nOnly line\n-->\n");

  slide = await readSlide(root, "slides/03_c.slide.md");
  await updateSlide(root, "slides/03_c.slide.md", { ...slide.draft, template: "cover", notes: "Hello", directives: { eyebrow: "Intro" } }, slide.hash);
  assert.equal(await fs.readFile(path.join(root, "slides/03_c.slide.md"), "utf8"), "<!-- eyebrow: Intro -->\n<!-- template: cover -->\n# C\n\n<!-- notes:\nHello\n-->\n");

  slide = await readSlide(root, "slides/03_c.slide.md");
  await updateSlide(root, "slides/03_c.slide.md", { ...slide.draft, template: null, notes: "", directives: {} }, slide.hash);
  assert.equal(await fs.readFile(path.join(root, "slides/03_c.slide.md"), "utf8"), "# C\n");
});

test("changing a type that came from the filename renames the file and updates the manifest", async () => {
  const root = await folderDeck({ "slides/01_intro.slide.md": "# Intro\n", "slides/02_point.slide.md": "# Point\n" }, "# The slide list\n");
  const manifestBefore = await fs.readFile(path.join(root, "presentation.yml"), "utf8");
  const { draft, hash } = await readSlide(root, "slides/02_point.slide.md");
  const result = await updateSlide(root, "slides/02_point.slide.md", { ...draft, type: "aside" }, hash);
  assert.equal(result.slideId, "slides/02_aside.slide.md");
  assert.deepEqual(Object.keys(result.hashes).sort(), ["presentation.yml", "slides/02_aside.slide.md"]);
  assert.equal(await fs.readFile(path.join(root, "slides/02_aside.slide.md"), "utf8"), "# Point\n");
  await assert.rejects(fs.access(path.join(root, "slides/02_point.slide.md")));
  assert.equal(await fs.readFile(path.join(root, "presentation.yml"), "utf8"), manifestBefore.replace("02_point", "02_aside"));
  const deck = await discoverPresentation(root);
  assert.deepEqual(deck.slides.map((slide) => slide.type), ["intro", "aside"]);
});

test("in a single-file deck only the target chunk changes", async () => {
  const text = "---\ntitle: Single\n---\n\n# One\n\n---\n\n# Two\n\n---\n\n# Three\n";
  const file = await singleDeck(text);
  const { draft, hash } = await readSlide(file, "#1");
  const result = await updateSlide(file, "#1", { ...draft, markdown: "# Two, edited", template: "summary" }, hash);
  assert.equal(await fs.readFile(file, "utf8"), "---\ntitle: Single\n---\n\n# One\n\n---\n\n<!-- template: summary -->\n# Two, edited\n\n---\n\n# Three\n");
  assert.deepEqual(Object.keys(result.hashes), ["deck.slide.md"]);
  const again = await readSlide(file, "#1");
  await assert.rejects(updateSlide(file, "#1", { ...again.draft, markdown: "# A\n\n---\n\n# B" }, again.hash), { field: "markdown" });
  await assert.rejects(updateSlide(file, "#1", { ...again.draft, title: "Nope" }, again.hash), { field: "title" });
});

test("invalid drafts throw ValidationError naming the field", async () => {
  const root = await folderDeck({ "slides/01_a.slide.md": "# A\n" });
  const { draft, hash } = await readSlide(root, "slides/01_a.slide.md");
  for (const [change, field] of [
    [{ template: "nope" }, "template"],
    [{ type: "Bad Type" }, "type"],
    [{ notes: "a --> b" }, "notes"],
    [{ markdown: "<!-- template: cover -->\n# A" }, "markdown"],
    [{ directives: { "Bad Key": "x" } }, "directives.Bad Key"]
  ]) {
    await assert.rejects(updateSlide(root, "slides/01_a.slide.md", { ...draft, ...change }, hash), (error) => {
      assert.ok(error instanceof ValidationError, JSON.stringify(change));
      assert.equal(error.field, field);
      return true;
    });
  }
  assert.equal(await fs.readFile(path.join(root, "slides/01_a.slide.md"), "utf8"), "# A\n");
});

test("a saved template renders the same through the loader", async () => {
  const root = await folderDeck({ "slides/01_a.slide.md": "# A\n", "slides/02_b.slide.md": "# B\n" });
  const { draft, hash } = await readSlide(root, "slides/02_b.slide.md");
  await updateSlide(root, "slides/02_b.slide.md", { ...draft, template: "summary" }, hash);
  const deck = await discoverPresentation(root);
  assert.equal(deck.slides[1].template, "summary");
});

// ---------- renderSlideDocument ----------

function exportPayload(html) {
  return JSON.parse(/innerHTML=(".*?");<\/script>/s.exec(html)[1]);
}

function previewPayload(html) {
  return /<template shadowrootmode="open">([\s\S]*)<\/template><\/div><\/body>/.exec(html)[1];
}

test("renderSlideDocument matches renderExportDocument for every example slide and has no script", async () => {
  for (const name of await fs.readdir(examples)) {
    const deck = await discoverPresentation(path.join(examples, name));
    for (const [index, slide] of deck.slides.entries()) {
      const exported = await renderExportDocument(deck, slide, index, PRESETS.instagram);
      const preview = await renderSlideDocument(deck, index);
      assert.doesNotMatch(preview, /<script/i);
      assert.equal(previewPayload(preview), exportPayload(exported), `${name} slide ${index + 1}`);
    }
  }
});

test("renderSlideDocument renders a draft, strips scripts and rejects unknown templates", async () => {
  const deck = await discoverPresentation(path.join(examples, "blueprint-talk"));
  const draft = { markdown: "# Drafted\n\n<script>window.pwned = true</script>\n\nSafe text.", template: "summary", type: "point", notes: "", title: null, directives: {} };
  const html = await renderSlideDocument(deck, 1, { draft });
  assert.match(html, /<h1[^>]*>Drafted<\/h1>/);
  assert.match(html, /data-template="summary"/);
  assert.doesNotMatch(html, /<script|pwned/i);
  await assert.rejects(renderSlideDocument(deck, 1, { draft: { ...draft, template: "nope" } }), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.field, "template");
    return true;
  });
  await assert.rejects(renderSlideDocument(deck, 99), { code: "SLIDE_NOT_FOUND" });
});

test("renderSlideDocument points deck files at assetBase instead of inlining them", async () => {
  const root = await folderDeck({ "slides/01_a.slide.md": "# A\n\n![logo](../assets/logo.svg)\n" });
  await fs.mkdir(path.join(root, "assets"));
  await fs.writeFile(path.join(root, "assets/logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const deck = await discoverPresentation(root);
  const inlined = await renderSlideDocument(deck, 0);
  assert.match(inlined, /src="data:image\/svg\+xml;base64,/);
  const linked = await renderSlideDocument(deck, 0, { assetBase: "/api/decks/abc/files/" });
  assert.match(linked, /src="\/api\/decks\/abc\/files\/assets\/logo\.svg"/);
});
