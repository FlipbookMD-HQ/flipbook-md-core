import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DeckExistsError, KitNotFoundError, ValidationError, discoverPresentation, importDeck, measureMarkdown, sourceToSlides } from "@flipbook-md/core";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 40, 0, 0, 0, 30, 8, 6, 0, 0, 0])]);

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-import-")));
}

const bodies = (result) => result.slides.map((slide) => slide.markdown);

// sourceToSlides (US-18 · 1.1.1)

test("a title, an intro and three sections give a cover and three slides with the words kept", () => {
  const result = sourceToSlides("# Indexes\n\nWhy they matter.\n\n## One\n\nFirst **point**.\n\n## Two\n\n- a\n- b\n\n## Three\n\nLast.\n");
  assert.equal(result.title, "Indexes");
  assert.equal(result.sections, 3);
  assert.deepEqual(bodies(result), [
    "# Indexes\n\nWhy they matter.\n",
    "# One\n\nFirst **point**.\n",
    "# Two\n\n- a\n- b\n",
    "# Three\n\nLast.\n"
  ]);
  assert.deepEqual(result.dropped, []);
});

test("--- lines are boundaries and never appear in a slide", () => {
  const result = sourceToSlides("# T\n\n## A\n\nOne.\n\n---\n\nTwo.\n\n---\n\n---\n\n## B\n\nThree.\n");
  assert.deepEqual(bodies(result), ["# T\n", "# A\n\nOne.\n", "Two.\n", "# B\n\nThree.\n"]);
  for (const body of bodies(result)) assert.doesNotMatch(body, /^---$/m);
  assert.equal(result.sections, 3);
});

test("the title falls back to frontmatter, then the option, then Untitled", () => {
  assert.equal(sourceToSlides("---\ntitle: From front\n---\n## A\n\nx\n").title, "From front");
  assert.equal(sourceToSlides("## A\n\nx\n", { title: "notes" }).title, "notes");
  assert.equal(sourceToSlides("Just text.\n").title, "Untitled");
  // Frontmatter is stripped from the slides.
  assert.doesNotMatch(bodies(sourceToSlides("---\ntitle: F\n---\n## A\n\nx\n")).join(""), /title: F/);
});

test("a short intro sits on the cover; a long one gets its own slide titled with the deck title", () => {
  const short = sourceToSlides("# T\n\nShort.\n\n## A\n\nx\n");
  assert.equal(bodies(short)[0], "# T\n\nShort.\n");
  const long = "word ".repeat(80).trim();
  const result = sourceToSlides(`# T\n\n${long}\n\n## A\n\nx\n`);
  assert.equal(bodies(result)[0], "# T\n");
  assert.equal(bodies(result)[1], `# T\n\n${long}\n`);
});

test("text with no headings becomes a cover and paragraph slides split at 700 characters", () => {
  const paragraph = "lorem ipsum dolor ".repeat(15).trim();
  const result = sourceToSlides(Array.from({ length: 6 }, () => paragraph).join("\n\n"), { title: "notes" });
  assert.equal(bodies(result)[0], "# notes\n");
  for (const body of bodies(result).slice(1)) assert.ok(measureMarkdown(body).chars <= 700 + "notes (9)".length, body);
  assert.match(bodies(result)[2], /^# notes \(2\)/);
  const words = bodies(result).slice(1).join("").match(/lorem/g).length;
  assert.equal(words, 6 * 15);
});

test("a 20-item list splits into three slides with no item lost or duplicated", () => {
  const items = Array.from({ length: 20 }, (_, index) => `- item ${index + 1}`).join("\n");
  const result = sourceToSlides(`# T\n\n## List\n\n${items}\n`);
  const slides = bodies(result).slice(1);
  assert.equal(slides.length, 3);
  assert.deepEqual(slides.map((body) => body.split("\n")[0]), ["# List", "# List (2)", "# List (3)"]);
  const found = slides.join("\n").match(/item \d+/g);
  assert.deepEqual(found, Array.from({ length: 20 }, (_, index) => `item ${index + 1}`));
});

test("a code fence is never split, even when it alone is over 700 characters", () => {
  const code = Array.from({ length: 40 }, (_, index) => `const value${index} = ${index};`).join("\n");
  const result = sourceToSlides(`# T\n\n## Code\n\nBefore.\n\n\`\`\`js\n${code}\n---\n\`\`\`\n`);
  const fence = bodies(result).find((body) => body.includes("```js"));
  assert.ok(fence.includes(code) && fence.includes("\n---\n"));
});

test("#### headings become bold lines and ### stays", () => {
  const result = sourceToSlides("# T\n\n## A\n\n### Left\n\n- x\n\n#### Deep\n\ntext\n");
  assert.equal(bodies(result)[1], "# A\n\n### Left\n\n- x\n\n**Deep**\n\ntext\n");
});

test("raw HTML and relative images are removed and counted; https images are kept", () => {
  const result = sourceToSlides("# T\n\n## A\n\n<div>block</div>\n\nSee ![a](pics/a.png) and ![b](https://x.test/b.png) <span>here</span>.\n");
  const body = bodies(result)[1];
  assert.doesNotMatch(body, /<div>|<span>|pics\/a\.png/);
  assert.match(body, /!\[b\]\(https:\/\/x\.test\/b\.png\)/);
  assert.deepEqual(result.dropped.find((entry) => entry.kind === "relative-image"), { kind: "relative-image", reason: "not-uploaded", count: 1, detail: "pics/a.png" });
  assert.ok(result.dropped.find((entry) => entry.kind === "html").count >= 2);
});

test("mapped images are rewritten, and images mapped to null are dropped without a count", () => {
  const result = sourceToSlides("# T\n\n![one](image1.png)\n\n![two](image2.emf)\n", { images: { "image1.png": "assets/image1.png", "image2.emf": null } });
  assert.match(bodies(result)[0], /!\[one\]\(assets\/image1\.png\)/);
  assert.doesNotMatch(bodies(result)[0], /image2/);
  assert.deepEqual(result.dropped, []);
});

test("an existing single-file deck is read as sections", () => {
  const result = sourceToSlides("---\ntitle: Old deck\ntheme: paper\n---\n<!-- type: cover -->\n# Old deck\n\n---\n\n<!-- type: development -->\n# Part\n\n- x\n");
  assert.equal(result.title, "Old deck");
  assert.deepEqual(bodies(result), ["# Old deck\n", "# Part\n\n- x\n"]);
});

test("non-Latin text and a BOM are kept as written", () => {
  const result = sourceToSlides("﻿# Índices\n\n## Почему\n\n- 索引は速い\n");
  assert.equal(result.title, "Índices");
  assert.equal(bodies(result)[1], "# Почему\n\n- 索引は速い\n");
});

test("an empty or whitespace-only document throws ValidationError", () => {
  assert.throws(() => sourceToSlides(""), ValidationError);
  assert.throws(() => sourceToSlides(" \n\n \t"), ValidationError);
  assert.throws(() => sourceToSlides("---\ntitle: x\n---\n"), ValidationError);
});

// importDeck (US-18 · 1.1.2)

test("importDeck writes a folder deck that the loader accepts", async () => {
  const root = await tempRoot();
  const result = await importDeck(root, { name: "indexes", title: "Database indexes", markdown: "# Indexes\n\nIntro.\n\n## Why\n\n- fast\n\n## Cost\n\n- writes\n" });
  assert.equal(result.path, path.join(root, "indexes"));
  assert.equal(result.slides, 3);
  const manifest = parseYaml(await fs.readFile(path.join(root, "indexes", "presentation.yml"), "utf8"));
  assert.equal(manifest.title, "Database indexes");
  assert.deepEqual(manifest.slides, ["slides/01-indexes.slide.md", "slides/02-why.slide.md", "slides/03-cost.slide.md"]);
  const deck = await discoverPresentation(result.path);
  assert.equal(deck.slides.length, 3);
  assert.deepEqual(deck.slides.map((slide) => slide.type), [null, null, null]);
});

test("importDeck stores images under unique names and points each slide at the right one", async () => {
  const root = await tempRoot();
  const markdown = "# T\n\n## A\n\n![first](image1.png)\n\n## B\n\n![second](Image1.PNG)\n";
  const result = await importDeck(root, {
    name: "pics",
    title: "Pics",
    markdown,
    images: [
      { fileName: "image1.png", bytes: PNG },
      { fileName: "Image1.PNG", bytes: PNG }
    ]
  });
  assert.deepEqual(result.assets, ["assets/image1.png", "assets/image1-2.png"]);
  const a = await fs.readFile(path.join(result.path, "slides", "02-a.slide.md"), "utf8");
  const b = await fs.readFile(path.join(result.path, "slides", "03-b.slide.md"), "utf8");
  assert.match(a, /!\[first\]\(assets\/image1\.png\)/);
  assert.match(b, /!\[second\]\(assets\/image1-2\.png\)/);
  const deck = await discoverPresentation(result.path);
  assert.match(deck.slides[1].html, /image1\.png/);
});

test("importDeck drops images that fail the asset check and lists them", async () => {
  const root = await tempRoot();
  const result = await importDeck(root, {
    name: "bad-images",
    title: "Bad",
    markdown: "# T\n\n![bmp](image1.bmp)\n\n![fake](image2.png)\n\ntext\n",
    images: [
      { fileName: "image1.bmp", bytes: Buffer.from("BM....") },
      { fileName: "image2.png", bytes: Buffer.from("<html>") }
    ]
  });
  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.dropped, [
    { kind: "image", reason: "type", count: 1, detail: "BMP" },
    { kind: "image", reason: "type", count: 1, detail: "PNG" }
  ]);
  const cover = await fs.readFile(path.join(result.path, "slides", "01-t.slide.md"), "utf8");
  assert.doesNotMatch(cover, /image1|image2/);
  await assert.rejects(() => fs.access(path.join(result.path, "assets", "image2.png")));
});

test("importDeck with a kit sets group, adds no placeholders, and reports violations", async () => {
  const root = await tempRoot();
  const result = await importDeck(root, { name: "kit-deck", title: "Kit", group: "marvel_content_guide", markdown: "# T\n\n## A\n\nx\n" });
  const manifest = parseYaml(await fs.readFile(path.join(result.path, "presentation.yml"), "utf8"));
  assert.equal(manifest.group, "marvel_content_guide");
  assert.equal(manifest.slides.length, 2);
  const deck = await discoverPresentation(result.path, { blueprint: "evaluate" });
  assert.ok(deck.violations.some((violation) => violation.code === "MISSING_TYPE"));
});

test("importDeck refuses a taken name, a symlink in the way, an unknown kit and an empty document", async () => {
  const root = await tempRoot();
  await fs.mkdir(path.join(root, "Taken"));
  await assert.rejects(() => importDeck(root, { name: "taken", title: "T", markdown: "# T\n" }), DeckExistsError);
  const outside = await tempRoot();
  await fs.symlink(outside, path.join(root, "linked"));
  await assert.rejects(() => importDeck(root, { name: "linked", title: "T", markdown: "# T\n" }), DeckExistsError);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(() => importDeck(root, { name: "kitless", title: "T", group: "no_such_kit", markdown: "# T\n" }), KitNotFoundError);
  await assert.rejects(() => importDeck(root, { name: "empty", title: "T", markdown: "  \n" }), ValidationError);
  await assert.rejects(() => importDeck(root, { name: "Bad Name", title: "T", markdown: "# T\n" }), ValidationError);
  assert.deepEqual((await fs.readdir(root)).sort(), ["Taken", "linked"]);
});

test("importDeck removes the whole folder when a write fails", async () => {
  const root = await tempRoot();
  // A non-Buffer image payload makes writeDeckAsset throw a TypeError partway through.
  await assert.rejects(() => importDeck(root, { name: "broken", title: "T", markdown: "# T\n", images: [{ fileName: "a.png", bytes: PNG }, { fileName: "b.png", bytes: 42 }] }));
  assert.deepEqual(await fs.readdir(root), []);
});
