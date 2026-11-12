import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { cssForStyleTag, inlineThemeAssets, sampleThemeCss, scopeThemeCss } from "./theme.js";
import { inlinePresentationFiles } from "./attachments.js";
import { libraryRoot, templateAreaCss } from "./templates.js";
import { bandHtml, counterHtml, counterNumbers, exportOrnament, parseChrome, surfaceCss } from "./chrome.js";
import { renderDraftSlide } from "./presentation.js";
import { ValidationError } from "./writer.js";

// `scale` multiplies the export type and spacing, so short and tall images keep a readable layout.
export const PRESETS = {
  instagram: { width: 1080, height: 1350, label: "instagram", use: "Instagram carousel" },
  x: { width: 1080, height: 1080, label: "x", use: "X multi-image post" },
  linkedin: { width: 1080, height: 1350, label: "linkedin", use: "LinkedIn portrait post" },
  "linkedin-square": { width: 1080, height: 1080, label: "linkedin-square", use: "LinkedIn square post" },
  "linkedin-landscape": { width: 1200, height: 627, label: "linkedin-landscape", use: "LinkedIn landscape or link preview image", scale: 0.6 },
  youtube: { width: 1080, height: 1080, label: "youtube", use: "YouTube community post" },
  tiktok: { width: 1080, height: 1920, label: "tiktok", use: "TikTok photo post", scale: 1.2 }
};

function presetList() {
  return Object.values(PRESETS).map((preset) => `"${preset.label}" (${preset.width}×${preset.height})`).join(", ");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function themeColors(theme) {
  const themes = {
    midnight: { bg: "#0b1020", panel: "#121a2e", text: "#f3f6ff", muted: "#a5b1ca", accent: "#7c9cff", line: "#2a3652" },
    light: { bg: "#f5f7fb", panel: "#ffffff", text: "#172033", muted: "#566176", accent: "#315ee8", line: "#dce2ed" },
    paper: { bg: "#f4efe5", panel: "#fffaf0", text: "#28251f", muted: "#71695e", accent: "#b14e35", line: "#ded4c5" },
    forest: { bg: "#0d1915", panel: "#14251e", text: "#effaf1", muted: "#a6c0ae", accent: "#70d49a", line: "#2a4838" }
  };
  return themes[String(theme).toLowerCase()] ?? themes.midnight;
}

function embedScriptString(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function exportBaseCss(preset, c) {
  const tall = preset.height >= 1200;
  const px = (value) => Math.round(value * (preset.scale ?? 1));
  const title = px(tall ? 64 : 57);
  const body = px(tall ? 32 : 29);
  const padTop = px(tall ? 94 : 76);
  return `:host{--slide-bg:${c.bg};--slide-text:${c.text};--slide-muted:${c.muted};--slide-accent:${c.accent};--slide-mint:${c.accent};--slide-heading:${c.text};--slide-line:${c.line};--slide-code:${c.panel};box-sizing:border-box;padding:${padTop}px ${px(86)}px ${px(66)}px;position:relative;background:radial-gradient(ellipse at 90% 0%, color-mix(in srgb, var(--slide-accent) 13%, transparent), transparent 42%), var(--slide-bg);color:var(--slide-text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*,*::before,*::after{box-sizing:border-box}
.top{display:flex;align-items:center;justify-content:space-between;color:var(--slide-muted);font-size:${px(21)}px;letter-spacing:.11em;text-transform:uppercase;font-weight:700;gap:${px(24)}px}
.brand{color:var(--slide-text)}.brand span{color:var(--slide-accent)}
.rule{height:2px;background:var(--slide-line);margin:${px(28)}px 0 ${px(40)}px}
.content{flex:1;min-height:0;overflow:hidden;font-size:${body}px;line-height:1.42;overflow-wrap:anywhere}
.content h1{font-size:${title}px;line-height:1.08;letter-spacing:-.045em;margin:0 0 ${px(34)}px;font-weight:800}
.content h2{font-size:1.3em;line-height:1.15;margin:0 0 ${px(25)}px;letter-spacing:-.025em}
.content h3{font-size:1.05em;margin:${px(22)}px 0 ${px(12)}px;color:var(--slide-heading)}
.content p{margin:0 0 ${px(23)}px}
.content ul,.content ol{padding-left:1.2em;margin:0 0 ${px(24)}px}
.content li{padding-left:.18em;margin:.32em 0}
.content strong{color:var(--slide-accent)}
.content a{color:var(--slide-accent);text-decoration:none}
.content blockquote{border-left:5px solid var(--slide-accent);padding:${px(5)}px 0 ${px(5)}px ${px(24)}px;margin:${px(24)}px 0;color:var(--slide-muted)}
.content code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.78em;background:var(--slide-code);border:1px solid var(--slide-line);border-radius:8px;padding:.1em .28em}
.content pre{background:var(--slide-code);border:1px solid var(--slide-line);border-radius:16px;padding:${px(24)}px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.72em;line-height:1.45;max-height:100%;overflow:hidden}
.content pre code{padding:0;border:0;background:transparent;font-size:1em}
.content table{width:100%;border-collapse:collapse;font-size:.78em}
.content th,.content td{text-align:left;padding:${px(12)}px;border-bottom:1px solid var(--slide-line)}
.content img{max-width:100%;max-height:${px(360)}px;object-fit:contain}
.content hr{border:0;border-top:1px solid var(--slide-line);margin:${px(25)}px 0}
.footer{display:flex;justify-content:space-between;align-items:center;gap:${px(18)}px;color:var(--slide-muted);font-size:${px(19)}px;margin-top:${px(28)}px;padding-top:${px(20)}px;border-top:1px solid var(--slide-line)}
.counter{color:var(--slide-text);font-variant-numeric:tabular-nums;font-weight:700}`;
}

// The slide's document parts. `assetBase` points deck files at a URL prefix instead of inlining them.
async function documentParts(presentation, slide, index, preset, assetBase) {
  const colors = themeColors(presentation.theme);
  const { width, height } = preset;
  const rebase = (text) => String(text ?? "").split("/presentation-file/").join(assetBase);
  const rawTheme = presentation.themeCss || "";
  const themeCss = cssForStyleTag(assetBase ? rebase(rawTheme) : await inlineThemeAssets(rawTheme, presentation.root));
  const base = cssForStyleTag(exportBaseCss(preset, colors) + templateAreaCss(".content") + surfaceCss(presentation, ".content", preset));
  const slideHtml = assetBase ? rebase(slide.html) : await inlinePresentationFiles(slide.html, presentation.root);
  const template = escapeHtml(slide.template || "flow");
  const layout = slide.layout ? ` data-layout="${escapeHtml(slide.layout)}"` : "";
  const role = slide.role ? ` data-role="${escapeHtml(slide.role)}"` : "";
  const density = slide.density ? ` data-density="${escapeHtml(slide.density)}"` : "";
  const inner = presentation.chrome
    ? await chromeInner(presentation, slide, index, template, layout, role, density, slideHtml)
    : `<div class="top"><div class="brand">FLIPBOOK <span>MD</span></div><div>${escapeHtml(presentation.title)}</div></div><div class="rule"></div><main class="content" data-template="${template}"${layout}${role}${density}><div class="slide-body">${slideHtml}</div></main><div class="footer"><span>Made with Flipbook MD</span><span class="counter">${String(index + 1).padStart(2, "0")} / ${String(presentation.slides.length).padStart(2, "0")}</span></div>`;
  const payload = `<style>@layer base{${base}}</style>${themeCss ? `<style>${themeCss}</style>` : ""}${inner}`;
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=${width}, initial-scale=1"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${colors.bg}}#canvas{box-sizing:border-box!important;width:${width}px!important;height:${height}px!important;display:flex!important;flex-direction:column!important}</style></head>`;
  return { head, payload };
}

export async function renderExportDocument(presentation, slide, index, preset) {
  const { head, payload } = await documentParts(presentation, slide, index, preset, null);
  return `${head}<body><div id="canvas" class="canvas"></div><script>document.getElementById("canvas").attachShadow({mode:"open"}).innerHTML=${embedScriptString(payload)};</script></body></html>`;
}

/**
 * One slide as a standalone, script-free HTML document for a sandboxed preview iframe.
 * The slide markup matches renderExportDocument; the canvas uses a declarative shadow root.
 * `draft` (a SlideDraft) replaces the slide's saved content; `assetBase` (for example
 * "/api/decks/<id>/files/") serves deck files by URL instead of inlining them.
 */
export async function renderSlideDocument(presentation, index, { draft = null, assetBase = null, preset = "instagram" } = {}) {
  const chosen = PRESETS[preset];
  if (!chosen) throw new ValidationError(`Unknown preset "${preset}".`, { field: "preset" });
  const saved = presentation.slides[index];
  if (!saved) throw new ValidationError(`No slide at index ${index}.`, { code: "SLIDE_NOT_FOUND", field: "slideId" });
  const slide = draft ? await renderDraftSlide(presentation, index, draft) : saved;
  const deck = draft ? { ...presentation, slides: presentation.slides.map((item, at) => (at === index ? slide : item)) } : presentation;
  const { head, payload } = await documentParts(deck, slide, index, chosen, assetBase);
  return `${head}<body><div id="canvas" class="canvas"><template shadowrootmode="open">${payload}</template></div></body></html>`;
}

/** The sample deck: one slide per common role. */
export const SAMPLE_SLIDES = [
  { role: "cover", template: "cover", markdown: "# Sample deck\n\nA subtitle that sets the scene" },
  { role: "content", markdown: "# Content\n\nA short paragraph with **bold** and *italic* text.\n\n- First point\n- Second point\n- Third point" },
  { role: "quote", markdown: "> The best way to predict the future is to invent it.\n\n— Alan Kay" },
  {
    role: "media",
    markdown: `# Media\n\n![Placeholder](data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#2a3550"/><path d="M560 620l200-240 160 180 100-110 180 170z" fill="#4a5a80"/><circle cx="1040" cy="330" r="60" fill="#4a5a80"/></svg>').toString("base64")})`
  },
  { role: "callout", markdown: "# 42%\n\nA callout states one number or claim, large." }
];

function sampleTemplateFor(sample, templates) {
  if (sample.template) return sample.template;
  // A kit template made for this role shows the kit's layout; otherwise flow.
  return Object.values(templates).find((template) => template?.role === sample.role)?.name ?? null;
}

/**
 * One script-free HTML document showing sample slides (cover, content, quote, media, callout)
 * in a grid, styled by `themeCss` with `templates`, `chrome` (raw group `chrome:` value) and
 * `canvas`. Theme `url()`s resolve inside `assetRoot` (default: the built-in themes folder);
 * other local references are dropped. `slides` replaces the samples (`{ markdown, template?, role? }`).
 * `presentation` instead shows that loaded deck's first `count` slides with `themeCss` in place
 * of its own theme (its templates, chrome, canvas and files are kept; url()s resolve in its root).
 */
export async function renderSampleDocument({ themeCss = "", templates = {}, chrome = null, canvas = "midnight", slides = SAMPLE_SLIDES, assetRoot = null, preset: presetName = "instagram", presentation = null, count = 5 } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new ValidationError(`Unknown preset "${presetName}".`, { field: "preset" });
  if (presentation) {
    const deck = { ...presentation, themeCss: scopeThemeCss(await sampleThemeCss(themeCss, presentation.root)) };
    const shown = deck.slides.slice(0, Math.max(1, count));
    const labels = shown.map((slide, index) => slide.type ?? slide.role ?? `slide ${index + 1}`);
    return sampleGrid(deck, shown, labels, preset, presentation.theme);
  }
  const root = assetRoot ?? path.join(libraryRoot(), "themes");
  const parsedChrome = chrome == null ? null : parseChrome(chrome);
  const deck = {
    title: "Sample deck",
    theme: canvas,
    themeCss: scopeThemeCss(await sampleThemeCss(themeCss, root)),
    root,
    sourcePath: null,
    templates,
    chrome: parsedChrome,
    slides: slides.map((_, index) => ({ index, source: `sample ${index + 1}`, title: "", template: "flow", html: "" }))
  };
  for (const [index, sample] of slides.entries()) {
    const template = sampleTemplateFor(sample, templates);
    deck.slides[index] = await renderDraftSlide(deck, index, { markdown: sample.markdown, ...(template ? { template } : {}) });
  }
  return sampleGrid(deck, deck.slides, slides.map((sample, index) => sample.role ?? `slide ${index + 1}`), preset, canvas);
}

async function sampleGrid(deck, shown, labels, preset, canvas) {
  const colors = themeColors(canvas);
  const scale = 0.25;
  const figures = [];
  for (const [index, slide] of shown.entries()) {
    const { payload } = await documentParts(deck, slide, index, preset, null);
    const label = escapeHtml(labels[index]);
    figures.push(`<figure class="sample" data-sample="${label}"><div class="frame"><div class="canvas"><template shadowrootmode="open">${payload}</template></div></div><figcaption>${label}</figcaption></figure>`);
  }
  const { width, height } = preset;
  const style = `html,body{margin:0;background:#0006;color:#ccd;font:13px system-ui,sans-serif}.samples{display:flex;flex-wrap:wrap;gap:16px;padding:16px}.sample{margin:0}.frame{width:${width * scale}px;height:${height * scale}px;overflow:hidden;border-radius:6px}.canvas{box-sizing:border-box;width:${width}px;height:${height}px;display:flex;flex-direction:column;background:${colors.bg};transform:scale(${scale});transform-origin:0 0}figcaption{margin-top:6px;text-align:center}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${style}</style></head><body><div class="samples">${figures.join("")}</div></body></html>`;
}

async function chromeInner(presentation, slide, index, template, layout, role, density, slideHtml) {
  const ornament = await exportOrnament(presentation.chrome.counter.ornament, presentation.root);
  const number = counterNumbers(presentation.slides)[index];
  const counter = number ? counterHtml(presentation.chrome.counter, number, ornament) : "";
  const header = bandHtml(presentation.chrome.header, "header");
  const footer = bandHtml(presentation.chrome.footer, "footer");
  return `${header}<main class="content" data-template="${template}"${layout}${role}${density}><div class="slide-body">${slideHtml}</div></main>${footer}${counter}`;
}

function fileSlug(value, fallback) {
  const slug = String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

// Each slide is one input frame, so the image2 rate is slideCount / duration.
function holdFrameRate(slideCount, duration) {
  const scale = 1_000_000;
  let numerator = Math.round(slideCount * scale);
  let denominator = Math.round(Number(duration) * scale);
  if (denominator === 0) throw new Error("Video export duration is too small to time the frames.");
  const shared = gcd(numerator, denominator);
  numerator /= shared;
  denominator /= shared;
  return `${numerator}/${denominator}`;
}

async function existing(dir, names) {
  const present = new Set(await fs.readdir(dir).catch(() => []));
  return names.filter((name) => present.has(name));
}

/** Thrown inside an export when its signal aborts; the export resolves with `{ cancelled: true }`. */
class ExportCancelled extends Error {}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new ExportCancelled("Export cancelled.");
}

const INSTALL = {
  chromium: "npx playwright install chromium",
  ffmpeg: process.platform === "darwin" ? "brew install ffmpeg" : process.platform === "win32" ? "winget install ffmpeg" : "sudo apt install ffmpeg"
};

function commandRuns(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/**
 * Checks what an export needs: Chromium (Playwright's browser) for every format, ffmpeg for video.
 * Returns `{ ok, missing: ("chromium"|"ffmpeg")[], installCommand }`; `installCommand` is null when ok.
 */
export async function checkExportDependencies(format = "png") {
  const missing = [];
  try {
    const { chromium } = await import("playwright");
    await fs.access(chromium.executablePath());
  } catch {
    missing.push("chromium");
  }
  if (format === "video" && !(await commandRuns("ffmpeg", ["-version"]))) missing.push("ffmpeg");
  return { ok: missing.length === 0, missing, installCommand: missing.length ? missing.map((name) => INSTALL[name]).join(" && ") : null };
}

async function launchChromium() {
  let chromium;
  try { ({ chromium } = await import("playwright")); }
  catch { throw new Error('Slide export needs Playwright. Run "npm install" and then "npx playwright install chromium".'); }
  return chromium.launch({ headless: true });
}

async function captureSlides(presentation, preset, pathFor, { onProgress, signal } = {}) {
  throwIfAborted(signal);
  const browser = await launchChromium();
  const clipped = [];
  // Closing the browser interrupts a capture in flight.
  const stop = () => browser.close().catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  const total = presentation.slides.length;
  try {
    const page = await browser.newPage({ viewport: { width: preset.width, height: preset.height }, deviceScaleFactor: 1 });
    for (const [index, slide] of presentation.slides.entries()) {
      throwIfAborted(signal);
      await page.setContent(await renderExportDocument(presentation, slide, index, preset), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      const overflows = await page.evaluate(() => {
        const content = document.getElementById("canvas").shadowRoot.querySelector(".content");
        return content.scrollHeight > content.clientHeight + 1 || content.scrollWidth > content.clientWidth + 1;
      });
      if (overflows) clipped.push(index + 1);
      await page.locator("#canvas").screenshot({ path: pathFor(index, slide), animations: "disabled" });
      onProgress?.({ done: index + 1, total });
    }
  } catch (error) {
    if (signal?.aborted) throw new ExportCancelled("Export cancelled.");
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }
  return { clipped };
}

function runFfmpeg(args, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ExportCancelled("Export cancelled."));
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });
    child.on("exit", () => signal?.removeEventListener("abort", stop));
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") reject(new Error("Video export needs ffmpeg on PATH. Install ffmpeg and try again."));
      else reject(error);
    });
    child.on("close", (code) => {
      if (signal?.aborted) reject(new ExportCancelled("Export cancelled."));
      else if (code === 0) resolve();
      else {
        const tail = stderr.trim().split("\n").slice(-4).join(" ");
        reject(new Error(`ffmpeg could not write the video (exit ${code}). ${tail}`));
      }
    });
  });
}

/**
 * Exports one PNG per slide. `onProgress({ done, total })` fires after each slide; aborting
 * `signal` stops Chromium and resolves with `{ cancelled: true, outputDir, files }` (the PNGs
 * written so far stay). `files` lists the written file names.
 */
export async function exportCarousel(presentation, { preset: presetName = "instagram", outputDir = "dist/carousel", onProgress, signal } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Unknown preset "${presetName}". Choose ${presetList()}.`);
  const absoluteOutput = path.resolve(outputDir);
  await fs.mkdir(absoluteOutput, { recursive: true });
  const files = [];
  let clipped;
  try {
    ({ clipped } = await captureSlides(presentation, preset, (index, slide) => {
      const slug = fileSlug(slide.title, "slide");
      const name = `${String(index + 1).padStart(2, "0")}-${slug}.png`;
      files.push(name);
      return path.join(absoluteOutput, name);
    }, { onProgress, signal }));
  } catch (error) {
    if (error instanceof ExportCancelled) return { cancelled: true, outputDir: absoluteOutput, files: await existing(absoluteOutput, files) };
    throw error;
  }
  files.push("README.txt");
  await fs.writeFile(path.join(absoluteOutput, "README.txt"), `Exported by Flipbook MD\nPresentation: ${presentation.title}\nPreset: ${preset.label}\nDimensions: ${preset.width}x${preset.height}\nSlides: ${presentation.slides.length}\n\nUpload the PNG files in numeric order as a multi-image post. Check the platform's current image limits and cropping rules before publishing.\n`);
  return { count: presentation.slides.length, preset: preset.label, width: preset.width, height: preset.height, outputDir: absoluteOutput, files, clipped };
}

const XFADE = { fade: "fade", slide: "slideleft" };

function videoArgs({ framesDir, count, seconds, rate, xfade, fadeSeconds, outputFile }) {
  const encode = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(rate), "-an", outputFile];
  if (!xfade || count < 2) {
    // image2 holds every slide for the same span. ffmpeg 9 rejects -r combined with
    // -fps_mode vfr, and a concat list ran longer than --duration.
    return ["-y", "-framerate", holdFrameRate(count, seconds), "-start_number", "1", "-i", path.join(framesDir, "%d.png"), ...encode];
  }
  // Slide k starts fading in at k * step. Each clip runs one step plus the fade it
  // shares with the next slide, so the chain ends at exactly `seconds`.
  const step = (seconds - fadeSeconds) / count;
  const clip = (step + fadeSeconds).toFixed(6);
  const inputs = [];
  const chain = [];
  let last = "0:v";
  for (let index = 0; index < count; index += 1) {
    inputs.push("-loop", "1", "-framerate", String(rate), "-t", clip, "-i", path.join(framesDir, `${index + 1}.png`));
    if (index === 0) continue;
    chain.push(`[${last}][${index}:v]xfade=transition=${xfade}:duration=${fadeSeconds}:offset=${(index * step).toFixed(6)}[v${index}]`);
    last = `v${index}`;
  }
  return ["-y", ...inputs, "-filter_complex", chain.join(";"), "-map", `[${last}]`, "-t", String(seconds), ...encode];
}

/**
 * Exports an MP4. `onProgress({ done, total })` fires after each slide frame; aborting `signal`
 * stops Chromium or ffmpeg and resolves with `{ cancelled: true }`.
 */
export async function exportVideo(presentation, { preset: presetName = "instagram", outputDir = "dist/video", duration, fps = 30, transition = "none", transitionDuration = 0.4, onProgress, signal } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Unknown preset "${presetName}". Choose ${presetList()}.`);
  const seconds = Number(duration);
  const rate = Number(fps);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 1800) {
    throw new Error("Video export needs a duration in seconds, greater than 0 and at most 1800. Pass --duration or set export.duration in configuration.yml.");
  }
  if (!Number.isInteger(rate) || rate < 1 || rate > 60) {
    throw new Error("Video fps must be an integer from 1 to 60.");
  }
  if (!presentation.slides?.length) throw new Error("Video export needs at least one slide.");
  const count = presentation.slides.length;
  if (seconds / count < 1 / rate) {
    throw new Error(`Video duration ${seconds}s is too short for ${count} slide(s) at ${rate} fps. Each slide needs at least one frame: use ${Math.ceil((count / rate) * 100) / 100}s or more.`);
  }
  const xfade = transition === "none" ? null : XFADE[transition];
  const fadeSeconds = Number(transitionDuration);
  if (transition !== "none" && !xfade) throw new Error("Video transition must be none, fade, or slide.");
  if (xfade && (!Number.isFinite(fadeSeconds) || fadeSeconds <= 0 || fadeSeconds > 5)) {
    throw new Error("Video transition duration must be a number of seconds greater than 0 and at most 5.");
  }
  if (xfade && count > 1 && (seconds - fadeSeconds) / count < fadeSeconds) {
    throw new Error(`A ${fadeSeconds}s transition does not fit ${count} slide(s) in ${seconds}s. Use a longer --duration or a shorter --transition-duration.`);
  }
  if (preset.width % 2 !== 0 || preset.height % 2 !== 0) {
    throw new Error(`Video export needs even dimensions. ${preset.label} is ${preset.width}×${preset.height}.`);
  }

  const requested = path.resolve(outputDir);
  const outputFile = requested.toLowerCase().endsWith(".mp4")
    ? requested
    : path.join(requested, `${fileSlug(presentation.title, "flipbook")}.mp4`);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const framesDir = await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-video-"));
  try {
    let clipped;
    try {
      ({ clipped } = await captureSlides(presentation, preset, (index) => path.join(framesDir, `${index + 1}.png`), { onProgress, signal }));
      await runFfmpeg(videoArgs({ framesDir, count, seconds, rate, xfade, fadeSeconds, outputFile }), signal);
    } catch (error) {
      if (error instanceof ExportCancelled) {
        await fs.rm(outputFile, { force: true });
        return { cancelled: true, outputDir: path.dirname(outputFile), files: [] };
      }
      throw error;
    }
    // Named after the video so it never replaces a README.txt that is already in the folder.
    const readme = `${outputFile}.txt`;
    await fs.writeFile(readme, `Exported by Flipbook MD\nPresentation: ${presentation.title}\nFormat: video\nPreset: ${preset.label}\nDimensions: ${preset.width}x${preset.height}\nDuration: ${seconds}s\nFrame rate: ${rate} fps\nTransition: ${xfade ? `${transition}, ${fadeSeconds}s` : "none"}\nSlides: ${presentation.slides.length}\nFile: ${path.basename(outputFile)}\n\nEach slide is held for the same share of the duration. The file is H.264 in an MP4.\n`);
    return {
      format: "video",
      count: 1,
      slides: presentation.slides.length,
      preset: preset.label,
      width: preset.width,
      height: preset.height,
      outputDir: path.dirname(outputFile),
      outputFile,
      files: [path.basename(outputFile), path.basename(readme)],
      duration: seconds,
      fps: rate,
      transition: xfade ? transition : "none",
      transitionDuration: fadeSeconds,
      clipped
    };
  } finally {
    await fs.rm(framesDir, { recursive: true, force: true });
  }
}
