import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuiltInReadOnlyError, FileConflictError, ValidationError, atomicWrite, hashBytes, libraryRoot, readFileWithHash } from "@flipbook-md/core";

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-writer-")));
}

async function leftovers(dir) {
  return (await fs.readdir(dir)).filter((name) => name.endsWith(".flipbook-tmp"));
}

test("readFileWithHash hashes the exact bytes, BOM and CRLF included", async () => {
  const root = await tempRoot();
  const bytes = Buffer.from("﻿# Hi\r\n", "utf8");
  await fs.writeFile(path.join(root, "a.md"), bytes);
  const { text, hash } = await readFileWithHash(path.join(root, "a.md"));
  assert.equal(text, "﻿# Hi\r\n");
  assert.equal(hash, hashBytes(bytes));
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("atomicWrite creates a new file with baseHash null and updates it with the matching hash", async () => {
  const root = await tempRoot();
  const file = path.join(root, "slide.md");
  const created = await atomicWrite(file, "one\n", { baseHash: null, roots: [root] });
  assert.equal(await fs.readFile(file, "utf8"), "one\n");
  const updated = await atomicWrite(file, "two\n", { baseHash: created.hash, roots: [root] });
  assert.equal(await fs.readFile(file, "utf8"), "two\n");
  assert.equal(updated.hash, (await readFileWithHash(file)).hash);
  assert.deepEqual(await leftovers(root), []);
});

test("a mismatched baseHash throws FileConflictError with the current hash and leaves the file alone", async () => {
  const root = await tempRoot();
  const file = path.join(root, "slide.md");
  await fs.writeFile(file, "on disk\n");
  const current = hashBytes("on disk\n");
  await assert.rejects(atomicWrite(file, "mine\n", { baseHash: hashBytes("stale"), roots: [root] }), (error) => {
    assert.ok(error instanceof FileConflictError);
    assert.equal(error.code, "FILE_CONFLICT");
    assert.equal(error.currentHash, current);
    return true;
  });
  await assert.rejects(atomicWrite(file, "mine\n", { baseHash: null, roots: [root] }), FileConflictError);
  assert.equal(await fs.readFile(file, "utf8"), "on disk\n");
});

test("a failed rename (ENOSPC) removes the temp file and keeps the original", async () => {
  const root = await tempRoot();
  const file = path.join(root, "slide.md");
  await fs.writeFile(file, "original\n");
  const rename = mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  });
  try {
    await assert.rejects(atomicWrite(file, "new\n", { baseHash: hashBytes("original\n"), roots: [root] }), { code: "ENOSPC" });
  } finally {
    rename.mock.restore();
  }
  assert.equal(await fs.readFile(file, "utf8"), "original\n");
  assert.deepEqual(await leftovers(root), []);
});

test("writes under core's built-in library throw BuiltInReadOnlyError", async () => {
  const builtIn = path.join(libraryRoot(), "templates", "marvel_content_guide.yml");
  const before = await readFileWithHash(builtIn);
  await assert.rejects(atomicWrite(builtIn, "x", { baseHash: before.hash, roots: [libraryRoot()] }), (error) => {
    assert.ok(error instanceof BuiltInReadOnlyError);
    assert.equal(error.code, "BUILTIN_READ_ONLY");
    return true;
  });
  assert.equal((await readFileWithHash(builtIn)).hash, before.hash);
});

test("writes outside the allowed roots throw, including through a symlink", async () => {
  const root = await tempRoot();
  const outside = await tempRoot();
  await assert.rejects(atomicWrite(path.join(outside, "x.md"), "x", { baseHash: null, roots: [root] }), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, "PATH_OUTSIDE_ROOT");
    return true;
  });
  await assert.rejects(atomicWrite(path.join(root, "..", path.basename(outside), "x.md"), "x", { baseHash: null, roots: [root] }), { code: "PATH_OUTSIDE_ROOT" });
  await fs.symlink(outside, path.join(root, "link"));
  await assert.rejects(atomicWrite(path.join(root, "link", "x.md"), "x", { baseHash: null, roots: [root] }), { code: "PATH_OUTSIDE_ROOT" });
  await fs.writeFile(path.join(outside, "target.md"), "keep");
  await fs.symlink(path.join(outside, "target.md"), path.join(root, "file-link.md"));
  await assert.rejects(atomicWrite(path.join(root, "file-link.md"), "x", { baseHash: hashBytes("keep"), roots: [root] }), { code: "PATH_OUTSIDE_ROOT" });
  assert.equal(await fs.readFile(path.join(outside, "target.md"), "utf8"), "keep");
  assert.deepEqual(await fs.readdir(outside), ["target.md"]);
});

test("atomicWrite insists on a baseHash and at least one root", async () => {
  const root = await tempRoot();
  await assert.rejects(atomicWrite(path.join(root, "x"), "x", { roots: [root] }), ValidationError);
  await assert.rejects(atomicWrite(path.join(root, "x"), "x", { baseHash: null, roots: [] }), ValidationError);
});
