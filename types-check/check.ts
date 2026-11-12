// Compile-only fixture: `tsc --noEmit -p types-check/` checks index.d.ts against real call sites.
import {
  PRESETS,
  TEMPLATES,
  DEFAULT_TEMPLATE,
  BlueprintError,
  discoverPresentation,
  loadGroup,
  startServer,
  exportCarousel,
  exportVideo,
  evaluateBlueprint,
  parsePlacement,
  parseChrome,
  measureMarkdown,
  loadConfiguration,
  resolveExportOptions,
  renderExportDocument,
  addSavedTemplate,
  createDeck,
  atomicWrite,
  readFileWithHash,
  FileConflictError,
  type Presentation,
  type Placement,
  type ExportResult
} from "@flipbook-md/core";

export async function exercise(): Promise<void> {
  const deck: Presentation = await discoverPresentation("examples/blueprint-talk");
  const titles: string[] = deck.slides.map((slide) => slide.title);
  const width: number = PRESETS.instagram.width;
  const flow: "flow" = DEFAULT_TEMPLATE;
  const cover = TEMPLATES.cover.area;
  const group = await loadGroup("marvel_content_guide");
  const style: string = group.style;
  const placement: Placement = parsePlacement("quote", { column: 1, row: 2, width: 2, height: 1, align: "start" });
  const violations: string[] = deck.blueprint ? evaluateBlueprint(deck, deck.blueprint) : [];
  const chrome = parseChrome(null);
  const measured = measureMarkdown("# Hi");
  const config = await loadConfiguration(deck.root);
  const options = resolveExportOptions(config, { preset: "x" });
  const html: string = await renderExportDocument(deck, deck.slides[0], 0, PRESETS.x);
  const server = await startServer(deck, { port: 0 });
  server.server.close();
  const result: ExportResult = await exportCarousel(deck, { preset: options.preset, outputDir: options.outputDir });
  const video = await exportVideo(deck, { duration: 5 });
  const saved = await addSavedTemplate({ name: "quote", column: 1, row: 2, width: 2, height: 1, align: "start" });
  const error = new BlueprintError(["x"]);
  const created: { path: string } = await createDeck("decks", { name: "talk", title: "Talk", kind: "folder", group: null });
  const read = await readFileWithHash(created.path);
  await atomicWrite(created.path, read.text, { baseHash: read.hash, roots: ["decks"] });
  const conflict = new FileConflictError("x", null);
  void conflict.currentHash;
  // @ts-expect-error: atomicWrite needs a baseHash.
  await atomicWrite("x", "y", { roots: ["decks"] });
  void [titles, width, flow, cover, style, placement, violations, chrome, measured.chars, html, result.count, video.duration, saved.libraryFile, error.violations];

  // @ts-expect-error: discoverPresentation takes a path string, not a number.
  await discoverPresentation(42);
  // @ts-expect-error: unknown preset names are not keys of PRESETS.
  void PRESETS.myspace;
}
