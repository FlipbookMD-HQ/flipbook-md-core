import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { measureMarkdown, normalizeBlueprint } from "./blueprint.js";
import { loadGroup } from "./groups.js";
import { DeckExistsError, FileConflictError, KitNotFoundError, ValidationError, atomicWrite } from "./writer.js";

const DECK_NAME = /^[a-z0-9-]{1,60}$/;
const KINDS = new Set(["folder", "single"]);

// A 16:9 grey frame, inlined so a placeholder image needs no extra file.
const PLACEHOLDER_IMAGE = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#2a3550"/><path d="M560 620l200-240 160 180 100-110 180 170z" fill="#4a5a80"/><circle cx="1040" cy="330" r="60" fill="#4a5a80"/></svg>'
).toString("base64")}`;

function titleCase(type) {
  const words = String(type).replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The slide types a new deck starts with: each required blueprint step, `repeat.min` times. */
function placeholderTypes(blueprint) {
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

function rulesFor(blueprint, type) {
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
function placeholderMarkdown(heading, rules = {}) {
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

async function loadKit(group) {
  try {
    const loaded = await loadGroup(group);
    return { group: loaded, blueprint: normalizeBlueprint(loaded.blueprint, loaded.templates) };
  } catch (error) {
    if (/^Unknown template group|is not a valid name/.test(error.message)) throw new KitNotFoundError(group);
    throw new ValidationError(error.message, { code: "KIT_INVALID" });
  }
}

function validate({ name, title, kind, group }) {
  const fields = [];
  if (typeof name !== "string" || !DECK_NAME.test(name)) fields.push({ path: "name", message: "Use 1-60 lowercase letters, digits or dashes." });
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (cleanTitle.length < 1 || cleanTitle.length > 120) fields.push({ path: "title", message: "Use 1-120 characters." });
  if (!KINDS.has(kind)) fields.push({ path: "kind", message: "Use folder or single." });
  if (group != null && (typeof group !== "string" || !group.trim())) fields.push({ path: "group", message: "Use a kit name or null." });
  if (fields.length) throw new ValidationError("The new deck is not valid.", { fields });
  return { name, title: cleanTitle, kind, group: group == null ? null : group.trim() };
}

/** Refuses a name that exists, including one differing only in case (case-insensitive filesystems). */
async function assertFree(dir, entryName) {
  const entries = await fs.readdir(dir);
  const clash = entries.find((entry) => entry.toLowerCase() === entryName.toLowerCase());
  if (clash) throw new DeckExistsError(path.join(dir, clash));
}

function frontmatter(data) {
  return `---\n${stringifyYaml(data)}---\n`;
}

/**
 * Creates a deck in `dir`: a folder with `presentation.yml` and `slides/NN_<type>.slide.md`,
 * or a single `<name>.slide.md`. With a media kit (`group`), it adds one placeholder slide for
 * each required blueprint step. Returns `{ path }` of the new folder or file.
 */
export async function createDeck(dir, options = {}) {
  const { name, title, kind, group } = validate(options);
  const root = await fs.realpath(dir).catch(() => {
    throw new ValidationError(`Folder does not exist: ${dir}`, { path: dir });
  });
  const kit = group ? await loadKit(group) : null;
  const types = placeholderTypes(kit?.blueprint ?? null);
  const header = { title, ...(group ? { group } : {}) };
  const slides = types.map((type, index) => ({
    type,
    markdown: `${placeholderMarkdown(index === 0 ? title : titleCase(type ?? "slide"), rulesFor(kit?.blueprint, type))}\n`
  }));

  if (kind === "single") {
    const file = path.join(root, `${name}.slide.md`);
    await assertFree(root, path.basename(file));
    const body = slides.map((slide) => (slide.type ? `<!-- type: ${slide.type} -->\n${slide.markdown}` : slide.markdown)).join("\n---\n\n");
    try {
      await atomicWrite(file, `${frontmatter(header)}\n${body}`, { baseHash: null, roots: [root] });
    } catch (error) {
      if (error instanceof FileConflictError) throw new DeckExistsError(file);
      throw error;
    }
    return { path: file };
  }

  const folder = path.join(root, name);
  await assertFree(root, name);
  try {
    await fs.mkdir(folder);
  } catch (error) {
    if (error.code === "EEXIST") throw new DeckExistsError(folder);
    throw error;
  }
  try {
    await fs.mkdir(path.join(folder, "slides"));
    const files = slides.map((slide, index) => `slides/${String(index + 1).padStart(2, "0")}_${slide.type ?? "slide"}.slide.md`);
    for (const [index, slide] of slides.entries()) {
      await atomicWrite(path.join(folder, files[index]), slide.markdown, { baseHash: null, roots: [root] });
    }
    await atomicWrite(path.join(folder, "presentation.yml"), stringifyYaml({ ...header, slides: files }), { baseHash: null, roots: [root] });
  } catch (error) {
    // Leave nothing half-made behind.
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
  return { path: folder };
}
