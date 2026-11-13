import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BlueprintError,
  discoverPresentation,
  evaluateBlueprint,
  evaluateBlueprintDetailed,
  loadPresentation,
  readSlide
} from "@flipbook-md/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const examples = path.resolve(here, "../examples");
// The CLI next to this repo, when it is checked out (it links this core).
const CLI = path.resolve(here, "../../flipbook-md/bin/flipbook.js");

async function talk(changes = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-violations-")));
  const deck = path.join(root, "talk");
  await fs.cp(path.join(examples, "blueprint-talk"), deck, { recursive: true });
  for (const [file, text] of Object.entries(changes)) {
    if (text === null) await fs.rm(path.join(deck, file));
    else await fs.writeFile(path.join(deck, file), text);
  }
  return deck;
}

const manifest = (slides) => `title: Talk\nslides:\n${slides.map((slide) => `  - slides/${slide}\n`).join("")}`;
const LONG = `# Ask for the yes\n\n${"Name the owner, the option, and the date. ".repeat(8)}\n`;

// One failing deck per violation code.
const FAILING = {
  MAX_CHARS: { "slides/05_conclusion.slide.md": LONG },
  NOT_ALLOWED: { "slides/02_point.slide.md": "# Point\n\n```\ncode\n```\n" },
  TEMPLATE: { "slides/05_conclusion.slide.md": "<!-- template: flow -->\n# Ask\n" },
  ORDER: {
    "slides/03_point.slide.md": null,
    "slides/04_point.slide.md": null,
    "presentation.yml": manifest(["01_cover.slide.md", "02_point.slide.md", "05_conclusion.slide.md"])
  },
  MISSING_TYPE: {
    "slides/02_point.slide.md": null,
    "slides/02.slide.md": "# Untyped\n",
    "presentation.yml": manifest(["01_cover.slide.md", "02.slide.md", "03_point.slide.md", "04_point.slide.md", "05_conclusion.slide.md"])
  },
  REQUIRED: { "blueprint.yml": "pages:\n  - type: cover\n  - type: point\n    repeat: { min: 3, max: 6 }\n  - type: conclusion\ntypes:\n  cover: {}\n  point:\n    require: [image]\n  conclusion: {}\n" },
  MAX_ITEMS: { "blueprint.yml": "pages:\n  - type: cover\n  - type: point\n    repeat: { min: 3, max: 6 }\n  - type: conclusion\ntypes:\n  cover: {}\n  point:\n    max_items: 2\n  conclusion: {}\n" }
};

async function thrown(deck) {
  try {
    await discoverPresentation(deck);
  } catch (error) {
    if (error instanceof BlueprintError) return error.violations;
    throw error;
  }
  return [];
}

async function cliCheck(deck) {
  const run = await promisify(execFile)(process.execPath, [CLI, "check", deck], { env: { ...process.env } }).catch((error) => error);
  return String(run.stderr ?? "").trim().split("\n").filter(Boolean);
}

const cliAvailable = await fs.stat(CLI).then(() => true).catch(() => false);

for (const [code, changes] of Object.entries(FAILING)) {
  test(`${code}: structured messages equal evaluateBlueprint, the loader's error and flipbook check`, async () => {
    const deck = await talk(changes);
    const { violations } = await loadPresentation(deck);
    assert.ok(violations.length > 0);
    assert.ok(violations.some((violation) => violation.code === code), JSON.stringify(violations));
    const messages = violations.map((violation) => violation.message);
    assert.deepEqual(messages, await thrown(deck));

    const { presentation } = await loadPresentation(deck);
    for (const violation of violations) {
      assert.ok(violation.source === "deck" || presentation.slides.some((slide) => slide.source === violation.source));
    }
    if (cliAvailable) assert.deepEqual(await cliCheck(deck), messages);
  });
}

test("evaluateBlueprint is evaluateBlueprintDetailed's messages", () => {
  const blueprint = {
    pages: [{ type: "point", repeat: { min: 1, max: 2 } }],
    types: { point: { max_chars: 4, forbid: ["code"] } }
  };
  const deck = () => ({
    slides: [
      { source: "a", type: "point", template: "flow", markdown: "# Too long" },
      { source: "b", type: "point", template: "flow", markdown: "```\nx\n```" }
    ]
  });
  const detailed = evaluateBlueprintDetailed(deck(), blueprint);
  assert.deepEqual(detailed.map((violation) => violation.code), ["MAX_CHARS", "NOT_ALLOWED"]);
  assert.deepEqual(evaluateBlueprint(deck(), blueprint), detailed.map((violation) => violation.message));
});

test("a sequence violation doesn't hide other slides' content violations", () => {
  const blueprint = {
    pages: [
      { type: "cover", repeat: { min: 1, max: 1 } },
      { type: "point", repeat: { min: 1, max: 5 }, max_chars: 10 },
      { type: "end", repeat: { min: 1, max: 1 } }
    ],
    types: { cover: { template: "cover" }, point: { max_chars: 100 }, end: { max_chars: 5 } }
  };
  const slide = (source, type, markdown, template = null) => ({ source, type, markdown, template, templateExplicit: Boolean(template) });
  const deck = {
    slides: [
      slide("a", "cover", "# Hi"),
      slide("b", "point", "# Longer than ten"),
      slide("c", "mystery", "# Unknown type, no content rules"),
      slide("d", "end", "# Far past five")
    ]
  };
  const violations = evaluateBlueprintDetailed(deck, blueprint);
  assert.deepEqual(
    violations.map(({ source, code }) => `${code} ${source}`),
    // ORDER first; b is placed on the point page (its limit of 10), d only has its type's limit.
    ["ORDER c", "MAX_CHARS b", "MAX_CHARS d"]
  );
  assert.match(violations[1].message, /maximum is 10\./);
  assert.equal(deck.slides[0].template, "cover", "the blueprint template is still applied");

  const untyped = { slides: [slide("a", "cover", "# Hi"), slide("b", null, "# x"), slide("c", "end", "# Far past five")] };
  assert.deepEqual(evaluateBlueprintDetailed(untyped, blueprint).map(({ source, code }) => `${code} ${source}`), ["MISSING_TYPE b", "MAX_CHARS c"]);
});

test("a deck out of order still reports a too-long slide, in the loader, the error and flipbook check", async () => {
  const deck = await talk({ ...FAILING.ORDER, "slides/05_conclusion.slide.md": LONG });
  const { violations } = await loadPresentation(deck);
  assert.deepEqual(violations.map((violation) => violation.code), ["ORDER", "MAX_CHARS"]);
  assert.equal(violations[1].source, "slides/05_conclusion.slide.md");
  const messages = violations.map((violation) => violation.message);
  assert.deepEqual(await thrown(deck), messages);
  if (cliAvailable) assert.deepEqual(await cliCheck(deck), messages);
});

test("a deck that ends early reports source deck", async () => {
  const deck = await talk({
    "slides/05_conclusion.slide.md": null,
    "presentation.yml": manifest(["01_cover.slide.md", "02_point.slide.md", "03_point.slide.md", "04_point.slide.md"])
  });
  const { violations } = await loadPresentation(deck);
  assert.deepEqual(violations, [{ source: "deck", code: "ORDER", message: "blueprint.yml: expected conclusion but the deck ended." }]);
});

test("a valid deck and a deck without a blueprint have no violations", async () => {
  assert.deepEqual((await loadPresentation(await talk())).violations, []);
  const plain = await talk({ "blueprint.yml": null });
  const loaded = await loadPresentation(plain);
  assert.deepEqual(loaded.violations, []);
  assert.equal(loaded.presentation.blueprint, null);
  assert.deepEqual((await loadPresentation(path.join(examples, "system-design.slide.md"))).violations, []);
});

test("a deck's own blueprint.yml wins over its group's", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-violations-")));
  await fs.mkdir(path.join(root, "slides"));
  await fs.writeFile(path.join(root, "presentation.yml"), "title: Kit\ngroup: marvel_content_character\nslides:\n  - slides/01_x.slide.md\n");
  await fs.writeFile(path.join(root, "slides/01_x.slide.md"), "# Too long for five\n");
  const groupOnly = await loadPresentation(root);
  assert.ok(groupOnly.violations.length > 0 && groupOnly.violations.every((violation) => violation.code !== "MAX_CHARS"));
  await fs.writeFile(path.join(root, "blueprint.yml"), "pages:\n  - type: x\ntypes:\n  x:\n    max_chars: 5\n");
  const { violations } = await loadPresentation(root);
  assert.deepEqual(violations, [{ source: "slides/01_x.slide.md", code: "MAX_CHARS", message: "slides/01_x.slide.md: visible text is 17 characters; maximum is 5." }]);
});

test("loadPresentation applies a draft in memory and never writes", async () => {
  const deck = await talk();
  const file = path.join(deck, "slides/05_conclusion.slide.md");
  const before = await fs.readFile(file, "utf8");
  const { draft } = await readSlide(deck, "slides/05_conclusion.slide.md");

  const broken = await loadPresentation(deck, { draft: { slideId: "slides/05_conclusion.slide.md", draft: { ...draft, markdown: LONG } } });
  assert.deepEqual(broken.violations.map((violation) => violation.code), ["MAX_CHARS"]);
  assert.equal(broken.violations[0].source, "slides/05_conclusion.slide.md");
  assert.match(broken.presentation.slides[4].html, /Name the owner, the option, and the date\. Name the owner/);
  assert.equal(await fs.readFile(file, "utf8"), before);

  const fixed = await loadPresentation(deck, { draft: { slideId: "slides/05_conclusion.slide.md", draft } });
  assert.deepEqual(fixed.violations, []);

  // A filename type changed in the draft counts as the new type.
  const { draft: point } = await readSlide(deck, "slides/04_point.slide.md");
  const retyped = await loadPresentation(deck, { draft: { slideId: "slides/04_point.slide.md", draft: { ...point, type: "conclusion" } } });
  assert.equal(retyped.presentation.slides[3].type, "conclusion");
  assert.equal(retyped.violations[0].code, "ORDER");

  // Single-file decks: drafts address chunks by #index.
  const single = await loadPresentation(path.join(examples, "system-design.slide.md"), {
    draft: { slideId: "#1", draft: { markdown: "# Drafted", template: null, type: null, notes: "", title: null, directives: {} } }
  });
  assert.equal(single.presentation.slides[1].title, "Drafted");
});

test("an invalid draft is a ValidationError with the field", async () => {
  const deck = await talk();
  const { draft } = await readSlide(deck, "slides/02_point.slide.md");
  await assert.rejects(loadPresentation(deck, { draft: { slideId: "slides/02_point.slide.md", draft: { ...draft, template: "nope" } } }), (error) => error.field === "template");
  await assert.rejects(loadPresentation(deck, { draft: { slideId: "slides/99.slide.md", draft } }), (error) => error.code === "SLIDE_NOT_FOUND");
});
