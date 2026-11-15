import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";
import { stringify as stringifyYaml } from "yaml";
import { AssetError, writeDeckAsset } from "./assets.js";
import { measureMarkdown } from "./blueprint.js";
import { assertFree, loadKit, validateNewDeck } from "./internal/deck-checks.js";
import { DeckExistsError, ValidationError, atomicWrite } from "./writer.js";

// D23: the deterministic mapping from a document to slides (US-18).
const COVER_MAX_CHARS = 300;
const SLIDE_MAX_CHARS = 700;
const SLIDE_MAX_ITEMS = 8;

const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const KEPT_SCHEMES = /^(?:https?:|data:)/i;

/** Collects dropped content as `{ kind, reason, count, detail? }`, one entry per kind, reason and detail. */
function droppedList() {
  const entries = [];
  return {
    entries,
    add(kind, reason, detail, count = 1) {
      const found = entries.find((entry) => entry.kind === kind && entry.reason === reason && entry.detail === detail);
      if (found) found.count += count;
      else entries.push({ kind, reason, count, ...(detail ? { detail } : {}) });
    }
  };
}

/**
 * Rewrites image references in one non-code block. `imageMap` maps a source href to its new href,
 * or to null to remove it silently. Other local images are removed and counted.
 */
function rewriteImages(text, imageMap, dropped) {
  return text.replace(IMAGE, (match, alt, href, title) => {
    if (Object.hasOwn(imageMap, href)) {
      const next = imageMap[href];
      return next == null ? "" : `![${alt}](${next}${title ?? ""})`;
    }
    if (KEPT_SCHEMES.test(href)) return match;
    dropped.add("relative-image", "not-uploaded", href);
    return "";
  });
}

/** Removes inline HTML from a paragraph's text, using the lexer's own inline tokens. */
function withoutInlineHtml(token, dropped) {
  let text = token.raw;
  for (const inline of token.tokens ?? []) {
    if (inline.type === "html") {
      text = text.replace(inline.raw, "");
      dropped.add("html", "removed");
    }
  }
  return text;
}

/**
 * Turns the document's top-level tokens into blocks: `{ text, items, list }`. A list becomes one
 * block per item so a long list can be split between slides; `list` groups items of one list.
 */
function toBlocks(tokens, imageMap, dropped, listIds) {
  const blocks = [];
  for (const token of tokens) {
    if (token.type === "space") continue;
    if (token.type === "html") {
      if (token.raw.trim()) dropped.add("html", "removed");
      continue;
    }
    if (token.type === "code") {
      blocks.push({ text: token.raw.trimEnd(), items: 0, list: null });
      continue;
    }
    if (token.type === "heading") {
      // Only `###` and `####`+ reach here: `###` stays, deeper headings become bold lines.
      const text = token.depth === 3 ? `### ${token.text}` : `**${token.text}**`;
      blocks.push({ text: rewriteImages(text, imageMap, dropped), items: 0, list: null });
      continue;
    }
    if (token.type === "list") {
      const id = listIds.next++;
      for (const item of token.items) {
        const text = rewriteImages(item.raw.trimEnd(), imageMap, dropped);
        blocks.push({ text, items: 1, list: id });
      }
      continue;
    }
    const raw = token.type === "paragraph" ? withoutInlineHtml(token, dropped) : token.raw;
    const text = rewriteImages(raw.trimEnd(), imageMap, dropped).trim();
    if (text) blocks.push({ text, items: 0, list: null });
  }
  return blocks;
}

function joinBlocks(blocks) {
  let out = "";
  blocks.forEach((block, index) => {
    if (index > 0) out += block.list != null && block.list === blocks[index - 1].list ? "\n" : "\n\n";
    out += block.text;
  });
  return out;
}

function charsOf(blocks) {
  return measureMarkdown(joinBlocks(blocks)).chars;
}

/** Splits blocks into chunks of at most 8 list items and 700 visible characters; never splits a block. */
function chunk(blocks) {
  const chunks = [];
  let current = [];
  let items = 0;
  for (const block of blocks) {
    const tooMany = items + block.items > SLIDE_MAX_ITEMS;
    const tooLong = current.length > 0 && charsOf([...current, block]) > SLIDE_MAX_CHARS;
    if (current.length && (tooMany || tooLong)) {
      chunks.push(current);
      current = [];
      items = 0;
    }
    current.push(block);
    items += block.items;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function slidesFor(heading, blocks) {
  const parts = blocks.length ? chunk(blocks) : [[]];
  return parts.map((part, index) => {
    const title = heading == null ? null : index === 0 ? heading : `${heading} (${index + 1})`;
    const body = joinBlocks(part);
    const markdown = [title == null ? null : `# ${title}`, body || null].filter(Boolean).join("\n\n");
    return { markdown: `${markdown}\n` };
  });
}

/**
 * Maps a Markdown or text document to slides (D23). Pure: reads and writes nothing.
 * `options.title` is the fallback title (a docx title or the file name); `options.images` maps a
 * source image href to the path it is stored at, or to null to drop it silently.
 */
export function sourceToSlides(markdown, options = {}) {
  const source = String(markdown ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  let content = source;
  let frontTitle = null;
  try {
    const parsed = matter(source);
    content = parsed.content;
    if (parsed.data && typeof parsed.data.title === "string" && parsed.data.title.trim()) frontTitle = parsed.data.title.trim();
  } catch {
    // Not valid frontmatter: read the whole text as Markdown.
  }
  if (!content.trim()) throw new ValidationError("This file is empty.", { field: "source" });

  const imageMap = options.images ?? {};
  const dropped = droppedList();
  const listIds = { next: 0 };
  const tokens = marked.lexer(content);

  // Sections: a `#` or `##` heading, or a `---` line, starts one. The first `#` is the deck title.
  let title = null;
  const intro = [];
  const sections = [];
  let current = null;
  let pending = [];
  const flush = () => {
    const blocks = toBlocks(pending, imageMap, dropped, listIds);
    pending = [];
    if (current) current.blocks.push(...blocks);
    else intro.push(...blocks);
  };
  for (const token of tokens) {
    const isBreak = token.type === "hr" || (token.type === "heading" && token.depth <= 2);
    if (!isBreak) {
      pending.push(token);
      continue;
    }
    flush();
    if (token.type === "heading" && token.depth === 1 && title == null && !current) {
      title = token.text.trim();
      continue;
    }
    current = { heading: token.type === "heading" ? token.text.trim() : null, blocks: [] };
    sections.push(current);
  }
  flush();

  const deckTitle = title ?? frontTitle ?? (String(options.title ?? "").trim() || "Untitled");
  const slides = [];
  if (intro.length && charsOf(intro) <= COVER_MAX_CHARS) {
    slides.push(...slidesFor(deckTitle, intro));
  } else {
    slides.push({ markdown: `# ${deckTitle}\n` });
    if (intro.length) slides.push(...slidesFor(deckTitle, intro));
  }
  for (const section of sections) {
    // A `---` with nothing after it before the next break adds no slide.
    if (section.heading == null && !section.blocks.length) continue;
    slides.push(...slidesFor(section.heading, section.blocks));
  }
  const allBlocks = [...intro, ...sections.flatMap((section) => section.blocks)];
  return {
    title: deckTitle,
    slides,
    sections: sections.filter((section) => section.heading != null || section.blocks.length).length,
    chars: charsOf(allBlocks) + Array.from(deckTitle).length,
    dropped: dropped.entries
  };
}

function slideFileName(index, markdown) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1] ?? "slide";
  const slug = heading
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  // A hyphen, not an underscore, so the file name never sets a page type.
  return `slides/${String(index + 1).padStart(2, "0")}-${slug || "slide"}.slide.md`;
}

const ASSET_REASONS = { ASSET_TOO_LARGE: "size", ASSET_TYPE: "type", ASSET_CONTENT_MISMATCH: "type" };

/**
 * Creates a folder deck from a document (D23, D25): images first through writeDeckAsset, their
 * references rewritten to the stored paths, then slides and presentation.yml. Removes the whole
 * folder on failure. `images[].fileName` is the href the Markdown uses for that image.
 */
export async function importDeck(dir, options = {}) {
  const { name, title, group } = validateNewDeck({ ...options, kind: "folder" });
  const root = await fs.realpath(dir).catch(() => {
    throw new ValidationError(`Folder does not exist: ${dir}`, { path: dir });
  });
  if (group) await loadKit(group);
  // Fails on an empty document before anything is written.
  sourceToSlides(options.markdown, { title });

  const folder = path.join(root, name);
  await assertFree(root, name);
  try {
    await fs.mkdir(folder);
  } catch (error) {
    if (error.code === "EEXIST") throw new DeckExistsError(folder);
    throw error;
  }
  try {
    const imageMap = {};
    const assets = [];
    const imageDropped = droppedList();
    for (const image of options.images ?? []) {
      try {
        const stored = await writeDeckAsset(folder, image.fileName, image.bytes);
        imageMap[image.fileName] = stored.path;
        assets.push(stored.path);
      } catch (error) {
        if (!(error instanceof AssetError)) throw error;
        imageMap[image.fileName] = null;
        imageDropped.add("image", ASSET_REASONS[error.code] ?? "type", path.extname(String(image.fileName)).slice(1).toUpperCase() || undefined);
      }
    }
    const mapped = sourceToSlides(options.markdown, { title, images: imageMap });
    await fs.mkdir(path.join(folder, "slides"));
    const files = mapped.slides.map((slide, index) => slideFileName(index, slide.markdown));
    for (const [index, slide] of mapped.slides.entries()) {
      await atomicWrite(path.join(folder, files[index]), slide.markdown, { baseHash: null, roots: [root] });
    }
    const manifest = { title, ...(group ? { group } : {}), slides: files };
    await atomicWrite(path.join(folder, "presentation.yml"), stringifyYaml(manifest), { baseHash: null, roots: [root] });
    return { path: folder, slides: files.length, assets, dropped: [...imageDropped.entries, ...mapped.dropped] };
  } catch (error) {
    // Leave nothing half-made behind.
    await fs.rm(folder, { recursive: true, force: true });
    throw error;
  }
}
