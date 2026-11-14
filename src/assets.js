import fs from "node:fs/promises";
import path from "node:path";
import { themeAssetPath } from "./theme.js";
import { ValidationError, atomicCreate, removeFile } from "./writer.js";

// Deck images (US-16, tech-spec D18/D19): what may be uploaded, where it goes, and who uses it.

/** The largest image a deck takes: core's export inline limit. */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export const ASSET_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml"
};

export class AssetError extends Error {
  /** `code` is ASSET_TOO_LARGE, ASSET_TYPE, ASSET_CONTENT_MISMATCH or ASSET_NOT_FOUND. */
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const SVG_ROOT = /^(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)*<svg[\s>/]/i;

function bytesOf(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function looksLike(ext, buf) {
  switch (ext) {
    case ".png":
      return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case ".jpg":
    case ".jpeg":
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case ".gif":
      return buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"));
    case ".webp":
      return buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    case ".svg": {
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        return false;
      }
      return SVG_ROOT.test(text.replace(/^﻿/, ""));
    }
    default:
      return false;
  }
}

const TYPE_NAMES = { ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF", ".webp": "WebP", ".svg": "SVG" };

/**
 * Checks an upload against D19: the extension, the 8 MB limit and that the bytes are that kind of
 * image. Returns `{ ext, mime }`; throws AssetError.
 */
export function checkAsset(fileName, data) {
  const ext = path.extname(String(fileName ?? "")).toLowerCase();
  if (!ASSET_TYPES[ext]) {
    throw new AssetError("ASSET_TYPE", "Upload a PNG, JPEG, GIF, WebP or SVG image.", { fileName });
  }
  const buf = bytesOf(data);
  if (buf.length > MAX_ASSET_BYTES) {
    throw new AssetError("ASSET_TOO_LARGE", "Images can be at most 8 MB.", { fileName, bytes: buf.length });
  }
  if (!looksLike(ext, buf)) {
    throw new AssetError("ASSET_CONTENT_MISMATCH", `This file isn't a real ${TYPE_NAMES[ext]} image.`, { fileName });
  }
  return { ext, mime: ASSET_TYPES[ext] };
}

/** The folder a deck's images live in: `<deck>/assets`, or `assets/` next to a single-file deck. */
export async function assetsDir(deckPath) {
  const absolute = path.resolve(deckPath);
  const stat = await fs.stat(absolute);
  return path.join(stat.isDirectory() ? absolute : path.dirname(absolute), "assets");
}

/** The kebab-case base name an upload is stored under (without the `-N` suffix). */
export function assetBaseName(fileName) {
  const base = String(fileName ?? "").split(/[\\/]/).pop() ?? "";
  const ext = path.extname(base).toLowerCase();
  const slug = base
    .slice(0, base.length - ext.length)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "image"}${ext}`;
}

/**
 * Stores an uploaded image in the deck's assets folder under a safe, unique name; never overwrites.
 * Returns `{ path, hash, bytes }` with `path` relative to the deck root (`assets/cover.png`).
 */
export async function writeDeckAsset(deckPath, fileName, data) {
  const buf = bytesOf(data);
  checkAsset(fileName, buf);
  const dir = await assetsDir(deckPath);
  const root = path.dirname(dir);
  const existing = await fs.lstat(dir).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (!existing) await fs.mkdir(dir);
  else if (!existing.isDirectory() && !existing.isSymbolicLink()) {
    throw new ValidationError(`${dir} is not a folder.`, { path: dir });
  }
  const name = assetBaseName(fileName);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= 1000; n += 1) {
    const candidate = n === 1 ? name : `${stem}-${n}${ext}`;
    try {
      const { hash } = await atomicCreate(path.join(dir, candidate), buf, { roots: [root] });
      return { path: `assets/${candidate}`, hash, bytes: buf.length };
    } catch (error) {
      if (error.code !== "FILE_CONFLICT") throw error;
    }
  }
  throw new ValidationError(`Too many images named ${name}.`, { path: dir });
}

const HEADER_BYTES = 256 * 1024;

function svgLength(value) {
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value ?? "");
  return match ? Math.round(Number(match[1])) : null;
}

/** `{ width, height }` read from an image's header, or null when it can't be told. */
export function imageSize(ext, data) {
  const buf = bytesOf(data);
  try {
    switch (ext) {
      case ".png":
        return buf.length >= 24 && buf.subarray(12, 16).toString("latin1") === "IHDR" ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
      case ".gif":
        return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null;
      case ".jpg":
      case ".jpeg": {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) return null;
          const marker = buf[offset + 1];
          if (marker === 0xff) { offset += 1; continue; }
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
          }
          if (marker === 0xd9 || marker === 0xda) return null;
          offset += 2 + buf.readUInt16BE(offset + 2);
        }
        return null;
      }
      case ".webp": {
        const chunk = buf.subarray(12, 16).toString("latin1");
        if (chunk === "VP8X" && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (chunk === "VP8L" && buf.length >= 25) {
          const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
          return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
        }
        return null;
      }
      case ".svg": {
        const tag = /<svg\b([^>]*)>/i.exec(buf.toString("utf8"));
        if (!tag) return null;
        const attr = (name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag[1])?.[1];
        const width = svgLength(attr("width"));
        const height = svgLength(attr("height"));
        if (width && height) return { width, height };
        const box = (attr("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
        return box.length === 4 && box[2] > 0 && box[3] > 0 ? { width: Math.round(box[2]), height: Math.round(box[3]) } : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

async function readHead(file, size) {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, HEADER_BYTES));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function guardedAssetsDir(deckPath) {
  const dir = await assetsDir(deckPath);
  const root = await fs.realpath(path.dirname(dir));
  const real = await fs.realpath(dir).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (!real) return { dir, root, exists: false };
  const relative = path.relative(root, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ValidationError(`${dir} is outside the deck.`, { code: "PATH_OUTSIDE_ROOT", path: dir });
  }
  if (!(await fs.stat(real)).isDirectory()) throw new ValidationError(`${dir} is not a folder.`, { path: dir });
  return { dir: real, root, exists: true };
}

/**
 * The images directly in a deck's assets folder, sorted by path:
 * `{ path: "assets/x.png", bytes, mime, width, height }` (width and height null when unknown).
 * Symlinks, dotfiles and other file types are left out.
 */
export async function listDeckAssets(deckPath) {
  const { dir, exists } = await guardedAssetsDir(deckPath);
  if (!exists) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const assets = [];
  for (const entry of entries) {
    const ext = path.extname(entry.name).toLowerCase();
    if (!entry.isFile() || entry.name.startsWith(".") || !ASSET_TYPES[ext]) continue;
    const file = path.join(dir, entry.name);
    const { size } = await fs.stat(file);
    const size2d = imageSize(ext, await readHead(file, size));
    assets.push({ path: `assets/${entry.name}`, bytes: size, mime: ASSET_TYPES[ext], width: size2d?.width ?? null, height: size2d?.height ?? null });
  }
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

const FILE_URL = /\/presentation-file\/([^"'\\\s)]+)/g;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function referencedPaths(html) {
  const found = new Set();
  for (const match of String(html ?? "").matchAll(FILE_URL)) {
    try {
      const relative = decodeURIComponent(match[1].split(/[?#]/)[0]);
      if (ASSET_TYPES[path.extname(relative).toLowerCase()]) found.add(relative);
    } catch {
      // A malformed URL references nothing.
    }
  }
  return found;
}

/**
 * The local images a loaded presentation uses, relative to its root (`assets/x.png`):
 * `{ source, index, path }` per slide (Markdown images, HTML `src`, notes) with the slide's
 * index, and `{ source: "theme", index: null, path }` for `url()`s in the deck's presentation.css.
 */
export async function assetReferences(presentation) {
  const references = [];
  (presentation?.slides ?? []).forEach((slide, index) => {
    const paths = new Set([...referencedPaths(slide.html), ...referencedPaths(slide.notesHtml)]);
    for (const file of paths) references.push({ source: slide.source, index, path: file });
  });
  if (presentation?.root) {
    const css = await fs.readFile(path.join(presentation.root, "presentation.css"), "utf8").catch(() => "");
    const seen = new Set();
    for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      const asset = EXTERNAL.test(match[2].trim()) ? null : themeAssetPath(match[2]);
      if (asset && ASSET_TYPES[path.extname(asset.relative).toLowerCase()] && !seen.has(asset.relative)) {
        seen.add(asset.relative);
        references.push({ source: "theme", index: null, path: asset.relative });
      }
    }
  }
  return references;
}

/** Deletes one image directly in the deck's assets folder (`assets/x.png`). */
export async function removeDeckAsset(deckPath, assetPath) {
  const value = String(assetPath ?? "");
  const match = /^assets\/([^/\\\0]+)$/.exec(value);
  if (!match || match[1].startsWith(".") || !ASSET_TYPES[path.extname(match[1]).toLowerCase()]) {
    throw new ValidationError(`${value} is not an image in the deck's assets folder.`, { code: "PATH_OUTSIDE_ROOT", path: value });
  }
  const { dir, root, exists } = await guardedAssetsDir(deckPath);
  const file = path.join(dir, match[1]);
  const stat = exists ? await fs.lstat(file).catch(() => null) : null;
  if (!stat || !(stat.isFile() || stat.isSymbolicLink())) throw new AssetError("ASSET_NOT_FOUND", `${value} doesn't exist.`, { path: value });
  await removeFile(file, { roots: [root] });
}
