import fs from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, parse as parseYaml, parseDocument } from "yaml";
import { readKit, resolveKitPath, writeKit } from "./kits.js";
import { BuiltInReadOnlyError, FileConflictError, ValidationError, readFileWithHash } from "./writer.js";

const YAML_OUTPUT = { flowCollectionPadding: false, lineWidth: 0 };

/**
 * The group source under a new name: `name`, every `<old>_` template key and every blueprint
 * type's `template: <old>_…` become `<new>_…`. Uses the yaml Document API, so comments and order stay.
 */
export function renamedGroupSource(source, from, to) {
  const doc = parseDocument(source);
  if (doc.errors.length) throw new ValidationError(`Not valid YAML: ${doc.errors[0].message.split("\n")[0]}`, { code: "KIT_INVALID" });
  const prefix = `${from}_`;
  const swap = (value) => (typeof value === "string" && value.startsWith(prefix) ? `${to}_${value.slice(prefix.length)}` : value);
  const name = doc.get("name", true);
  if (isScalar(name)) name.value = to;
  else doc.set("name", to);
  const templates = doc.get("templates", true);
  if (isMap(templates)) {
    for (const pair of templates.items) {
      if (isScalar(pair.key)) pair.key.value = swap(pair.key.value);
    }
  }
  const types = doc.getIn(["blueprint", "types"], true);
  if (isMap(types)) {
    for (const pair of types.items) {
      const template = isMap(pair.value) ? pair.value.get("template", true) : null;
      if (isScalar(template)) template.value = swap(template.value);
    }
  }
  return doc.toString(YAML_OUTPUT);
}

/**
 * Copies a group (built-in or library) into the library as `toName`, renaming its prefixes.
 * A clash throws KitExistsError. Returns `{ hash, path, source }`.
 */
export async function copyGroup(fromRef, toName) {
  const from = await readKit({ kind: "group", name: fromRef.name, scope: fromRef.scope });
  const source = renamedGroupSource(from.source, fromRef.name, toName);
  const written = await writeKit({ kind: "group", name: toName, scope: "library" }, { source }, null);
  return { ...written, source };
}

/**
 * Renames a library group: writes `toName` (prefixes rewritten), then removes the old file.
 * `baseHash` must match the old file. Built-ins throw BuiltInReadOnlyError; a clash KitExistsError.
 * Returns `{ hash, path, source }`.
 */
export async function renameGroup(ref, toName, baseHash) {
  const oldRef = { kind: "group", name: ref.name, scope: ref.scope };
  if (oldRef.scope === "builtin") throw new BuiltInReadOnlyError(resolveKitPath(oldRef));
  const oldPath = resolveKitPath(oldRef);
  const current = await readFileWithHash(oldPath);
  if (current.hash !== baseHash) throw new FileConflictError(oldPath, current.hash);
  if (toName === ref.name) return { hash: current.hash, path: oldPath, source: current.text };
  const source = renamedGroupSource(current.text, ref.name, toName);
  const written = await writeKit({ kind: "group", name: toName, scope: "library" }, { source }, null);
  await fs.rm(oldPath);
  return { ...written, source };
}

async function deckGroup(deckPath) {
  try {
    const stat = await fs.stat(deckPath);
    if (stat.isDirectory()) return parseYaml(await fs.readFile(path.join(deckPath, "presentation.yml"), "utf8"))?.group ?? null;
    const text = await fs.readFile(deckPath, "utf8");
    const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    return front ? (parseYaml(front[1])?.group ?? null) : null;
  } catch {
    return null;
  }
}

/** The deck paths (folders or .slide.md files) whose `group:` is `name`. Unreadable decks are skipped. */
export async function findDecksUsingGroup(name, deckPaths) {
  const groups = await Promise.all(deckPaths.map(deckGroup));
  return deckPaths.filter((_, index) => String(groups[index] ?? "").trim() === name);
}
