import fs from "node:fs/promises";
import path from "node:path";
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
