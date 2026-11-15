import fs from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { assertFree, loadKit, validateNewDeck as validate } from "./internal/deck-checks.js";
import { placeholderMarkdown, placeholderTypes, rulesFor, titleCase } from "./internal/placeholders.js";
import { DeckExistsError, FileConflictError, ValidationError, atomicWrite } from "./writer.js";

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
