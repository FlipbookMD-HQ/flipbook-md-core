import fs from "node:fs/promises";
import path from "node:path";
import { isMap, isScalar, parse as parseYaml, parseDocument } from "yaml";
import { normalizeBlueprint } from "./blueprint.js";
import { normalizeGroup } from "./groups.js";
import { TEMPLATES, flipbookHome, libraryRoot, parsePlacement, parseTemplatesDocument } from "./templates.js";
import {
  BuiltInReadOnlyError,
  FileConflictError,
  KitExistsError,
  KitInvalidError,
  KitNotFoundError,
  ReservedNameError,
  ValidationError,
  atomicWrite,
  readFileWithHash
} from "./writer.js";

const KINDS = new Set(["theme", "template", "blueprint", "group"]);
const SCOPES = new Set(["library", "deck", "builtin"]);
// Core's slug rules: themes as loadNamedTheme, the rest as template and group names.
const NAMES = {
  theme: /^[a-z0-9-]{1,60}$/,
  template: /^[a-z][a-z0-9_-]{0,59}$/,
  blueprint: /^[a-z][a-z0-9_-]{0,59}$/,
  group: /^[a-z][a-z0-9_-]{0,59}$/
};
// Library folder and extension per kind. Templates and groups share templates/ (core's layout).
const LIBRARY = {
  theme: ["themes", ".css"],
  template: ["templates", ".yml"],
  blueprint: ["blueprints", ".yml"],
  group: ["templates", ".yml"]
};
// The one file each kind has in a deck folder. Groups have no deck scope.
const DECK_FILES = { theme: "presentation.css", template: "templates.yml", blueprint: "blueprint.yml" };

function check(ref) {
  const { kind, name, scope } = ref ?? {};
  if (!KINDS.has(kind)) throw new ValidationError(`Unknown kit kind "${kind}".`, { field: "kind" });
  if (!SCOPES.has(scope)) throw new ValidationError(`Unknown kit scope "${scope}".`, { field: "scope" });
  if (scope === "deck") {
    if (!DECK_FILES[kind]) throw new ValidationError(`A ${kind} has no deck scope.`, { field: "scope" });
    if (typeof ref.deckDir !== "string" || !ref.deckDir) throw new ValidationError("Deck scope needs deckDir.", { field: "deckDir" });
    return;
  }
  if (typeof name !== "string" || !NAMES[kind].test(name)) {
    throw new ValidationError(`"${name}" is not a valid ${kind} name. Use lowercase letters, digits, - or _.`, { field: "name" });
  }
  if (kind === "template") checkTemplateName(name);
}

function checkTemplateName(name) {
  if (typeof name !== "string" || !NAMES.template.test(name)) {
    throw new ValidationError(`"${name}" is not a valid template name. Use lowercase letters, digits, - or _.`, { field: "name" });
  }
  if (TEMPLATES[name]) throw new ReservedNameError(name);
}

/**
 * The file a KitRef names. `ref` is `{ kind, name, scope, deckDir? }`:
 * library → `<FLIPBOOK_HOME>/{themes,templates,blueprints}/<name>.<css|yml>`; deck →
 * `<deckDir>/{presentation.css,templates.yml,blueprint.yml}` (the name is ignored); builtin →
 * core's own library (read-only).
 */
export function resolveKitPath(ref) {
  check(ref);
  if (ref.scope === "deck") return path.join(path.resolve(ref.deckDir), DECK_FILES[ref.kind]);
  const [folder, extension] = LIBRARY[ref.kind];
  const base = ref.scope === "builtin" ? libraryRoot() : flipbookHome();
  return path.join(base, folder, `${ref.name}${extension}`);
}

/** The folder a write may touch for this ref (checked again by atomicWrite). */
function writeRoot(ref) {
  return ref.scope === "deck" ? path.resolve(ref.deckDir) : flipbookHome();
}

async function libraryTemplates() {
  const templates = {};
  for (const dir of [path.join(libraryRoot(), "templates"), path.join(flipbookHome(), "templates")]) {
    const entries = await fs.readdir(dir).catch(() => []);
    for (const entry of entries.filter((name) => name.endsWith(".yml"))) {
      try {
        const parsed = parseYaml(await fs.readFile(path.join(dir, entry), "utf8"));
        if (parsed && typeof parsed === "object" && "blueprint" in parsed) {
          Object.assign(templates, normalizeGroup(parsed, entry.slice(0, -4)).templates);
        } else {
          const placement = parsePlacement(entry.slice(0, -4), parsed);
          templates[placement.name] = placement;
        }
      } catch {
        // A broken library file doesn't make other kits invalid.
      }
    }
  }
  return templates;
}

async function deckTemplates(deckDir) {
  try {
    return parseTemplatesDocument(parseYaml(await fs.readFile(path.join(deckDir, "templates.yml"), "utf8")) ?? {});
  } catch {
    return {};
  }
}

/** Templates a blueprint may name: built-ins plus the deck's (deck scope) or the library's. */
async function knownTemplates(ref) {
  return ref.scope === "deck" ? deckTemplates(ref.deckDir) : libraryTemplates();
}

/**
 * Parses and validates kit source with the matching core normalizer. CSS is returned as-is.
 * Throws KitInvalidError with the normalizer's message.
 */
export async function parseKit(ref, source) {
  if (typeof source !== "string") throw new KitInvalidError("Kit source must be text.");
  if (ref.kind === "theme") return source;
  let parsed;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    throw new KitInvalidError(`Not valid YAML: ${error.message.split("\n")[0]}`);
  }
  try {
    switch (ref.kind) {
      case "template":
        if (ref.scope === "deck") return parseTemplatesDocument(parsed ?? {});
        return parsePlacement(ref.name, parsed);
      case "blueprint":
        return normalizeBlueprint(parsed, await knownTemplates(ref));
      case "group":
        return normalizeGroup(parsed, ref.name);
      default:
        throw new Error(`Unknown kit kind "${ref.kind}".`);
    }
  } catch (error) {
    throw new KitInvalidError(error.message);
  }
}

/**
 * Reads a kit: `{ source, parsed, hash, builtIn, path }`. `parsed` is the normalizer's output,
 * or null when the file doesn't validate (`invalid` then holds the message). Missing → KitNotFoundError.
 */
export async function readKit(ref) {
  const file = resolveKitPath(ref);
  let read;
  try {
    read = await readFileWithHash(file);
  } catch (error) {
    if (error.code === "ENOENT") throw new KitNotFoundError(ref.scope === "deck" ? `${ref.kind} of this deck` : ref.name);
    throw error;
  }
  let parsed = null;
  let invalid = null;
  try {
    parsed = await parseKit(ref, read.text);
  } catch (error) {
    invalid = error.message;
  }
  return { source: read.text, parsed, hash: read.hash, builtIn: ref.scope === "builtin", path: file, invalid };
}

// Re-serialization options that reproduce core's and typical hand-written kits byte for byte.
const YAML_OUTPUT = { flowCollectionPadding: false, lineWidth: 0 };

const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Applies an RFC 7386 merge patch to the node at `at`, keeping comments, order and scalar style. */
function applyPatch(doc, at, patch) {
  for (const [key, value] of Object.entries(patch)) {
    const where = [...at, key];
    if (value === null) {
      doc.deleteIn(where);
      continue;
    }
    const node = doc.getIn(where, true);
    if (plainObject(value) && isMap(node)) {
      applyPatch(doc, where, value);
    } else if (isScalar(node) && (value === null || typeof value !== "object")) {
      node.value = value; // Keeps the scalar's quoting and any comment on it.
    } else {
      doc.setIn(where, doc.createNode(value)); // A new key goes at the end of its map.
    }
  }
}

/**
 * The source after a merge patch. Deck `templates.yml` refs address one template by name
 * (`templates.yml#<name>`); a `null` patch there removes that template.
 */
function patchedSource(ref, source, patch) {
  const doc = parseDocument(source);
  if (doc.errors.length) throw new KitInvalidError(`Not valid YAML: ${doc.errors[0].message.split("\n")[0]}`);
  const keyed = ref.kind === "template" && ref.scope === "deck";
  if (!keyed && !plainObject(patch)) throw new ValidationError("A patch must be an object.", { field: "patch" });
  if (doc.contents == null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw new KitInvalidError("The kit file must contain a YAML mapping.");
  if (keyed) {
    if (patch === null) doc.deleteIn([ref.name]);
    else if (!plainObject(patch)) throw new ValidationError("A patch must be an object or null.", { field: "patch" });
    else if (isMap(doc.getIn([ref.name], true))) applyPatch(doc, [ref.name], patch);
    else doc.setIn([ref.name], doc.createNode(patch));
  } else {
    applyPatch(doc, [], patch);
  }
  return doc.toString(YAML_OUTPUT);
}

/**
 * Validates and atomically writes a kit. `baseHash` null creates (an existing file throws
 * KitExistsError); otherwise it must match the file's current hash (FileConflictError).
 * Built-in refs throw BuiltInReadOnlyError; invalid YAML kits throw KitInvalidError and leave
 * the file untouched. Returns `{ hash, path }`.
 */
export async function writeKit(ref, change, baseHash) {
  if (ref?.scope === "builtin") throw new BuiltInReadOnlyError(resolveKitPath(ref));
  const file = resolveKitPath(ref);
  if (!change || typeof change !== "object") throw new ValidationError("writeKit needs { source } or { patch }.");
  let source = change.source;
  if ("patch" in change) {
    if (ref.kind === "theme") throw new ValidationError("Themes are CSS; send source, not patch.", { field: "patch" });
    if (ref.kind === "template" && ref.scope === "deck") checkTemplateName(ref.name);
    let current = "";
    try {
      current = await fs.readFile(file, "utf8");
    } catch (error) {
      // Only a deck's templates.yml may be created by a patch.
      if (error.code !== "ENOENT" || !(ref.kind === "template" && ref.scope === "deck")) {
        if (error.code === "ENOENT") throw new KitNotFoundError(ref.name);
        throw error;
      }
    }
    source = patchedSource(ref, current, change.patch);
    if (source === current && baseHash !== null) {
      // Nothing changed: leave the file alone, but still refuse a stale hash.
      const { hash } = await readFileWithHash(file);
      if (hash !== baseHash) throw new FileConflictError(file, hash);
      return { hash, path: file };
    }
  }
  await parseKit(ref, source);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const { hash } = await atomicWrite(file, source, { baseHash, roots: [writeRoot(ref)] });
    return { hash, path: file };
  } catch (error) {
    if (error instanceof FileConflictError && baseHash === null) throw new KitExistsError(file);
    throw error;
  }
}
