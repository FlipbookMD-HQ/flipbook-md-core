import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { loadGroup } from "./groups.js";
import { discoverPresentation } from "./presentation.js";
import { loadDeckTemplates, lookupTemplate } from "./templates.js";
import { FileConflictError, LastSlideError, ValidationError, atomicWrite, readFileWithHash } from "./writer.js";

// Reads slides into SlideDrafts and writes drafts back, changing only what changed
// (tech-spec: data-model § Writer rules). A slide is a folder-deck file, or one chunk of a
// single-file deck between `---` lines.

const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
const DIRECTIVE = /<!--\s*([A-Za-z][\w-]*)[ \t]*:([\s\S]*?)-->/g;
const NOTES_COMMENT = /<!--\s*notes:[\s\S]*?-->/gi;
const KNOWN = new Set(["template", "type", "notes"]);
const DIRECTIVE_KEY = /^[a-z][a-z0-9_-]*$/;
const TYPE_NAME = /^[a-z][a-z0-9-]*$/;
const FILENAME_TYPE = /_([a-zA-Z][a-zA-Z0-9-]*)(\.slide\.md)$/;
const SLIDE_SUFFIX = /(\.slide\.md)$/;

// ---------- parsing ----------

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

/** Splits a slide's text into frontmatter and body pieces: plain text and directive comments. */
function parseSlideText(text, { frontmatter: allowFrontmatter }) {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const rest = text.slice(bom.length);
  const eol = rest.includes("\r\n") ? "\r\n" : "\n";
  const fm = allowFrontmatter ? FRONTMATTER.exec(rest) : null;
  const frontmatter = fm ? { raw: fm[0], doc: parseDocument(fm[1] ?? "") } : null;
  const body = fm ? rest.slice(fm[0].length) : rest;

  const pieces = [];
  let cursor = 0;
  for (const match of body.matchAll(DIRECTIVE)) {
    const key = match[1].toLowerCase();
    const known = KNOWN.has(key);
    if (!known && !DIRECTIVE_KEY.test(match[1])) continue;
    if (match.index > cursor) pieces.push({ kind: "text", raw: body.slice(cursor, match.index) });
    const valueRaw = match[2];
    const lead = valueRaw.length - valueRaw.trimStart().length;
    pieces.push({ kind: "directive", key, raw: match[0], value: valueRaw.trim(), valueOffset: match[0].indexOf(":") + 1 + lead });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) pieces.push({ kind: "text", raw: body.slice(cursor) });
  return { bom, eol, frontmatter, pieces };
}

function frontmatterData(parsed) {
  if (!parsed.frontmatter) return {};
  const data = parsed.frontmatter.doc.toJS();
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

function noteText(value) {
  if (value == null) return "";
  return lf(String(value)).trim();
}

/** The draft and where each field was found. Mirrors how core's loader reads a slide. */
function draftFrom(parsed, source) {
  const data = frontmatterData(parsed);
  const directives = parsed.pieces.filter((piece) => piece.kind === "directive");
  const first = (key) => directives.find((piece) => piece.key === key);
  const locations = { template: null, type: null, title: null, notes: null, directives: {} };

  let template = null;
  if (data.template != null && String(data.template).trim()) {
    template = String(data.template).trim().toLowerCase();
    locations.template = "frontmatter";
  } else if (first("template")?.value) {
    template = first("template").value.toLowerCase();
    locations.template = "comment";
  }

  let type = null;
  const fromName = source ? FILENAME_TYPE.exec(path.basename(source)) : null;
  if (fromName && TYPE_NAME.test(fromName[1].toLowerCase())) {
    type = fromName[1].toLowerCase();
    locations.type = "filename";
  } else if (first("type")?.value) {
    type = first("type").value.toLowerCase();
    locations.type = "comment";
  }

  let title = null;
  if (data.title != null) {
    title = String(data.title);
    locations.title = "frontmatter";
  }

  const notes = [];
  if (noteText(data.notes)) {
    notes.push(noteText(data.notes));
    locations.notes = "frontmatter";
  }
  for (const piece of directives.filter((d) => d.key === "notes")) {
    if (noteText(piece.value)) notes.push(noteText(piece.value));
    locations.notes ??= "comment";
  }

  const extra = {};
  for (const piece of directives) {
    if (KNOWN.has(piece.key) || piece.key in extra) continue;
    extra[piece.key] = piece.value;
    locations.directives[piece.key] = "comment";
  }

  const markdown = lf(parsed.pieces.filter((piece) => piece.kind === "text").map((piece) => piece.raw).join("")).trim();
  return { draft: { markdown, template, type, notes: notes.join("\n\n"), title, directives: extra }, locations };
}

// ---------- decks ----------

function isSingle(deckPath) {
  return deckPath.endsWith(".slide.md");
}

async function deckInfo(deckPath) {
  const absolute = await fs.realpath(path.resolve(deckPath)).catch(() => {
    throw new ValidationError(`Deck does not exist: ${deckPath}`, { path: deckPath });
  });
  const single = isSingle(absolute);
  const root = single ? path.dirname(absolute) : absolute;
  const manifestFile = single ? null : path.join(root, "presentation.yml");
  const manifest = single ? null : await readFileWithHash(manifestFile);
  const meta = single ? frontmatterData(parseSlideText((await fs.readFile(absolute, "utf8")), { frontmatter: true })) : parseYaml(manifest.text) ?? {};
  return { absolute, single, root, manifestFile, manifest, meta };
}

function manifestSlides(meta) {
  return (Array.isArray(meta.slides) ? meta.slides : []).map((item) => (typeof item === "string" ? item : item?.file)).filter((item) => typeof item === "string");
}

function slideNotFound(slideId) {
  return new ValidationError(`No slide ${slideId} in this deck.`, { code: "SLIDE_NOT_FOUND", fields: [{ path: "slideId", message: "Unknown slide." }] });
}

/** Chunk spans of a single-file deck, like core's splitter: `---` lines outside notes comments. */
function chunkSpans(text) {
  const fm = FRONTMATTER.exec(text);
  const start = fm ? fm[0].length : 0;
  const notes = [...text.matchAll(NOTES_COMMENT)].map((match) => [match.index, match.index + match[0].length]);
  const inNotes = (offset) => notes.some(([from, to]) => offset > from && offset < to);
  const spans = [];
  let chunkStart = start;
  let position = start;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    const lineEnd = newline === -1 ? text.length : newline;
    const next = newline === -1 ? text.length : newline + 1;
    if (text.slice(position, lineEnd).trim() === "---" && !inNotes(position)) {
      spans.push([chunkStart, position]);
      chunkStart = next;
    }
    position = next;
  }
  spans.push([chunkStart, text.length]);
  return spans.filter(([from, to]) => text.slice(from, to).trim());
}

async function locate(deckPath, slideId) {
  const deck = await deckInfo(deckPath);
  if (deck.single) {
    const match = /^#(\d+)$/.exec(String(slideId));
    const { text, hash } = await readFileWithHash(deck.absolute);
    const bom = text.startsWith("﻿") ? "﻿" : "";
    const spans = chunkSpans(text.slice(bom.length));
    const index = match ? Number(match[1]) : -1;
    if (index < 0 || index >= spans.length) throw slideNotFound(slideId);
    const [from, to] = spans[index].map((offset) => offset + bom.length);
    return { deck, file: deck.absolute, source: null, text, hash, span: [from, to], slideText: text.slice(from, to), index };
  }
  const slides = manifestSlides(deck.meta);
  const index = slides.indexOf(String(slideId));
  if (index === -1) throw slideNotFound(slideId);
  const file = path.resolve(deck.root, slideId);
  const relative = path.relative(deck.root, await fs.realpath(file).catch(() => file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new ValidationError(`Slide path leaves the deck: ${slideId}`, { code: "PATH_OUTSIDE_ROOT" });
  const { text, hash } = await readFileWithHash(file);
  return { deck, file, source: String(slideId), text, hash, span: [0, text.length], slideText: text, index };
}

/**
 * Reads one slide into a SlideDraft. Folder decks use the manifest path as the slide ID;
 * single-file decks use `#<0-based index>`. Returns the draft, where each field lives,
 * and the hash of the file the slide is in.
 */
export async function readSlide(deckPath, slideId) {
  const found = await locate(deckPath, slideId);
  const parsed = parseSlideText(found.slideText, { frontmatter: !found.deck.single });
  return { ...draftFrom(parsed, found.source), hash: found.hash, file: found.file, index: found.index };
}

// ---------- writing ----------

function normalizeDraft(draft) {
  if (!draft || typeof draft !== "object") throw new ValidationError("A slide draft is required.");
  const fields = [];
  const markdown = typeof draft.markdown === "string" ? lf(draft.markdown).trim() : (fields.push({ path: "markdown", message: "Markdown must be text." }), "");
  const template = draft.template == null || draft.template === "" ? null : String(draft.template).trim().toLowerCase();
  const type = draft.type == null || draft.type === "" ? null : String(draft.type).trim().toLowerCase();
  if (type && !TYPE_NAME.test(type)) fields.push({ path: "type", message: "Use lowercase letters, digits and dashes, starting with a letter." });
  const notes = noteText(draft.notes);
  if (notes.includes("-->")) fields.push({ path: "notes", message: "Notes cannot contain -->." });
  const title = draft.title == null ? null : String(draft.title);
  const directives = {};
  for (const [key, value] of Object.entries(draft.directives ?? {})) {
    if (!DIRECTIVE_KEY.test(key) || KNOWN.has(key)) fields.push({ path: `directives.${key}`, message: "Not a valid directive name." });
    else if (String(value).includes("-->") || /\n/.test(String(value))) fields.push({ path: `directives.${key}`, message: "Directive values are one line without -->." });
    else directives[key] = String(value).trim();
  }
  const reserved = [...markdown.matchAll(DIRECTIVE)].find((match) => KNOWN.has(match[1].toLowerCase()));
  if (reserved) fields.push({ path: "markdown", message: `Set ${reserved[1].toLowerCase()} with its field, not a comment in the Markdown.` });
  if (fields.length) throw new ValidationError("The slide draft is not valid.", { fields, field: fields[0].path });
  return { markdown, template, type, notes, title, directives };
}

async function deckTemplates(deck) {
  const templates = await loadDeckTemplates(deck.root);
  const group = deck.meta?.group == null ? "" : String(deck.meta.group).trim();
  if (!group) return templates;
  const loaded = await loadGroup(group);
  return { ...loaded.templates, ...templates };
}

function textPieces(pieces) {
  return pieces.map((piece, index) => ({ piece, index })).filter(({ piece }) => piece.kind === "text" && piece.raw.trim());
}

/** `<!-- key: value -->`, keeping the original comment's spacing when one exists. */
function setDirectiveValue(piece, value) {
  const before = piece.raw.slice(0, piece.valueOffset);
  const after = piece.raw.slice(piece.valueOffset + piece.raw.slice(piece.valueOffset).indexOf(piece.value) + piece.value.length);
  return { ...piece, raw: `${before}${value}${after}`, value };
}

function notesComment(notes, eol, multiline) {
  if (!multiline && !notes.includes("\n")) return `<!-- notes: ${notes} -->`;
  return `<!-- notes:${eol}${notes.split("\n").join(eol)}${eol}-->`;
}

/** Removes a piece; when it sat on its own line, the line goes too. */
function removePiece(pieces, index) {
  const prev = pieces[index - 1];
  const next = pieces[index + 1];
  const ownLineStart = !prev || prev.kind !== "text" || /(^|\n)[ \t]*$/.test(prev.raw);
  if (ownLineStart && next?.kind === "text" && /^[ \t]*\r?\n/.test(next.raw)) {
    next.raw = next.raw.replace(/^[ \t]*\r?\n/, "");
    if (prev?.kind === "text") prev.raw = prev.raw.replace(/[ \t]*$/, "");
  } else if (ownLineStart && !next && prev?.kind === "text") {
    prev.raw = prev.raw.replace(/\r?\n[ \t]*$/, "");
  }
  pieces.splice(index, 1);
  // A block that sat after a blank line and ended the slide (or a paragraph) takes that blank line with it.
  const after = pieces[index]?.raw ?? "";
  if (prev?.kind === "text" && /\r?\n\r?\n$/.test(prev.raw) && (after === "" || /^\r?\n/.test(after))) {
    prev.raw = prev.raw.replace(/\r?\n$/, "");
  }
}

/** Inserts a directive line above the content, after any leading blank lines (single-file chunks start with them). */
function insertTop(pieces, raw, eol) {
  const first = pieces[0];
  const lead = first?.kind === "text" ? /^\s*/.exec(first.raw)[0] : "";
  if (lead) pieces[0] = { ...first, raw: first.raw.slice(lead.length) };
  pieces.unshift(...(lead ? [{ kind: "text", raw: lead }] : []), { kind: "directive", key: "", raw, value: "" }, { kind: "text", raw: eol });
}

/** Applies `next` to the parsed slide, editing only the parts whose values changed. */
function applyDraft(parsed, current, locations, next, { single }) {
  const { eol } = parsed;
  const pieces = parsed.pieces;
  let fmChanged = false;
  const doc = parsed.frontmatter?.doc ?? null;
  const findPiece = (key) => pieces.findIndex((piece) => piece.kind === "directive" && piece.key === key);

  const setField = (key, value, location) => {
    if (location === "frontmatter") {
      if (value == null) doc.delete(key);
      else doc.set(key, value);
      fmChanged = true;
      return;
    }
    const at = location === "comment" ? findPiece(key) : -1;
    if (at !== -1) {
      if (value == null) removePiece(pieces, at);
      else pieces[at] = setDirectiveValue(pieces[at], value);
    } else if (value != null) {
      insertTop(pieces, `<!-- ${key}: ${value} -->`, eol);
    }
  };

  if (next.template !== current.template) setField("template", next.template, locations.template);
  if (next.type !== current.type && locations.type !== "filename") setField("type", next.type, locations.type);

  for (const key of new Set([...Object.keys(current.directives), ...Object.keys(next.directives)])) {
    if (current.directives[key] === next.directives[key]) continue;
    setField(key, next.directives[key] ?? null, current.directives[key] == null ? null : "comment");
  }

  if (next.title !== current.title) {
    if (doc) {
      if (next.title == null) doc.delete("title");
      else doc.set("title", next.title);
      fmChanged = true;
    } else if (next.title != null) {
      if (single) throw new ValidationError("Single-file slides take their title from the first # heading.", { fields: [{ path: "title", message: "Use a # heading instead." }], field: "title" });
      parsed.frontmatter = { raw: "", doc: parseDocument("") };
      parsed.frontmatter.doc.set("title", next.title);
      fmChanged = true;
    }
  }

  if (next.notes !== current.notes) {
    const commentIndexes = () => pieces.map((piece, index) => (piece.kind === "directive" && piece.key === "notes" ? index : -1)).filter((index) => index !== -1);
    const multiline = pieces.some((piece) => piece.kind === "directive" && piece.key === "notes" && /\n/.test(piece.raw));
    const inFrontmatter = doc && frontmatterData(parsed).notes != null;
    const firstComment = commentIndexes()[0];
    if (!next.notes) {
      if (inFrontmatter) {
        doc.delete("notes");
        fmChanged = true;
      }
      for (const index of commentIndexes().reverse()) removePiece(pieces, index);
    } else if (inFrontmatter) {
      doc.set("notes", next.notes);
      fmChanged = true;
      for (const index of commentIndexes().reverse()) removePiece(pieces, index);
    } else if (firstComment != null) {
      for (const index of commentIndexes().slice(1).reverse()) removePiece(pieces, index);
      pieces[firstComment] = { ...pieces[firstComment], raw: notesComment(next.notes, eol, multiline), value: next.notes };
    } else {
      // New notes go after the content, keeping the slide's trailing whitespace.
      const last = pieces[pieces.length - 1];
      const trailing = last?.kind === "text" ? /\s*$/.exec(last.raw)[0] : "";
      if (last?.kind === "text") last.raw = last.raw.slice(0, last.raw.length - trailing.length);
      const lead = pieces.some((piece) => piece.raw.trim()) ? `${eol}${eol}` : "";
      pieces.push({ kind: "text", raw: lead }, { kind: "directive", key: "notes", raw: notesComment(next.notes, eol, true), value: next.notes }, { kind: "text", raw: trailing || eol });
    }
  }

  if (next.markdown !== current.markdown) {
    const content = next.markdown.split("\n").join(eol);
    const texts = textPieces(pieces);
    if (texts.length === 0) {
      const last = pieces[pieces.length - 1];
      const trailing = last?.kind === "text" ? /\s*$/.exec(last.raw)[0] : "";
      if (last?.kind === "text") last.raw = last.raw.slice(0, last.raw.length - trailing.length);
      const notesAt = pieces.findIndex((piece) => piece.kind === "directive" && piece.key === "notes");
      if (notesAt !== -1) pieces.splice(notesAt, 0, { kind: "text", raw: `${content}${eol}${eol}` });
      else pieces.push({ kind: "text", raw: `${pieces.some((piece) => piece.raw.trim()) ? eol : ""}${content}` }, { kind: "text", raw: trailing || eol });
    } else {
      // Replace from the first to the last non-blank text; directives in between move above the content.
      const first = texts[0].index;
      const last = texts[texts.length - 1].index;
      const lead = /^\s*/.exec(pieces[first].raw)[0];
      const tail = /\s*$/.exec(pieces[last].raw)[0];
      const moved = pieces.slice(first + 1, last).filter((piece) => piece.kind === "directive");
      const replacement = [
        { kind: "text", raw: lead },
        ...moved.flatMap((piece) => [piece, { kind: "text", raw: eol }]),
        { kind: "text", raw: `${content}${tail}` }
      ];
      pieces.splice(first, last - first + 1, ...replacement);
    }
  }

  const body = pieces.map((piece) => piece.raw).join("");
  let head = parsed.frontmatter?.raw ?? "";
  if (fmChanged) {
    const yamlText = parsed.frontmatter.doc.toString().replace(/\n$/, "");
    head = Object.keys(frontmatterData(parsed)).length ? `---${eol}${yamlText.split("\n").join(eol)}${eol}---${eol}` : "";
  }
  return `${parsed.bom}${head}${body}`;
}

function renamedSource(source, type) {
  if (FILENAME_TYPE.test(source)) return source.replace(FILENAME_TYPE, type ? `_${type}$2` : "$2");
  return source.replace(SLIDE_SUFFIX, `_${type}$1`);
}

async function updateManifest(deck, oldSource, newSource) {
  const { text, hash } = deck.manifest;
  const occurrences = text.split(oldSource).length - 1;
  let updated;
  if (occurrences === 1) {
    updated = text.replace(oldSource, newSource);
  } else {
    const doc = parseDocument(text);
    const slides = doc.get("slides");
    for (const item of slides?.items ?? []) {
      if (item.value === oldSource) item.value = newSource;
      else if (item.get?.("file") === oldSource) item.set("file", newSource);
    }
    updated = doc.toString();
  }
  return atomicWrite(deck.manifestFile, updated, { baseHash: hash, roots: [deck.root] });
}

/**
 * The file text a draft would produce, without writing: `{ found, next, text, current, locations }`.
 * Throws ValidationError for an invalid draft, an unknown template, or `---` in a single-file slide.
 */
async function draftedText(deckPath, slideId, draft) {
  const next = normalizeDraft(draft);
  const found = await locate(deckPath, slideId);
  const { deck } = found;
  if (next.template) {
    const templates = await deckTemplates(deck);
    if (!lookupTemplate(next.template, templates).found) {
      throw new ValidationError(`Unknown template "${next.template}".`, { fields: [{ path: "template", message: "Pick a template this deck knows." }], field: "template" });
    }
  }
  if (deck.single && /^\s*---\s*$/m.test(next.markdown)) {
    throw new ValidationError("A line with only --- starts a new slide in a single-file deck.", { fields: [{ path: "markdown", message: "Remove the --- line." }], field: "markdown" });
  }
  const parsed = parseSlideText(found.slideText, { frontmatter: !deck.single });
  const { draft: current, locations } = draftFrom(parsed, found.source);
  const slideText = applyDraft(parsed, current, locations, next, { single: deck.single });
  const text = found.text.slice(0, found.span[0]) + slideText + found.text.slice(found.span[1]);
  return { found, next, text, current, locations };
}

/**
 * Loads a deck the way Studio needs it: blueprint violations are returned, never thrown, and an
 * optional unsaved draft (`{ slideId, draft }`) is applied in memory first.
 * Returns `{ presentation, violations }`.
 */
export async function loadPresentation(inputPath, { blueprint = "evaluate", draft = null } = {}) {
  const overrides = new Map();
  if (draft) {
    const { found, next, text, current, locations } = await draftedText(inputPath, draft.slideId, draft.draft);
    const renamesType = !found.deck.single && locations.type === "filename" && next.type !== current.type;
    overrides.set(found.file, renamesType ? { text, type: next.type } : { text });
  }
  const presentation = await discoverPresentation(inputPath, { blueprint, overrides });
  const violations = presentation.violations ?? [];
  delete presentation.violations;
  return { presentation, violations };
}

/**
 * Writes a SlideDraft back to its file, changing only the fields that differ. Fields are
 * updated where they were found; new ones become directive comments. A type that came from
 * the filename renames the file and updates the manifest. `baseHash` is the hash readSlide
 * returned; a different file on disk throws FileConflictError.
 * Returns `{ slideId, hashes }` with hashes keyed by path inside the deck.
 */
export async function updateSlide(deckPath, slideId, draft, baseHash) {
  // The hash is checked first, so a stale editor always gets FILE_CONFLICT.
  const stale = await locate(deckPath, slideId);
  if (stale.hash !== baseHash) throw new FileConflictError(stale.file, stale.hash);
  const { found, next, text, current, locations } = await draftedText(deckPath, slideId, draft);
  if (found.hash !== baseHash) throw new FileConflictError(found.file, found.hash);
  const { deck } = found;
  const roots = [deck.root];
  const key = deck.single ? path.basename(found.file) : found.source;

  const renaming = !deck.single && locations.type === "filename" && next.type !== current.type;
  if (!renaming) {
    if (text === found.text) return { slideId, hashes: { [key]: found.hash } };
    const written = await atomicWrite(found.file, text, { baseHash: found.hash, roots });
    return { slideId, hashes: { [key]: written.hash } };
  }

  const newSource = renamedSource(found.source, next.type);
  const newFile = path.resolve(deck.root, newSource);
  if (newSource !== found.source && (await fs.stat(newFile).catch(() => null))) {
    throw new ValidationError(`A slide file named ${newSource} already exists.`, { fields: [{ path: "type", message: "That file name is taken." }], field: "type" });
  }
  const written = await atomicWrite(newFile, text, { baseHash: null, roots });
  let manifest;
  try {
    manifest = await updateManifest(deck, found.source, newSource);
  } catch (error) {
    await fs.rm(newFile, { force: true });
    throw error;
  }
  await fs.rm(found.file, { force: true });
  return { slideId: newSource, hashes: { [newSource]: written.hash, "presentation.yml": manifest.hash } };
}

// ---------- structure: insert, remove, reorder ----------

/**
 * The text of a brand-new slide: frontmatter for a title (folder decks only), directive comments,
 * the Markdown, then notes. `typeInText` is false when the folder file name carries the type.
 */
function newSlideText(next, { single, eol, typeInText }) {
  if (single && next.title != null) {
    throw new ValidationError("Single-file slides take their title from the first # heading.", { fields: [{ path: "title", message: "Use a # heading instead." }], field: "title" });
  }
  let front = "";
  if (next.title != null) {
    const doc = parseDocument("");
    doc.set("title", next.title);
    front = `---${eol}${doc.toString().replace(/\n$/, "").split("\n").join(eol)}${eol}---${eol}`;
  }
  const directives = [
    ...(next.template ? [["template", next.template]] : []),
    ...(typeInText && next.type ? [["type", next.type]] : []),
    ...Object.entries(next.directives)
  ].map(([key, value]) => `<!-- ${key}: ${value} -->`);
  const blocks = [[...directives, ...(next.markdown ? [next.markdown.split("\n").join(eol)] : [])].join(eol)];
  if (next.notes) blocks.push(notesComment(next.notes, eol, true));
  return `${front}${blocks.filter(Boolean).join(`${eol}${eol}`)}${eol}`;
}

async function validateTemplate(deck, next) {
  if (!next.template) return;
  const templates = await deckTemplates(deck);
  if (!lookupTemplate(next.template, templates).found) {
    throw new ValidationError(`Unknown template "${next.template}".`, { fields: [{ path: "template", message: "Pick a template this deck knows." }], field: "template" });
  }
}

/** The file whose hash guards a structure change: the manifest, or the single file. */
async function structureBase(deckPath, baseHash) {
  const deck = await deckInfo(deckPath);
  const file = deck.single ? deck.absolute : deck.manifestFile;
  const { text, hash } = deck.single ? await readFileWithHash(file) : deck.manifest;
  if (hash !== baseHash) throw new FileConflictError(file, hash);
  return { deck, file, text, hash, key: deck.single ? path.basename(file) : "presentation.yml" };
}

/**
 * A single-file deck as glue and chunk cores: `glue[0] core[0] glue[1] core[1] … glue[n]`.
 * Cores are the chunks without surrounding whitespace; glue holds frontmatter, blank lines and `---`.
 * Exported so tools can swap one slide's text and keep every other byte (Studio's slide restore).
 */
export function chunkLayout(text) {
  const bom = text.startsWith("﻿") ? 1 : 0;
  const cores = chunkSpans(text.slice(bom)).map(([from, to]) => {
    const raw = text.slice(from + bom, to + bom);
    const start = from + bom + (raw.length - raw.trimStart().length);
    return [start, start + raw.trim().length];
  });
  const glue = [];
  let cursor = 0;
  for (const [from, to] of cores) {
    glue.push(text.slice(cursor, from));
    cursor = to;
  }
  glue.push(text.slice(cursor));
  return { cores: cores.map(([from, to]) => text.slice(from, to)), glue };
}

/** The inverse of chunkLayout: `joinLayout(chunkLayout(text)) === text`. */
export function joinLayout({ cores, glue }) {
  return cores.map((core, index) => glue[index] + core).join("") + glue[cores.length];
}

function manifestSeq(doc) {
  const slides = doc.get("slides", true);
  if (!slides?.items) throw new ValidationError("presentation.yml has no slides list.", { path: "presentation.yml" });
  return slides;
}

const itemSource = (item) => (typeof item?.value === "string" ? item.value : item?.get?.("file"));

/** The next free `NN` across the manifest and the slides folder (gaps are not reused). */
async function nextSlideNumber(deck, slides, dir) {
  const names = [...slides.map((source) => path.basename(source)), ...(await fs.readdir(path.join(deck.root, dir)).catch(() => []))];
  const numbers = names.map((name) => /^(\d+)[_.-]/.exec(name)).filter(Boolean).map((match) => Number(match[1]));
  return Math.max(0, ...numbers) + 1;
}

/**
 * Inserts a slide after `afterSlideId` (null puts it first). A folder deck gets
 * `slides/NN_<type|slide>.slide.md` with the next free `NN` and a manifest entry; a single-file
 * deck gets a new chunk. `baseHash` is the manifest's (folder) or the file's (single) hash.
 * Returns `{ slideId, hashes }`.
 */
export async function insertSlide(deckPath, afterSlideId, draft, baseHash) {
  const next = normalizeDraft(draft);
  const base = await structureBase(deckPath, baseHash);
  const { deck } = base;
  await validateTemplate(deck, next);
  const eol = base.text.includes("\r\n") ? "\r\n" : "\n";

  if (deck.single) {
    if (/^\s*---\s*$/m.test(next.markdown)) {
      throw new ValidationError("A line with only --- starts a new slide in a single-file deck.", { fields: [{ path: "markdown", message: "Remove the --- line." }], field: "markdown" });
    }
    const layout = chunkLayout(base.text);
    const after = afterSlideId == null ? -1 : Number(/^#(\d+)$/.exec(String(afterSlideId))?.[1] ?? NaN);
    if (afterSlideId != null && !(after >= 0 && after < layout.cores.length)) throw slideNotFound(afterSlideId);
    const core = newSlideText(next, { single: true, eol, typeInText: true }).trim();
    const separator = `${eol}${eol}---${eol}${eol}`;
    if (after === -1) layout.cores[0] = `${core}${separator}${layout.cores[0]}`;
    else layout.cores[after] = `${layout.cores[after]}${separator}${core}`;
    const written = await atomicWrite(base.file, joinLayout(layout), { baseHash: base.hash, roots: [deck.root] });
    return { slideId: `#${after + 1}`, hashes: { [base.key]: written.hash } };
  }

  const slides = manifestSlides(deck.meta);
  const after = afterSlideId == null ? -1 : slides.indexOf(String(afterSlideId));
  if (afterSlideId != null && after === -1) throw slideNotFound(afterSlideId);
  const dir = path.posix.dirname(slides[Math.max(after, 0)] ?? "slides/x") || "slides";
  const number = String(await nextSlideNumber(deck, slides, dir)).padStart(2, "0");
  const source = path.posix.join(dir, `${number}_${next.type ?? "slide"}.slide.md`);
  const file = path.resolve(deck.root, source);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = newSlideText(next, { single: false, eol: "\n", typeInText: false });
  const slide = await atomicWrite(file, text, { baseHash: null, roots: [deck.root] });

  const doc = parseDocument(base.text);
  const seq = manifestSeq(doc);
  const node = doc.createNode(source);
  const quoted = seq.items.find((item) => typeof item?.value === "string")?.type;
  if (quoted) node.type = quoted;
  seq.items.splice(after + 1, 0, node);
  try {
    const manifest = await atomicWrite(base.file, doc.toString(), { baseHash: base.hash, roots: [deck.root] });
    return { slideId: source, hashes: { [source]: slide.hash, "presentation.yml": manifest.hash } };
  } catch (error) {
    await fs.rm(file, { force: true });
    throw error;
  }
}

/**
 * Removes a slide. A folder deck loses the manifest entry, then the file; a single-file deck
 * loses the chunk and one separator. The last slide can't be removed (LastSlideError).
 */
export async function removeSlide(deckPath, slideId, baseHash) {
  const base = await structureBase(deckPath, baseHash);
  const { deck } = base;

  if (deck.single) {
    const layout = chunkLayout(base.text);
    const index = Number(/^#(\d+)$/.exec(String(slideId))?.[1] ?? NaN);
    if (!(index >= 0 && index < layout.cores.length)) throw slideNotFound(slideId);
    if (layout.cores.length === 1) throw new LastSlideError(base.file);
    // Drop the chunk with the glue after it, or, for the last chunk, the glue before it.
    if (index < layout.cores.length - 1) layout.glue.splice(index + 1, 1);
    else layout.glue.splice(index, 1);
    layout.cores.splice(index, 1);
    const written = await atomicWrite(base.file, joinLayout(layout), { baseHash: base.hash, roots: [deck.root] });
    return { hashes: { [base.key]: written.hash } };
  }

  const slides = manifestSlides(deck.meta);
  const index = slides.indexOf(String(slideId));
  if (index === -1) throw slideNotFound(slideId);
  if (slides.length === 1) throw new LastSlideError(base.file);
  const doc = parseDocument(base.text);
  const seq = manifestSeq(doc);
  const at = seq.items.findIndex((item) => itemSource(item) === String(slideId));
  seq.items.splice(at, 1);
  const manifest = await atomicWrite(base.file, doc.toString(), { baseHash: base.hash, roots: [deck.root] });
  // The file goes only when no other manifest entry still points at it.
  if (!slides.some((source, other) => other !== index && source === String(slideId))) {
    const file = path.resolve(deck.root, String(slideId));
    if (!path.relative(deck.root, file).startsWith("..")) await fs.rm(file, { force: true });
  }
  return { hashes: { "presentation.yml": manifest.hash } };
}

/**
 * Reorders slides. `slideIds` must be a permutation of the current IDs. A folder deck changes
 * only the manifest's `slides:` order (files are never renamed); a single-file deck moves the
 * chunks and keeps each chunk's bytes, with blank lines and separators staying in place.
 */
export async function reorderSlides(deckPath, slideIds, baseHash) {
  const base = await structureBase(deckPath, baseHash);
  const { deck } = base;
  const current = deck.single ? chunkLayout(base.text).cores.map((_, index) => `#${index}`) : manifestSlides(deck.meta);
  const wanted = Array.isArray(slideIds) ? slideIds.map(String) : [];
  const sorted = (list) => [...list].sort().join("\n");
  if (wanted.length !== current.length || sorted(wanted) !== sorted(current)) {
    throw new ValidationError("slideIds must list every slide of the deck exactly once.", { fields: [{ path: "slideIds", message: "Not a permutation of the deck's slides." }], field: "slideIds" });
  }

  let text;
  if (deck.single) {
    const layout = chunkLayout(base.text);
    const cores = wanted.map((id) => layout.cores[Number(id.slice(1))]);
    text = joinLayout({ cores, glue: layout.glue });
  } else {
    const doc = parseDocument(base.text);
    const seq = manifestSeq(doc);
    const items = seq.items.filter((item) => typeof itemSource(item) === "string");
    if (items.every((item) => typeof item.value === "string" && item.range)) {
      // Swap the entries' source text in place, so comments, quoting and spacing stay put.
      const pool = new Map();
      for (const item of items) {
        const raw = base.text.slice(item.range[0], item.range[1]);
        pool.set(item.value, [...(pool.get(item.value) ?? []), raw]);
      }
      const replacements = items.map((item, index) => ({ from: item.range[0], to: item.range[1], raw: pool.get(wanted[index]).shift() }));
      text = base.text;
      for (const { from, to, raw } of replacements.reverse()) text = text.slice(0, from) + raw + text.slice(to);
    } else {
      const pool = new Map();
      for (const item of items) pool.set(itemSource(item), [...(pool.get(itemSource(item)) ?? []), item]);
      seq.items = wanted.map((id) => pool.get(id).shift());
      text = doc.toString();
    }
  }
  if (text === base.text) return { hashes: { [base.key]: base.hash } };
  const written = await atomicWrite(base.file, text, { baseHash: base.hash, roots: [deck.root] });
  return { hashes: { [base.key]: written.hash } };
}
