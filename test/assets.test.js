import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AssetError,
  MAX_ASSET_BYTES,
  assetBaseName,
  assetReferences,
  assetsDir,
  checkAsset,
  imageSize,
  listDeckAssets,
  loadPresentation,
  removeDeckAsset,
  writeDeckAsset
} from "@flipbook-md/core";

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

test("imageSize reads each type's header", () => {
  assert.deepEqual(imageSize(".png", IMAGES["a.png"]), { width: 40, height: 30 });
  assert.deepEqual(imageSize(".jpg", IMAGES["a.jpg"]), { width: 50, height: 20 });
  assert.deepEqual(imageSize(".gif", IMAGES["a.gif"]), { width: 16, height: 9 });
  assert.deepEqual(imageSize(".webp", IMAGES["a.webp"]), { width: 100, height: 50 });
  assert.deepEqual(imageSize(".svg", IMAGES["a.svg"]), { width: 12, height: 8 });
  // Lossy and lossless WebP, and an SVG sized only by its viewBox.
  const vp8 = Buffer.concat([Buffer.from("RIFF0000WEBPVP8 "), Buffer.alloc(10), Buffer.from([0x40, 0x01, 0xf0, 0x00])]);
  assert.deepEqual(imageSize(".webp", vp8), { width: 320, height: 240 });
  const vp8l = Buffer.concat([Buffer.from("RIFF0000WEBPVP8L"), Buffer.alloc(5), Buffer.from([0x3f, 0x80, 0x1d, 0x00])]);
  assert.deepEqual(imageSize(".webp", vp8l), { width: 64, height: 119 });
  assert.deepEqual(imageSize(".svg", Buffer.from('<svg viewBox="0 0 300 150.4"></svg>')), { width: 300, height: 150 });
  assert.deepEqual(imageSize(".svg", Buffer.from('<svg width="100%" height="50%" viewBox="0,0,20,10"/>')), { width: 20, height: 10 });
  // Broken or truncated headers give null instead of throwing.
  assert.equal(imageSize(".png", IMAGES["a.png"].subarray(0, 10)), null);
  assert.equal(imageSize(".jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), null);
  assert.equal(imageSize(".jpg", Buffer.from([0xff, 0xd8, 0x12, 0x34, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(imageSize(".svg", Buffer.from("<svg>")), null);
});

test("listDeckAssets lists the images in the assets folder with their sizes", async () => {
  const { deck } = await folderDeck();
  assert.deepEqual(await listDeckAssets(deck), []);
  for (const [name, bytes] of Object.entries(IMAGES)) await writeDeckAsset(deck, name, bytes);
  await fs.writeFile(path.join(deck, "assets", "notes.txt"), "not an image");
  await fs.writeFile(path.join(deck, "assets", ".hidden.png"), IMAGES["a.png"]);
  await fs.mkdir(path.join(deck, "assets", "nested.png"));
  await fs.symlink(path.join(deck, "assets", "a.png"), path.join(deck, "assets", "link.png"));
  await fs.writeFile(path.join(deck, "assets", "broken.png"), Buffer.from([0x89, 0x50]));
  const listed = await listDeckAssets(deck);
  assert.deepEqual(listed.map((asset) => asset.path), ["assets/a.gif", "assets/a.jpg", "assets/a.png", "assets/a.svg", "assets/a.webp", "assets/broken.png"]);
  assert.deepEqual(listed[2], { path: "assets/a.png", bytes: IMAGES["a.png"].length, mime: "image/png", width: 40, height: 30 });
  assert.deepEqual(listed[5], { path: "assets/broken.png", bytes: 2, mime: "image/png", width: null, height: null });
});

test("listDeckAssets refuses an assets folder that points outside the deck", async () => {
  const { root, deck } = await folderDeck();
  const outside = path.join(root, "elsewhere");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.png"), IMAGES["a.png"]);
  await fs.symlink(outside, path.join(deck, "assets"));
  await assert.rejects(listDeckAssets(deck), (error) => error.code === "PATH_OUTSIDE_ROOT");
});

test("assetReferences finds images used by slides, notes and the deck's own theme", async () => {
  const { deck } = await folderDeck();
  await fs.mkdir(path.join(deck, "slides"));
  await fs.writeFile(path.join(deck, "presentation.yml"), "title: Talk\nslides:\n  - slides/01.slide.md\n  - slides/02.slide.md\n");
  await fs.writeFile(
    path.join(deck, "slides", "01.slide.md"),
    '# One\n\n![Cover](assets/a.png)\n\n<img src="../assets/b.gif">\n\n![Remote](https://example.com/c.png)\n\n![Again](assets/a.png)\n'
  );
  await fs.writeFile(path.join(deck, "slides", "02.slide.md"), "# Two\n\n[a link](assets/doc.pdf)\n\nNote: see ![x](assets/n%20ote.webp)\n");
  await fs.writeFile(path.join(deck, "presentation.css"), ':root { background: url("assets/bg.svg"); } .x { background: url(https://example.com/x.png) } .y { background: url(assets/bg.svg) }');
  const { presentation } = await loadPresentation(deck);
  assert.deepEqual(await assetReferences(presentation), [
    { source: "slides/01.slide.md", index: 0, path: "assets/a.png" },
    { source: "slides/01.slide.md", index: 0, path: "assets/b.gif" },
    { source: "slides/02.slide.md", index: 1, path: "assets/n ote.webp" },
    { source: "theme", index: null, path: "assets/bg.svg" }
  ]);
});

test("removeDeckAsset deletes one image in the assets folder only", async () => {
  const { deck } = await folderDeck();
  const { path: written } = await writeDeckAsset(deck, "a.png", IMAGES["a.png"]);
  await removeDeckAsset(deck, written);
  await assert.rejects(fs.stat(path.join(deck, written)));
  await assert.rejects(removeDeckAsset(deck, written), code("ASSET_NOT_FOUND"));
  for (const bad of ["presentation.yml", "assets/../presentation.yml", "assets/sub/a.png", "assets/.hidden.png", "assets/a.txt", "/etc/hosts", "assets\\a.png", ""]) {
    await assert.rejects(removeDeckAsset(deck, bad), (error) => error.code === "PATH_OUTSIDE_ROOT", bad);
  }
  assert.ok((await fs.stat(path.join(deck, "presentation.yml"))).isFile());

  // A symlinked image is unlinked; its target stays.
  await writeDeckAsset(deck, "real.png", IMAGES["a.png"]);
  await fs.symlink(path.join(deck, "assets", "real.png"), path.join(deck, "assets", "alias.png"));
  await removeDeckAsset(deck, "assets/alias.png");
  assert.ok((await fs.stat(path.join(deck, "assets", "real.png"))).isFile());
});
