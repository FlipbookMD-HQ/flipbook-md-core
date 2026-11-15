# @flipbook-md/core

The shared library behind [Flipbook MD](https://github.com/uminocelo/flipbook-md). It loads Markdown decks, applies templates, groups, themes and blueprints, serves the slide player, and exports PNG carousels and MP4 videos.

It is one of three Flipbook MD projects:

| Project | What it is |
| --- | --- |
| [`flipbook-md`](https://github.com/uminocelo/flipbook-md) | The `flipbook` command: present, check and export decks. |
| `@flipbook-md/core` (this package) | The library both apps build on: loading, rendering, blueprints, export and document import. |
| Flipbook Studio | A self-hosted editor for the same deck files, with optional AI from a model running on your machine. **Coming soon.** |

If you only want to present or export a deck, install the CLI instead:

```sh
npm install -g flipbook-md
```

## Install

```sh
npm install @flipbook-md/core
```

Requires Node.js 20 or newer. Export needs Chromium (`npx playwright install chromium`), and video export also needs `ffmpeg` on your `PATH`.

## Use

```js
import { discoverPresentation, startServer, exportCarousel } from "@flipbook-md/core";

const deck = await discoverPresentation("./my-talk");
const { url } = await startServer(deck);
console.log(`Open ${url}`);

await exportCarousel(deck, { preset: "instagram", outputDir: "dist/carousel" });
```

### Create and write files

```js
import { createDeck, readFileWithHash, atomicWrite, FileConflictError } from "@flipbook-md/core";

// A folder deck with one placeholder slide per required step of the kit's blueprint.
const { path } = await createDeck("./decks", { name: "my-guide", title: "My guide", kind: "folder", group: "marvel_content_guide" });

// Hash-checked, atomic writes: pass the hash you read, or null for a new file.
const { text, hash } = await readFileWithHash(`${path}/slides/01_cover.slide.md`);
await atomicWrite(`${path}/slides/01_cover.slide.md`, text.replace("Guide", "Field guide"), { baseHash: hash, roots: ["./decks"] });
```

`atomicWrite` refuses files outside `roots`, refuses core's built-in `library/` (`BuiltInReadOnlyError`), and throws `FileConflictError` when the file changed since you read it. Each typed error has a `code` such as `FILE_CONFLICT` or `DECK_EXISTS`.

### Edit slides

```js
import { readSlide, updateSlide, renderSlideDocument, discoverPresentation } from "@flipbook-md/core";

// Folder decks: the manifest path is the slide ID. Single-file decks: "#0", "#1", …
const { draft, locations, hash } = await readSlide("./decks/my-guide", "slides/01_cover.slide.md");

// Only changed fields are written, where they were found. Unchanged files stay byte-for-byte identical.
await updateSlide("./decks/my-guide", "slides/01_cover.slide.md", { ...draft, template: "summary" }, hash);

// A script-free preview document (declarative shadow DOM), optionally for an unsaved draft.
const deck = await discoverPresentation("./decks/my-guide");
const html = await renderSlideDocument(deck, 0, { draft, assetBase: "/files/" });
```

### Read and write kits

```js
import { readKit, writeKit, renderSampleDocument } from "@flipbook-md/core";

// library: ~/Documents/flipbook/{themes,templates,blueprints}/<name>; deck: presentation.css,
// templates.yml, blueprint.yml in deckDir; builtin: core's own library (read-only).
const ref = { kind: "theme", name: "dusk", scope: "library" };
const { hash } = await writeKit(ref, { source: ":root { --accent: #f05; }" }, null); // null = create
const kit = await readKit(ref); // { source, parsed, hash, builtIn, path, invalid }
await writeKit(ref, { source: kit.source.replace("#f05", "#0f8") }, kit.hash);

// Cover, content, quote, media and callout samples in one script-free document.
const html = await renderSampleDocument({ themeCss: kit.source, canvas: "midnight" });
```

YAML kits are validated by the same normalizers the loader uses before anything is written.

Form edits send a merge patch instead of the whole file. Comments, key order and quoting survive, and `null` deletes a key:

```js
const talk = { kind: "blueprint", name: "talk", scope: "library" };
await writeKit(talk, { patch: { types: { point: { max_chars: 250 } } } }, (await readKit(talk)).hash);
// A deck's templates.yml is patched one template at a time (created if missing):
await writeKit({ kind: "template", name: "quote", scope: "deck", deckDir }, { patch: { align: "start" } }, hash);
```

### Copy and rename media kits

```js
import { copyGroup, findDecksUsingGroup, readKit, renameGroup } from "@flipbook-md/core";

await copyGroup({ name: "marvel_content_guide", scope: "builtin" }, "my_kit"); // ~/Documents/flipbook/templates/my_kit.yml
const { hash } = await readKit({ kind: "group", name: "my_kit", scope: "library" });
await renameGroup({ name: "my_kit", scope: "library" }, "brand", hash); // my_kit_* templates become brand_*
console.log(await findDecksUsingGroup("my_kit", ["talks/q3", "intro.slide.md"])); // decks still on the old name
```

### Check a draft blueprint

```js
import { evaluateDraftBlueprint, loadPresentation } from "@flipbook-md/core";

const { presentation } = await loadPresentation("talk", { blueprint: "evaluate" });
const result = evaluateDraftBlueprint(presentation, "pages:\n  - type: cover\ntypes:\n  cover: {}\n");
if (result.errors) console.log("The blueprint itself is invalid:", result.errors);
else console.log(result.violations); // the slides that would fail
```

### Export with progress and cancel

```js
import { checkExportDependencies, exportCarousel } from "@flipbook-md/core";

const deps = await checkExportDependencies("png"); // "video" also checks ffmpeg
if (!deps.ok) console.log(`Run: ${deps.installCommand}`);

const controller = new AbortController();
const result = await exportCarousel(deck, {
  preset: "instagram",
  outputDir: "dist/carousel",
  onProgress: ({ done, total }) => console.log(`${done}/${total}`),
  signal: controller.signal // controller.abort() stops Chromium (and ffmpeg for video)
});
if (result.cancelled) console.log("Cancelled; kept", result.files);
else console.log(result.files); // ["01-intro.png", …, "README.txt"]
```

`startServer` also takes a function instead of a presentation (called per request, so saved edits show after a reload) and a `startSlide` option; the player honours `?slide=N` too.

### Check against the blueprint without throwing

```js
import { loadPresentation } from "@flipbook-md/core";

// Violations come back as data (the CLI still throws and prints `message`).
// An unsaved draft can be applied in memory first.
const { presentation, violations } = await loadPresentation("./decks/my-guide", {
  draft: { slideId: "slides/02_point.slide.md", draft }
});
// violations: [{ source: "slides/02_point.slide.md", code: "MAX_CHARS", message: "slides/02_point.slide.md: visible text is 412 characters; maximum is 250." }]
```

Codes: `ORDER`, `MISSING_TYPE`, `TEMPLATE`, `MAX_CHARS`, `MAX_ITEMS`, `REQUIRED`, `NOT_ALLOWED`. A deck's own `blueprint.yml` wins over its group's. A slide out of order doesn't hide content violations: every slide of a known type is still checked against its rules.

### Add, reorder and delete slides

```js
import { insertSlide, removeSlide, reorderSlides, readFileWithHash } from "@flipbook-md/core";

// Structure writes are guarded by the manifest's hash (or the single file's).
const { hash } = await readFileWithHash("./decks/my-guide/presentation.yml");

// Writes slides/NN_<type|slide>.slide.md with the next free NN and adds it after the given slide.
const added = await insertSlide("./decks/my-guide", "slides/01_cover.slide.md", draft, hash);

// Only the manifest's slides: order changes; files are never renamed.
const order = ["slides/01_cover.slide.md", "slides/03_point.slide.md", added.slideId];
const { hashes } = await reorderSlides("./decks/my-guide", order, added.hashes["presentation.yml"]);

// Removes the manifest entry, then the file. A deck's last slide can't be removed (LastSlideError).
await removeSlide("./decks/my-guide", added.slideId, hashes["presentation.yml"]);
```

In a single-file deck, slides are `---` chunks: inserting adds a chunk, reordering moves chunks and keeps each one's bytes, and slide IDs (`#0`, `#1`, …) follow the new positions.

### Add and remove deck images

```js
import { writeDeckAsset, listDeckAssets, assetReferences, removeDeckAsset, loadPresentation } from "@flipbook-md/core";

// PNG, JPEG, GIF, WebP or SVG, up to 8 MB, and the bytes must match the extension (AssetError otherwise).
// Saved in the deck's assets/ (next to the file for a single-file deck) under a kebab-case name;
// a taken name gets -2, -3, … — an existing file is never overwritten.
const { path } = await writeDeckAsset("./decks/my-guide", "Cover Photo.png", bytes); // "assets/cover-photo.png"

const images = await listDeckAssets("./decks/my-guide"); // [{ path, bytes, mime, width, height }]

// Which slides (and the deck's own presentation.css) use which image.
const { presentation } = await loadPresentation("./decks/my-guide", { blueprint: "evaluate" });
const uses = await assetReferences(presentation); // [{ source, index, path }]

await removeDeckAsset("./decks/my-guide", path);
```

AssetError codes: `ASSET_TYPE`, `ASSET_TOO_LARGE`, `ASSET_CONTENT_MISMATCH`, `ASSET_NOT_FOUND`.

### Import a document

```js
import { sourceToSlides, importDeck } from "@flipbook-md/core";

// Pure and deterministic: a slide starts at each # or ## heading and each --- line. The first #
// (else the frontmatter title, else options.title) is the cover; a short intro (≤ 300 characters)
// sits on it. A section over 8 list items or 700 visible characters splits into "Title (2)", …
// Code fences are never split; #### and deeper become bold lines; raw HTML is removed.
const { title, slides, sections, chars, dropped } = sourceToSlides(markdown, { title: "notes" });

// Writes a folder deck (never a single file): images first, under the writeDeckAsset rules,
// then slides/NN-<slug>.slide.md and presentation.yml. Nothing is left behind on failure.
// `fileName` is the href the Markdown uses; images that fail the asset check are dropped and listed.
const result = await importDeck("./decks", {
  name: "notes",
  title: "Meeting notes",
  group: null, // or a kit name: the deck joins it, and its blueprint reports violations
  markdown,
  images: [{ fileName: "image1.png", bytes }]
});
// { path, slides, assets: ["assets/image1.png"], dropped: [{ kind, reason, count, detail? }] }
```

Only the package entry is public. Deep imports such as `@flipbook-md/core/src/…` are blocked. Type declarations ship in `index.d.ts`.

The deck file format (slides, `presentation.yml`, `templates.yml`, `blueprint.yml`, groups and themes) is documented in the [Flipbook MD README](https://github.com/uminocelo/flipbook-md#write-a-presentation).

## Develop

```sh
npm install
npm test            # node:test suite
npm run typecheck   # checks index.d.ts against types-check/check.ts
```

Tests read the library in `~/Documents/flipbook/` first. Set `FLIPBOOK_HOME` to an empty folder to test against the built-in library only.

## Release

Bump `version` in `package.json` and merge to `main`. CI publishes the new version to npm with provenance and tags `v<version>`. A `-next.N` version publishes under the `next` dist-tag.
