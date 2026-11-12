import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { libraryRoot } from "./templates.js";

// Typed errors carry the API error code Studio maps them to (tech-spec: errors-edge-cases).

export class FileConflictError extends Error {
  constructor(file, currentHash) {
    super(currentHash ? `${file} changed on disk.` : `${file} already exists.`);
    this.code = "FILE_CONFLICT";
    this.path = file;
    this.currentHash = currentHash;
  }
}

export class BuiltInReadOnlyError extends Error {
  constructor(file) {
    super(`${file} is part of the built-in library and is read-only. Copy it to your library to change it.`);
    this.code = "BUILTIN_READ_ONLY";
    this.path = file;
  }
}

export class ValidationError extends Error {
  constructor(message, { code = "VALIDATION_FAILED", path: file, fields, field } = {}) {
    super(message);
    this.code = code;
    if (file) this.path = file;
    if (fields) this.fields = fields;
    if (field) this.field = field;
  }
}

export class LastSlideError extends Error {
  constructor(file) {
    super("A deck needs at least one slide.");
    this.code = "LAST_SLIDE";
    this.path = file;
  }
}

export class DeckExistsError extends Error {
  constructor(file) {
    super(`A deck named ${path.basename(file)} already exists.`);
    this.code = "DECK_EXISTS";
    this.path = file;
  }
}

export class KitNotFoundError extends Error {
  constructor(kit) {
    super(`Unknown media kit "${kit}".`);
    this.code = "KIT_NOT_FOUND";
    this.kit = kit;
  }
}

export class KitExistsError extends Error {
  constructor(file) {
    super(`${path.basename(file)} already exists.`);
    this.code = "KIT_EXISTS";
    this.path = file;
  }
}

export class KitInvalidError extends Error {
  constructor(message, file) {
    super(message);
    this.code = "KIT_INVALID";
    if (file) this.path = file;
  }
}

export class ReservedNameError extends Error {
  constructor(name) {
    super(`"${name}" is a built-in template name. Pick another name.`);
    this.code = "RESERVED_NAME";
    this.field = "name";
  }
}

/** sha256 hex of the exact bytes. */
export function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Reads a file as UTF-8 text with the sha256 of its exact bytes. */
export async function readFileWithHash(file) {
  const bytes = await fs.readFile(file);
  return { text: bytes.toString("utf8"), hash: hashBytes(bytes) };
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realOrSelf(target) {
  return fs.realpath(target).catch(() => path.resolve(target));
}

/** Resolves `file` and checks it is inside one of `roots` and outside core's built-in library. */
async function guardPath(file, roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new ValidationError("atomicWrite needs at least one allowed root.");
  }
  const absolute = path.resolve(file);
  // The parent must exist; resolving it follows symlinks so a link cannot point the write elsewhere.
  const parent = await fs.realpath(path.dirname(absolute)).catch(() => {
    throw new ValidationError(`Folder does not exist: ${path.dirname(absolute)}`, { path: absolute });
  });
  const target = path.join(parent, path.basename(absolute));
  const realTarget = await fs.lstat(target).then((stat) => (stat.isSymbolicLink() ? fs.realpath(target) : target)).catch(() => target);
  if (within(await realOrSelf(libraryRoot()), realTarget)) throw new BuiltInReadOnlyError(absolute);
  const realRoots = await Promise.all(roots.map(realOrSelf));
  if (!realRoots.some((root) => within(root, realTarget))) {
    throw new ValidationError(`${absolute} is outside the allowed folders.`, { code: "PATH_OUTSIDE_ROOT", path: absolute });
  }
  return realTarget;
}

async function currentHash(file) {
  try {
    return hashBytes(await fs.readFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Writes `data` to `file` atomically: a temp file next to it, fsync, then rename.
 * `baseHash` is required: the sha256 the caller last read, or `null` when the file must not exist yet.
 * On any failure the temp file is removed and the original is left untouched.
 */
export async function atomicWrite(file, data, { baseHash, roots } = {}) {
  if (baseHash !== null && typeof baseHash !== "string") {
    throw new ValidationError("atomicWrite needs a baseHash (a sha256 string, or null for a new file).");
  }
  const target = await guardPath(file, roots);
  const current = await currentHash(target);
  if (current !== baseHash) throw new FileConflictError(target, current);

  const temp = `${target}.flipbook-tmp`;
  let handle;
  try {
    handle = await fs.open(temp, "w");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { hash: hashBytes(typeof data === "string" ? Buffer.from(data, "utf8") : data) };
}
