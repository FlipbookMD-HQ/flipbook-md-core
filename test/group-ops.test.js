import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import {
  BuiltInReadOnlyError,
  KitExistsError,
  copyGroup,
  discoverPresentation,
  findDecksUsingGroup,
  normalizeGroup,
  readKit,
  renameGroup,
  renderSampleDocument
} from "@flipbook-md/core";

let home;
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-groups-")));
  process.env.FLIPBOOK_HOME = home;
});

const BUILT_IN = ["marvel_content_character", "marvel_content_guide", "marvel_content_item", "marvel_content_place"];

test("copying a built-in group renames its prefixes, keeps comments, and a deck can use it", async () => {
  const builtIn = await readKit({ kind: "group", name: "marvel_content_character", scope: "builtin" });
  const copied = await copyGroup({ name: "marvel_content_character", scope: "builtin" }, "my_kit");
  assert.equal(copied.path, path.join(home, "templates/my_kit.yml"));
  const parsed = parse(copied.source);
  const group = normalizeGroup(parsed, "my_kit");
  assert.ok(Object.keys(group.templates).length > 0);
  assert.ok(Object.keys(group.templates).every((name) => name.startsWith("my_kit_")));
  for (const rules of Object.values(parsed.blueprint.types)) {
    if (rules.template) assert.match(rules.template, /^(my_kit_|flow$|cover$|summary$)/);
  }
  // Only the renamed tokens differ.
  assert.equal(copied.source, builtIn.source.replaceAll("marvel_content_character", "my_kit"));
  // The built-in is untouched.
  assert.equal((await readKit({ kind: "group", name: "marvel_content_character", scope: "builtin" })).hash, builtIn.hash);

  const deck = path.join(home, "deck");
  await fs.mkdir(path.join(deck, "slides"), { recursive: true });
  await fs.writeFile(path.join(deck, "presentation.yml"), "title: Kit deck\ngroup: my_kit\nslides:\n  - slides/01.slide.md\n");
  await fs.writeFile(path.join(deck, "slides/01.slide.md"), "# Hello\n");
  const presentation = await discoverPresentation(deck, { blueprint: "evaluate" });
  assert.equal(presentation.group, "my_kit");
  assert.ok(Object.keys(presentation.templates).some((name) => name.startsWith("my_kit_")));
});

test("copying onto an existing name throws KitExistsError and keeps the file", async () => {
  await copyGroup({ name: "marvel_content_guide", scope: "builtin" }, "taken");
  const before = await fs.readFile(path.join(home, "templates/taken.yml"), "utf8");
  await assert.rejects(copyGroup({ name: "marvel_content_item", scope: "builtin" }, "taken"), KitExistsError);
  assert.equal(await fs.readFile(path.join(home, "templates/taken.yml"), "utf8"), before);
});

test("renaming rewrites prefixes and blueprint references, removes the old file, and finds decks using it", async () => {
  const source = `# My kit
name: brand
description: Mine
style: marvel-jarvis
canvas: midnight
themes: [marvel-jarvis]
templates:
  # The big cover
  brand_cover:
    column: 1
    row: 1
    width: 3
    height: 3
    align: center
    role: cover
blueprint:
  pages:
    - type: cover
  types:
    cover:
      template: brand_cover
`;
  await fs.mkdir(path.join(home, "templates"), { recursive: true });
  await fs.writeFile(path.join(home, "templates/brand.yml"), source);
  const { hash } = await readKit({ kind: "group", name: "brand", scope: "library" });

  const folder = path.join(home, "a");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "presentation.yml"), "title: A\ngroup: brand\nslides: []\n");
  await fs.writeFile(path.join(home, "b.slide.md"), "---\ntitle: B\ngroup: brand\n---\n# B\n");
  await fs.writeFile(path.join(home, "c.slide.md"), "---\ntitle: C\ngroup: other\n---\n# C\n");
  const decks = [folder, path.join(home, "b.slide.md"), path.join(home, "c.slide.md"), path.join(home, "missing")];
  assert.deepEqual(await findDecksUsingGroup("brand", decks), decks.slice(0, 2));

  const renamed = await renameGroup({ name: "brand", scope: "library" }, "studio_brand", hash);
  assert.equal(renamed.source, source.replace("name: brand", "name: studio_brand").replaceAll("brand_cover", "studio_brand_cover"));
  assert.ok(renamed.source.includes("  # The big cover\n  studio_brand_cover:\n"));
  await assert.rejects(fs.access(path.join(home, "templates/brand.yml")));
  normalizeGroup(parse(renamed.source), "studio_brand");
});

test("rename refuses built-ins, stale hashes and clashes, leaving the old file", async () => {
  await assert.rejects(renameGroup({ name: "marvel_content_guide", scope: "builtin" }, "x", "h"), BuiltInReadOnlyError);
  const a = await copyGroup({ name: "marvel_content_guide", scope: "builtin" }, "kit_a");
  await copyGroup({ name: "marvel_content_item", scope: "builtin" }, "kit_b");
  await assert.rejects(renameGroup({ name: "kit_a", scope: "library" }, "kit_b", "stale"), { code: "FILE_CONFLICT" });
  await assert.rejects(renameGroup({ name: "kit_a", scope: "library" }, "kit_b", a.hash), KitExistsError);
  assert.equal((await readKit({ kind: "group", name: "kit_a", scope: "library" })).hash, a.hash);
});

test("every built-in group renders a sample deck: one slide per page step, typed, counter skips the cover", async () => {
  for (const name of BUILT_IN) {
    const kit = await readKit({ kind: "group", name, scope: "builtin" });
    const parsed = parse(kit.source);
    const theme = await readKit({ kind: "theme", name: parsed.style, scope: "builtin" });
    const html = await renderSampleDocument({ group: parsed, themeCss: theme.source });
    const labels = [...html.matchAll(/data-sample="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(labels, parsed.blueprint.pages.map((step) => step.type ?? step.any[0]), name);
    for (const [type, rules] of Object.entries(parsed.blueprint.types)) {
      if (rules.template && labels.includes(type)) assert.ok(html.includes(`data-template="${rules.template}"`), `${name} ${type}`);
    }
    const figures = html.split('<figure class="sample"').slice(1);
    assert.ok(!/class="chrome-counter/.test(figures[0]), `${name} cover has no counter`);
    if (figures.length > 1) assert.match(figures[1], /01/);
  }
  await assert.rejects(renderSampleDocument({ group: { name: "x" } }), { code: "KIT_INVALID" });
});
