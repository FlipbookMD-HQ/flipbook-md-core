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
