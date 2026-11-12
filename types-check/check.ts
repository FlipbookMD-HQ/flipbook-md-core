// Compile-only fixture: `tsc --noEmit -p types-check/` checks index.d.ts against real call sites.
import {
  PRESETS,
  TEMPLATES,
  DEFAULT_TEMPLATE,
  BlueprintError,
  discoverPresentation,
  loadGroup,
  startServer,
  checkExportDependencies,
  readKit,
  evaluateDraftBlueprint,
  copyGroup,
  findDecksUsingGroup,
  writeKit,
  renderSampleDocument,
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
  readSlide,
  updateSlide,
  insertSlide,
  loadPresentation,
  type Violation,
  type ViolationCode,
  removeSlide,
  reorderSlides,
  LastSlideError,
  renderSlideDocument,
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
  const controller = new AbortController();
  const maybe = await exportCarousel(deck, { signal: controller.signal, onProgress: ({ done, total }) => void [done, total] });
  if ("cancelled" in maybe) void maybe.files;
  const deps = await checkExportDependencies("video");
  const install: string | null = deps.installCommand;
  void install;
  const live = await startServer(async () => deck, { startSlide: 2 });
  await live.close();
  const kit = await readKit({ kind: "theme", name: "dusk", scope: "library" });
  const written: { hash: string } = await writeKit({ kind: "blueprint", name: "x", scope: "deck", deckDir: "." }, { source: kit.source }, kit.hash);
  void written;
  const patched = await writeKit({ kind: "template", name: "quote", scope: "deck", deckDir: "." }, { patch: { align: "start" } }, null);
  void patched.hash;
  const copied = await copyGroup({ name: "marvel_content_guide", scope: "builtin" }, "my_kit");
  void copied.source;
  void (await findDecksUsingGroup("my_kit", ["deck"])).length;
  void (await renderSampleDocument({ group: { name: "my_kit" } })).length;
  const draft = evaluateDraftBlueprint(deck, "pages: []");
  if (draft.errors) void draft.errors[0];
  else void draft.violations.length;
  const sample: string = await renderSampleDocument({ themeCss: kit.source, canvas: "paper" });
  void sample;
  const saved = await addSavedTemplate({ name: "quote", column: 1, row: 2, width: 2, height: 1, align: "start" });
  const error = new BlueprintError(["x"]);
  const created: { path: string } = await createDeck("decks", { name: "talk", title: "Talk", kind: "folder", group: null });
  const read = await readFileWithHash(created.path);
  await atomicWrite(created.path, read.text, { baseHash: read.hash, roots: ["decks"] });
  const slide = await readSlide("decks/talk", "slides/01_cover.slide.md");
  const updated = await updateSlide("decks/talk", "slides/01_cover.slide.md", { ...slide.draft, template: "summary" }, slide.hash);
  const preview: string = await renderSlideDocument(deck, 0, { draft: slide.draft, assetBase: "/files/" });
  void [updated.slideId, preview, slide.locations.template];
  const loaded = await loadPresentation("decks/talk", { draft: { slideId: "#0", draft: slide.draft } });
  const codes: ViolationCode[] = loaded.violations.map((item: Violation) => item.code);
  void [codes, loaded.presentation.slides.length];
  const added = await insertSlide("decks/talk", null, slide.draft, slide.hash);
  const order: { hashes: Record<string, string> } = await reorderSlides("decks/talk", [added.slideId], slide.hash);
  await removeSlide("decks/talk", added.slideId, order.hashes["presentation.yml"]!);
  const last = new LastSlideError("x");
  const lastCode: "LAST_SLIDE" = last.code;
  void lastCode;
  // @ts-expect-error: updateSlide needs the baseHash.
  await updateSlide("decks/talk", "#0", slide.draft);
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
