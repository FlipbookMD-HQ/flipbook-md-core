import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isScalar, parseDocument, stringify as stringifyYaml } from "yaml";
import { copyGroup } from "./group-ops.js";
import { assertFree, validateNewDeck } from "./internal/deck-checks.js";
import { readKit, writeKit } from "./kits.js";
import { discoverPresentation } from "./presentation.js";
import { DeckExistsError, FileConflictError, KitInvalidError, ValidationError, atomicCreate } from "./writer.js";

// US-20: duplicate a deck beside itself (D26) and copy kit pieces into the library (D27).

const FRONTMATTER = /^(---\r?\n)([\s\S]*?\r?\n)?(---(?:\r?\n|$))/;
const SKIPPED_TOP_LEVEL = new Set(["dist"]);

/**
 * `yamlText` with its top-level `title` set to `title`. Only the title's characters change (the
 * scalar is spliced in place), so comments, order and formatting stay byte for byte. A file with
 * no `title` gets one as its first line.
 */
function withTitle(yamlText, title) {
  const doc = parseDocument(yamlText);
  if (doc.errors.length) throw new ValidationError(`Not valid YAML: ${doc.errors[0].message.split("\n")[0]}`, { code: "DECK_LOAD_FAILED" });
  const value = stringifyYaml(title, { lineWidth: 0 }).trimEnd();
  const node = doc.get("title", true);
  if (isScalar(node) && node.range) {
    const [start, valueEnd] = node.range;
    return `${yamlText.slice(0, start)}${value}${yamlText.slice(valueEnd)}`;
  }
  return `title: ${value}\n${yamlText}`;
}

/** A single-file deck's text with its frontmatter title changed (frontmatter added when missing). */
function singleFileWithTitle(text, title) {
  const match = FRONTMATTER.exec(text);
  if (!match) return `---\n${withTitle("", title)}---\n\n${text}`;
  const [whole, open, body = "", close] = match;
  return `${open}${withTitle(body, title)}${close}${text.slice(whole.length)}`;
}

/**
 * Copies `from` into `to` (which must not exist), skipping hidden entries, symlinks and, at the
 * top level, `dist/`. Returns the skipped symlinks as paths relative to the deck.
 */
async function copyTree(from, to, relative = "") {
  const skipped = [];
  await fs.mkdir(to);
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!relative && SKIPPED_TOP_LEVEL.has(entry.name) && entry.isDirectory()) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isSymbolicLink()) skipped.push(rel);
    else if (entry.isDirectory()) skipped.push(...(await copyTree(source, target, rel)));
    else if (entry.isFile()) await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
  return skipped;
}

async function loadable(deckPath) {
  try {
    // Evaluate, don't enforce: a deck with blueprint violations still duplicates.
    await discoverPresentation(deckPath, { blueprint: "evaluate" });
  } catch (error) {
    throw new ValidationError(error.message, { code: "DECK_LOAD_FAILED", path: deckPath });
  }
}

/**
 * Duplicates a deck beside itself as `name` with `title` (D26). A folder deck is copied into a
 * hidden temporary sibling and renamed into place, so a failure leaves nothing behind; `dist/`,
 * hidden entries and symlinks are left out (symlinks are listed in `skipped`). A single-file deck
 * becomes `<name>.slide.md` in the same folder and shares its `assets/`. Only `title` changes.
 * Returns `{ path, skipped }`.
 */
export async function duplicateDeck(deckPath, options = {}) {
  const { name, title } = validateNewDeck({ name: options.name, title: options.title, kind: "folder", group: null });
  const absolute = path.resolve(deckPath);
  const stat = await fs.lstat(absolute).catch(() => {
    throw new ValidationError(`Deck does not exist: ${absolute}`, { code: "DECK_NOT_FOUND", path: absolute });
  });
  await loadable(absolute);
  const parent = path.dirname(absolute);

  if (stat.isFile()) {
    const file = path.join(parent, `${name}.slide.md`);
    await assertFree(parent, path.basename(file));
    const text = singleFileWithTitle(await fs.readFile(absolute, "utf8"), title);
    try {
      await atomicCreate(file, text, { roots: [parent] });
    } catch (error) {
      if (error instanceof FileConflictError) throw new DeckExistsError(file);
      throw error;
    }
    return { path: file, skipped: [] };
  }

  if (!stat.isDirectory()) throw new ValidationError(`Not a deck: ${absolute}`, { code: "DECK_LOAD_FAILED", path: absolute });
  const target = path.join(parent, name);
  await assertFree(parent, name);
  const temp = path.join(parent, `.${name}.${crypto.randomBytes(6).toString("hex")}.flipbook-tmp`);
  try {
    const skipped = await copyTree(absolute, temp);
    const manifest = path.join(temp, "presentation.yml");
    await fs.writeFile(manifest, withTitle(await fs.readFile(manifest, "utf8"), title));
    await assertFree(parent, name);
    try {
      await fs.mkdir(target);
    } catch (error) {
      if (error.code === "EEXIST") throw new DeckExistsError(target);
      throw error;
    }
    // Rename over the empty folder just claimed; anything else there makes the rename fail.
    await fs.rename(temp, target).catch(async (error) => {
      await fs.rmdir(target).catch(() => {});
      throw error.code === "ENOTEMPTY" || error.code === "EEXIST" ? new DeckExistsError(target) : error;
    });
    return { path: target, skipped };
  } catch (error) {
    await fs.rm(temp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Copies a theme, template or blueprint into the library as `toName` (D27). `fromRef.scope` is
 * `library` or `builtin`; without it the library is tried first, then the built-ins. A `group` ref
 * goes through copyGroup, which also renames its prefixed templates. The source must validate.
 * Returns `{ ref, hash, path, source }` where `ref` is the new library KitRef.
 */
export async function copyKit(fromRef, toName) {
  const { kind, name, scope } = fromRef ?? {};
  if (scope === "deck") throw new ValidationError("Only library and built-in kits can be copied.", { field: "scope" });
  if (scope != null && scope !== "library" && scope !== "builtin") throw new ValidationError(`Unknown kit scope "${scope}".`, { field: "scope" });
  const scopes = scope ? [scope] : ["library", "builtin"];
  const ref = { kind, name: toName, scope: "library" };

  if (kind === "group") {
    let lastError;
    for (const from of scopes) {
      try {
        return { ref, ...(await copyGroup({ name, scope: from }, toName)) };
      } catch (error) {
        if (error.code !== "KIT_NOT_FOUND") throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  let read;
  let lastError;
  for (const from of scopes) {
    try {
      read = await readKit({ kind, name, scope: from });
      break;
    } catch (error) {
      if (error.code !== "KIT_NOT_FOUND") throw error;
      lastError = error;
    }
  }
  if (!read) throw lastError;
  if (read.invalid) throw new KitInvalidError(read.invalid, read.path);
  const written = await writeKit(ref, { source: read.source }, null);
  return { ref, ...written, source: read.source };
}
