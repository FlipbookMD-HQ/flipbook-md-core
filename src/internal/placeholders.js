// Placeholder slides for new decks (createDeck) and kit sample decks (renderSampleDocument).
// Internal: not part of the package's public API.
import { measureMarkdown } from "../blueprint.js";
import { ValidationError } from "../writer.js";

// A 16:9 grey frame, inlined so a placeholder image needs no extra file.
const PLACEHOLDER_IMAGE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#2a3550"/><path d="M560 620l200-240 160 180 100-110 180 170z" fill="#4a5a80"/><circle cx="1040" cy="330" r="60" fill="#4a5a80"/></svg>'
).toString("base64")}`;

export function titleCase(type) {
  const words = String(type).replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The slide types a new deck starts with: each required blueprint step, `repeat.min` times. */
export function placeholderTypes(blueprint) {
  if (!blueprint) return [null];
  const types = [];
  for (const page of blueprint.pages) {
    const type = page.type ?? page.any[0];
    for (let count = 0; count < page.repeat.min; count += 1) types.push(type);
  }
  if (types.length) return types;
  // No required step: one slide of the first step that allows any.
  const open = blueprint.pages.find((page) => page.repeat.max >= 1);
  if (!open) throw new ValidationError("The kit's blueprint allows no slides.", { code: "KIT_INVALID" });
  return [open.type ?? open.any[0]];
}

export function rulesFor(blueprint, type) {
  if (!blueprint || !type) return {};
  const step = blueprint.pages.find((page) => page.type === type || page.any?.includes(type)) ?? {};
  const rules = blueprint.types[type] ?? {};
  const pick = (key) => step[key] ?? rules[key];
  return { require: pick("require"), allow: pick("allow"), forbid: pick("forbid"), max_chars: pick("max_chars"), max_items: pick("max_items") };
}

function block(kind, heading, rules) {
  switch (kind) {
    case "heading":
      return `# ${heading}`;
    case "paragraph":
      return "Replace this with your text.";
    case "list": {
      const count = Math.max(1, Math.min(2, rules.max_items ?? 2));
      return ["- First point", "- Second point"].slice(0, count).join("\n");
    }
    case "image":
      return `![Placeholder](${PLACEHOLDER_IMAGE})`;
    case "blockquote":
      return "> A line worth quoting.";
    case "code":
      return "```\ncode\n```";
    case "table":
      return "| Item | Value |\n| --- | --- |\n| A | 1 |";
    default:
      return "";
  }
}

/** Placeholder Markdown for one slide that satisfies its blueprint type's rules. */
export function placeholderMarkdown(heading, rules = {}) {
  const allowed = (kind) => (!rules.allow || rules.allow.includes(kind)) && !(rules.forbid ?? []).includes(kind);
  const required = [...(rules.require ?? [])];
  const kinds = [];
  if (allowed("heading") || required.includes("heading")) kinds.push("heading");
  for (const kind of required) if (!kinds.includes(kind)) kinds.push(kind);
  const optional = allowed("paragraph") && !kinds.includes("paragraph");
  if (!kinds.length && rules.allow?.length) kinds.push(rules.allow[0]);

  const build = (title, withParagraph) =>
    [...kinds, ...(withParagraph ? ["paragraph"] : [])]
      .sort((a, b) => (a === "heading" ? -1 : b === "heading" ? 1 : 0))
      .map((kind) => block(kind, title, rules))
      .join("\n\n");
  const fits = (markdown) => rules.max_chars == null || measureMarkdown(markdown).chars <= rules.max_chars;

  let markdown = build(heading, optional);
  if (fits(markdown)) return markdown;
  markdown = build(heading, false);
  // Shorten the heading until the slide fits its character budget.
  let title = heading;
  while (!fits(markdown) && title.length > 1) {
    title = title.slice(0, Math.max(1, title.length - 8)).trimEnd();
    markdown = build(title, false);
  }
  return markdown;
}
