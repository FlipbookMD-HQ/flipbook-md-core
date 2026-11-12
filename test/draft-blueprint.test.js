import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { evaluateDraftBlueprint, loadPresentation } from "@flipbook-md/core";

const talk = path.resolve("examples/blueprint-talk");
const source = await fs.readFile(path.join(talk, "blueprint.yml"), "utf8");
const { presentation } = await loadPresentation(talk, { blueprint: "evaluate" });

test("the deck's own blueprint as a draft gives zero violations", () => {
  assert.deepEqual(evaluateDraftBlueprint(presentation, source), { violations: [] });
});

test("tightening max_chars flags exactly the slides over it", () => {
  const { violations } = evaluateDraftBlueprint(presentation, source.replace("max_chars: 250", "max_chars: 20"));
  assert.deepEqual(violations.map((item) => [item.source, item.code]), [["slides/05_conclusion.slide.md", "MAX_CHARS"]]);
  assert.match(violations[0].message, /maximum is 20\.$/);
});

test("a parsed object works like YAML text, and nothing is mutated", () => {
  const before = JSON.stringify(presentation);
  const parsed = {
    pages: [{ type: "cover" }, { type: "point", repeat: { min: 1, max: 9 } }, { type: "conclusion" }],
    types: { cover: {}, point: { max_items: 1 }, conclusion: {} }
  };
  const { violations } = evaluateDraftBlueprint(presentation, parsed);
  assert.ok(violations.every((item) => item.code === "MAX_ITEMS"));
  assert.ok(violations.length >= 1);
  assert.equal(JSON.stringify(presentation), before);
  assert.ok(!("markdown" in JSON.parse(before).slides[0]));
});

test("an invalid blueprint returns errors instead of throwing", () => {
  const cases = [
    [source.replace("template: summary", "template: nowhere"), /unknown template "nowhere"/],
    [source.replace("  - type: conclusion", "  - type: epilogue"), /unknown type "epilogue"/],
    ["pages: []\ntypes: {}\n", /non-empty "pages"/],
    ["pages: [", /not valid YAML/],
    [null, /must contain a YAML object/],
    [{ pages: [{ type: "point", repeat: { min: 3, max: 1 } }], types: { point: {} } }, /invalid repeat/]
  ];
  for (const [draft, message] of cases) {
    const result = evaluateDraftBlueprint(presentation, draft);
    assert.equal(result.violations, undefined);
    assert.match(result.errors[0], message);
  }
  assert.ok(evaluateDraftBlueprint(undefined, source).violations);
});

test("an any: step with repeat matches mixed types, and too few matches is an ORDER violation", () => {
  const draft = `pages:
  - type: cover
  - any: [point, conclusion]
    repeat: { min: 1, max: 10 }
types:
  cover: { template: cover }
  point: {}
  conclusion: {}
`;
  assert.deepEqual(evaluateDraftBlueprint(presentation, draft), { violations: [] });
  const strict = draft.replace("min: 1, max: 10", "min: 9, max: 10");
  const { violations } = evaluateDraftBlueprint(presentation, strict);
  assert.deepEqual(violations.map((item) => item.code), ["ORDER"]);
  assert.match(violations[0].message, /expected at least 9 one of point, conclusion/);
});

test("template names resolve against the deck's templates.yml and the group's templates", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-draft-")));
  await fs.writeFile(path.join(dir, "templates.yml"), "aside:\n  column: 1\n  row: 1\n  width: 1\n  height: 1\n  align: start\n");
  await fs.writeFile(path.join(dir, "deck.slide.md"), "<!-- type: one -->\n# One\n");
  const { presentation: deck } = await loadPresentation(path.join(dir, "deck.slide.md"), { blueprint: "evaluate" });
  const draft = "pages:\n  - type: one\ntypes:\n  one: { template: aside }\n";
  assert.deepEqual(evaluateDraftBlueprint(deck, draft), { violations: [] });
  assert.match(evaluateDraftBlueprint(deck, draft.replace("aside", "marvel_content_place_cover")).errors[0], /unknown template/);
});
