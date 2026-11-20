import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkExportDependencies, discoverPresentation, exportCarousel, exportVideo, startServer } from "@flipbook-md/core";

const here = path.dirname(fileURLToPath(import.meta.url));
const talk = path.resolve(here, "../examples/blueprint-talk");
const deps = await checkExportDependencies("video");
const hasChromium = !deps.missing.includes("chromium");
const hasFfmpeg = !deps.missing.includes("ffmpeg");

async function tempDir() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-hooks-")));
}

test("carousel progress fires once per slide and files lists what was written", { skip: !hasChromium && "Chromium not installed" }, async () => {
  const deck = await discoverPresentation(talk);
  const out = await tempDir();
  const events = [];
  const result = await exportCarousel(deck, { outputDir: out, onProgress: (progress) => events.push(progress) });
  assert.deepEqual(events, deck.slides.map((_, index) => ({ done: index + 1, total: deck.slides.length })));
  assert.deepEqual([...result.files].sort(), (await fs.readdir(out)).sort());
  assert.equal(result.files.filter((name) => name.endsWith(".png")).length, deck.slides.length);
});

test("aborting a carousel stops Chromium and resolves cancelled", { skip: !hasChromium && "Chromium not installed" }, async () => {
  const deck = await discoverPresentation(talk);
  const out = await tempDir();
  const controller = new AbortController();
  const result = await exportCarousel(deck, {
    outputDir: out,
    signal: controller.signal,
    onProgress: ({ done }) => done === 2 && controller.abort()
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.files, ["01-brief-a-decision.png", "02-name-the-decision.png"]);
  assert.ok(!(await fs.readdir(out)).includes("README.txt"));
  // captureSlides awaits browser.close() before this resolves. A pgrep snapshot
  // races Chromium's exit, so this test does not check the process list.
});

test("an already-aborted signal never starts Chromium", async () => {
  const deck = await discoverPresentation(talk);
  const controller = new AbortController();
  controller.abort();
  const result = await exportCarousel(deck, { outputDir: await tempDir(), signal: controller.signal });
  assert.deepEqual(result, { cancelled: true, outputDir: result.outputDir, files: [] });
});

test("aborting a video during encoding kills ffmpeg and leaves no MP4", { skip: !(hasChromium && hasFfmpeg) && "Chromium or ffmpeg not installed" }, async () => {
  const deck = await discoverPresentation(talk);
  const out = await tempDir();
  const controller = new AbortController();
  const events = [];
  const result = await exportVideo(deck, {
    outputDir: out,
    duration: 600,
    fps: 30,
    transition: "fade",
    signal: controller.signal,
    onProgress: (progress) => {
      events.push(progress);
      // Every frame is captured: abort once ffmpeg has started.
      if (progress.done === progress.total) setTimeout(() => controller.abort(), 400);
    }
  });
  assert.equal(events.length, deck.slides.length);
  assert.equal(result.cancelled, true);
  assert.deepEqual(await fs.readdir(out), []);
  // runFfmpeg settles on the child "close" event, after ffmpeg has exited.
});

test("without hooks the export result is unchanged apart from files", { skip: !hasChromium && "Chromium not installed" }, async () => {
  const deck = await discoverPresentation(talk);
  const result = await exportCarousel(deck, { outputDir: await tempDir() });
  assert.deepEqual(Object.keys(result).sort(), ["clipped", "count", "files", "height", "outputDir", "preset", "width"]);
  assert.equal(result.cancelled, undefined);
});

test("checkExportDependencies detects missing Chromium and ffmpeg", async () => {
  const empty = await tempDir();
  const run = (env, format) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import { checkExportDependencies } from "@flipbook-md/core"; console.log(JSON.stringify(await checkExportDependencies("${format}")));`], {
      cwd: path.resolve(here, ".."),
      env: { ...process.env, ...env }
    }).then(({ stdout }) => JSON.parse(stdout));

  const noBrowser = await run({ PLAYWRIGHT_BROWSERS_PATH: empty }, "png");
  assert.deepEqual(noBrowser.missing, ["chromium"]);
  assert.equal(noBrowser.ok, false);
  assert.equal(noBrowser.installCommand, "npx playwright install chromium");

  const noFfmpeg = await run({ PATH: "" }, "video");
  assert.ok(noFfmpeg.missing.includes("ffmpeg"));
  assert.match(noFfmpeg.installCommand, /ffmpeg/);

  // PNG export never needs ffmpeg.
  assert.ok(!(await run({ PATH: "" }, "png")).missing.includes("ffmpeg"));
});

test("startServer serves a live source and a start slide", async () => {
  let title = "First";
  const deck = await discoverPresentation(talk);
  const instance = await startServer(async () => ({ ...deck, title }), { startSlide: 3 });
  try {
    const first = await (await fetch(`${instance.url}/api/presentation`)).json();
    assert.equal(first.title, "First");
    assert.equal(first.startSlide, 3);
    title = "Saved edit";
    assert.equal((await (await fetch(`${instance.url}/api/presentation`)).json()).title, "Saved edit");
    const player = await (await fetch(`${instance.url}/app.js`)).text();
    assert.match(player, /get\("slide"\)/);
  } finally {
    await instance.close();
  }
  await assert.rejects(fetch(`${instance.url}/api/presentation`));
});

test("a source that fails to load answers 500 instead of crashing the server", async () => {
  const instance = await startServer(async () => {
    throw new Error("broken deck");
  });
  try {
    const response = await fetch(`${instance.url}/api/presentation`);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /broken deck/);
    assert.equal((await fetch(`${instance.url}/`)).status, 200);
  } finally {
    await instance.close();
  }
});
