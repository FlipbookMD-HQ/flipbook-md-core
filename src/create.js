import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { normalizeBlueprint } from "./blueprint.js";
import { placeholderMarkdown, placeholderTypes, rulesFor, titleCase } from "./internal/placeholders.js";
import { loadGroup } from "./groups.js";
import { DeckExistsError, FileConflictError, KitNotFoundError, ValidationError, atomicWrite } from "./writer.js";

const DECK_NAME = /^[a-z0-9-]{1,60}$/;
const KINDS = new Set(["folder", "single"]);

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
