# @flipbook-md/core

The shared library behind [Flipbook MD](https://github.com/uminocelo/flipbook-md). It loads Markdown decks, applies templates, groups, themes and blueprints, serves the slide player, and exports PNG carousels and MP4 videos.

The `flipbook` CLI and Flipbook Studio both build on this package. If you only want to present or export a deck, install the CLI instead:

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

Codes: `ORDER`, `MISSING_TYPE`, `TEMPLATE`, `MAX_CHARS`, `MAX_ITEMS`, `REQUIRED`, `NOT_ALLOWED`. A deck's own `blueprint.yml` wins over its group's.

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
