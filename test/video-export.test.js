import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportVideo } from "../src/export.js";


test("video export rejects a missing duration before it renders", async () => {
  const presentation = { title: "Short", theme: "midnight", themeCss: "", root: os.tmpdir(), slides: [{ index: 0, title: "One", html: "<h1>One</h1>" }] };
  await assert.rejects(() => exportVideo(presentation, { outputDir: os.tmpdir() }), /duration/);
});

