import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AssetError, MAX_ASSET_BYTES, assetBaseName, assetsDir, checkAsset, writeDeckAsset } from "@flipbook-md/core";

// Smallest headers each type is recognized by (US-16, D19).
export const IMAGES = {
  "a.png": Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 40, 0, 0, 0, 30, 8, 6, 0, 0, 0])]),
  "a.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 50, 1, 1, 0x11, 0, 0xff, 0xd9]),
  "a.gif": Buffer.concat([Buffer.from("GIF89a"), Buffer.from([16, 0, 9, 0, 0, 0, 0]), Buffer.from(";")]),
  "a.webp": Buffer.concat([Buffer.from("RIFF"), Buffer.from([30, 0, 0, 0]), Buffer.from("WEBPVP8X"), Buffer.from([10, 0, 0, 0, 0, 0, 0, 0, 99, 0, 0, 49, 0, 0])]),
  "a.svg": Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"></svg>')
};

async function tempRoot() {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "flipbook-assets-")));
}
async function folderDeck() {
  const root = await tempRoot();
  const deck = path.join(root, "talk");
  await fs.mkdir(deck);
  await fs.writeFile(path.join(deck, "presentation.yml"), "title: Talk\nslides:\n  - slides/01.slide.md\n");
  return { root, deck };
}
const code = (expected) => (error) => error instanceof AssetError && error.code === expected;

test("checkAsset accepts each image type by its bytes", () => {
  for (const [name, bytes] of Object.entries(IMAGES)) {
    const { ext, mime } = checkAsset(name.toUpperCase(), bytes);
    assert.equal(ext, path.extname(name));
    assert.match(mime, /^image\//);
  }
  assert.equal(checkAsset("photo.jpeg", IMAGES["a.jpg"]).mime, "image/jpeg");
  assert.ok(checkAsset("bom.svg", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<svg></svg>")])));
  assert.ok(checkAsset("doctype.svg", Buffer.from('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg/>')));
});

test("checkAsset refuses other types, oversize files and disguised content", () => {
  assert.throws(() => checkAsset("a.bmp", Buffer.from("BM")), code("ASSET_TYPE"));
  assert.throws(() => checkAsset("noext", IMAGES["a.png"]), code("ASSET_TYPE"));
  assert.throws(() => checkAsset("a.mp4", Buffer.alloc(10)), code("ASSET_TYPE"));
  const big = Buffer.concat([IMAGES["a.png"], Buffer.alloc(MAX_ASSET_BYTES)]);
  assert.throws(() => checkAsset("big.png", big), code("ASSET_TOO_LARGE"));
  assert.ok(checkAsset("edge.png", Buffer.concat([IMAGES["a.png"], Buffer.alloc(MAX_ASSET_BYTES - IMAGES["a.png"].length)])));
  assert.throws(() => checkAsset("page.png", Buffer.from("<html><script>alert(1)</script>")), code("ASSET_CONTENT_MISMATCH"));
  assert.throws(() => checkAsset("a.gif", IMAGES["a.png"]), code("ASSET_CONTENT_MISMATCH"));
  assert.throws(() => checkAsset("a.webp", Buffer.from("RIFF0000WAVE")), code("ASSET_CONTENT_MISMATCH"));
  assert.throws(() => checkAsset("a.svg", Buffer.from("<html><svg></svg></html>")), code("ASSET_CONTENT_MISMATCH"));
  assert.throws(() => checkAsset("a.svg", Buffer.from([0xff, 0xfe, 0x3c, 0x00])), code("ASSET_CONTENT_MISMATCH"));
  assert.throws(() => checkAsset("empty.png", Buffer.alloc(0)), code("ASSET_CONTENT_MISMATCH"));
});

test("assetBaseName makes a kebab-case name with a fallback", () => {
  assert.equal(assetBaseName("Cover Photo.PNG"), "cover-photo.png");
  assert.equal(assetBaseName("Fóto  ção!!.jpeg"), "foto-cao.jpeg");
  assert.equal(assetBaseName("★.png"), "image.png");
  assert.equal(assetBaseName("фото.png"), "image.png");
  assert.equal(assetBaseName("../../etc/passwd.png"), "passwd.png");
  assert.equal(assetBaseName("C:\\Users\\me\\shot.gif"), "shot.gif");
  assert.equal(assetBaseName(`${"x".repeat(100)}.webp`), `${"x".repeat(60)}.webp`);
});

test("assetsDir is the deck's assets folder, or the one next to a single file", async () => {
  const { root, deck } = await folderDeck();
  assert.equal(await assetsDir(deck), path.join(deck, "assets"));
  await fs.writeFile(path.join(root, "solo.slide.md"), "# Solo\n");
  assert.equal(await assetsDir(path.join(root, "solo.slide.md")), path.join(root, "assets"));
});

test("writeDeckAsset stores uploads under unique names and never overwrites", async () => {
  const { deck } = await folderDeck();
  const first = await writeDeckAsset(deck, "Cover Photo.PNG", IMAGES["a.png"]);
  assert.deepEqual(first, { path: "assets/cover-photo.png", hash: first.hash, bytes: IMAGES["a.png"].length });
  const second = await writeDeckAsset(deck, "cover photo.png", IMAGES["a.png"]);
  assert.equal(second.path, "assets/cover-photo-2.png");
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => writeDeckAsset(deck, "same.gif", IMAGES["a.gif"])));
  assert.deepEqual([a, b, c].map((r) => r.path).sort(), ["assets/same-2.gif", "assets/same-3.gif", "assets/same.gif"]);
  assert.deepEqual(await fs.readFile(path.join(deck, first.path)), IMAGES["a.png"]);
  const names = await fs.readdir(path.join(deck, "assets"));
  assert.ok(!names.some((name) => name.includes("flipbook-tmp")), names.join());
});

test("writeDeckAsset writes a single-file deck's image next to it", async () => {
  const root = await tempRoot();
  await fs.writeFile(path.join(root, "solo.slide.md"), "# Solo\n");
  const result = await writeDeckAsset(path.join(root, "solo.slide.md"), "logo.svg", IMAGES["a.svg"]);
  assert.equal(result.path, "assets/logo.svg");
  assert.ok((await fs.stat(path.join(root, "assets", "logo.svg"))).isFile());
});

test("writeDeckAsset checks the upload and never writes outside the deck", async () => {
  const { root, deck } = await folderDeck();
  await assert.rejects(writeDeckAsset(deck, "x.png", Buffer.from("not an image")), code("ASSET_CONTENT_MISMATCH"));
  await assert.rejects(fs.stat(path.join(deck, "assets", "x.png")));

  const escaped = await writeDeckAsset(deck, "../x.png", IMAGES["a.png"]);
  assert.equal(escaped.path, "assets/x.png");
  await assert.rejects(fs.stat(path.join(deck, "x.png")));

  // assets/ as a symlink to a folder outside the deck.
  const other = await folderDeck();
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(other.deck, "assets"));
  await assert.rejects(writeDeckAsset(other.deck, "a.png", IMAGES["a.png"]), (error) => error.code === "PATH_OUTSIDE_ROOT");
  assert.deepEqual(await fs.readdir(outside), []);

  // assets as a file.
  const third = await folderDeck();
  await fs.writeFile(path.join(third.deck, "assets"), "");
  await assert.rejects(writeDeckAsset(third.deck, "a.png", IMAGES["a.png"]), (error) => error.code === "VALIDATION_FAILED");
});
