import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportVideo } from "../src/export.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-md-"));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function runFlipbook(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repo, "bin/flipbook.js"), ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], (error, stdout) => {
      if (error) reject(error);
      else resolve(Number(stdout.trim()));
    });
  });
}

test("video export rejects a missing duration before it renders", async () => {
  const presentation = { title: "Short", theme: "midnight", themeCss: "", root: os.tmpdir(), slides: [{ index: 0, title: "One", html: "<h1>One</h1>" }] };
  await assert.rejects(() => exportVideo(presentation, { outputDir: os.tmpdir() }), /duration/);
});

