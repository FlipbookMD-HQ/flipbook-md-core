// Type declarations for @flipbook-md/core. The runtime is plain ESM JavaScript (D1);
// these types describe the public entry in index.js.

export type Align = "start" | "center" | "end";
export type Canvas = "midnight" | "light" | "paper" | "forest";
export type TemplateRole = "cover" | "toc" | "topics" | "media" | "quote" | "callout" | "timeline" | "content";
export type TemplateLayout = "poster" | "list" | "topics" | "media" | "quote" | "callout" | "timeline" | "content";
export type TemplateDensity = "short" | "medium";
export type BlockKind = "heading" | "paragraph" | "list" | "image" | "code" | "quote" | "table" | (string & {});

export interface TemplateArea {
  column: string;
  row: string;
}

export interface BuiltInTemplate {
  name: string;
  area: TemplateArea | null;
}

export interface Placement {
  name: string;
  column: number;
  row: number;
  width: number;
  height: number;
  align: Align;
  role: TemplateRole | null;
  layout: TemplateLayout | null;
  density: TemplateDensity | null;
  area: TemplateArea;
}

export type TemplateMap = Record<string, Placement>;

export interface CounterChrome {
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  line: "solid" | "dashed" | "dotted";
  lineAlign: "top" | "middle" | "bottom";
  lineLength: string;
  ornament: unknown;
  [key: string]: unknown;
}

export interface BandChrome {
  kind: "line" | "shapes";
  [key: string]: unknown;
}

export interface Chrome {
  counter: CounterChrome;
  header: BandChrome | null;
  footer: BandChrome | null;
}

export interface BlueprintRules {
  template?: string | null;
  max_chars?: number;
  max_items?: number;
  require?: BlockKind[];
  allow?: BlockKind[];
  forbid?: BlockKind[];
}

export interface BlueprintPage extends BlueprintRules {
  type: string | null;
  any: string[] | null;
  repeat: { min: number; max: number };
}

export interface Blueprint {
  pages: BlueprintPage[];
  types: Record<string, BlueprintRules>;
}

export interface Group {
  name: string;
  description: string;
  themes: string[];
  style: string;
  canvas: Canvas;
  chrome: Chrome | null;
  chromeSource: unknown;
  templates: TemplateMap;
  blueprint: unknown;
}

export interface Slide {
  index: number;
  source: string;
  title: string;
  template: string;
  templateExplicit: boolean;
  type: string | null;
  markdown: string;
  notes: string;
  notesHtml: string;
  html: string;
  layout?: TemplateLayout | null;
  role?: TemplateRole | null;
  density?: TemplateDensity | null;
  showCounter?: boolean;
}

export interface Transition {
  type: "none" | "fade" | "slide";
  duration: number;
}

export interface Playback {
  interval?: number;
  transition: Transition;
}

export interface Presentation {
  title: string;
  theme: string;
  themeCss: string;
  root: string;
  sourcePath?: string;
  templates: TemplateMap;
  slides: Slide[];
  group?: string;
  style?: string;
  chrome?: Chrome;
  groupBlueprint?: unknown;
  blueprint?: Blueprint | null;
  playback?: Playback;
}

export interface Preset {
  width: number;
  height: number;
  label: string;
  use: string;
  scale?: number;
}

export type PresetName = "instagram" | "x" | "linkedin" | "linkedin-square" | "linkedin-landscape" | "youtube" | "tiktok";

export interface ExportResult {
  format: "carousel" | "video";
  count: number;
  preset: string;
  width: number;
  height: number;
  outputDir: string;
  outputFile?: string;
  slides?: number;
  duration?: number;
  fps?: number;
  transition?: string;
  transitionDuration?: number;
  clipped?: number[];
}

export interface Configuration {
  export: {
    format?: unknown;
    duration?: unknown;
    preset?: unknown;
    fps?: unknown;
    output?: unknown;
    transition?: unknown;
    transitionDuration?: unknown;
  };
  presentation: {
    interval?: unknown;
    transition?: unknown;
    transitionDuration?: unknown;
  };
}

export interface ExportOptions {
  format: "carousel" | "video";
  preset: string;
  outputDir: string;
  duration: number | null;
  fps: number;
  transition: Transition["type"];
  transitionDuration: number;
}

export interface Measured {
  chars: number;
  items: number;
  kinds: BlockKind[];
}

export interface ServerInstance {
  server: import("node:http").Server;
  host: string;
  port: number;
  url: string;
}

// attachments
export function localAssetUrl(root: string, fromDir: string, raw: string): Promise<string | null>;
export function rewriteAttachmentHtml(html: string, root: string, fromDir: string): Promise<string>;
export function inlinePresentationFiles(html: string, root: string): Promise<string>;

// blueprint
export class BlueprintError extends Error {
  constructor(violations: string[]);
  violations: string[];
}
export function pageTypeFromFilename(filePath: string): string | null;
export function readPageType(markdown: string, slideNumber: number): { type: string | null; body: string };
export function measureMarkdown(markdown: string): Measured;
export function loadBlueprint(root: string, extraTemplates?: TemplateMap): Promise<Blueprint | null>;
export function normalizeBlueprint(parsed: unknown, extraTemplates?: TemplateMap): Blueprint;
export function evaluateBlueprint(deck: Presentation, blueprint: Blueprint): string[];
export function applyBlueprint<T extends Presentation>(deck: T): Promise<T>;

// chrome
export function parseChrome(value: unknown): Chrome | null;
export function mergeChrome(base: unknown, override: unknown): unknown;
export function showsPageCounter(slide: Slide): boolean;
export function counterNumbers(slides: Slide[]): Array<string | null>;
export function bandHtml(band: BandChrome | null | undefined, edge: "header" | "footer"): string;
export function counterHtml(counter: CounterChrome, number: string, ornament: string): string;
export function shapeSvg(name: string): string;
export function layoutCss(hostSelector: string): string;
export function chromeCss(): string;
export function exportChromeCss(preset: Preset, chrome: Chrome | null | undefined): string;
export function surfaceCss(presentation: Presentation, hostSelector: string, preset?: Preset): string;
export function playerOrnament(ornament: unknown): string;
export function exportOrnament(ornament: unknown, root: string): Promise<string>;

// configuration
export function parseTransition(type: unknown, duration: unknown, where: string): Transition;
export function loadConfiguration(root: string): Promise<Configuration>;
export function playbackFromConfiguration(config: Configuration): Playback;
export function resolveExportOptions(config: Configuration, cli?: Partial<{
  format: string;
  preset: string;
  outputDir: string;
  duration: number | string;
  fps: number | string;
  transition: string;
  transitionDuration: number | string;
}>): ExportOptions;

// export
export const PRESETS: Record<PresetName, Preset>;
export function renderExportDocument(presentation: Presentation, slide: Slide, index: number, preset: Preset): Promise<string>;
export function exportCarousel(presentation: Presentation, options?: { preset?: string; outputDir?: string }): Promise<ExportResult>;
export function exportVideo(presentation: Presentation, options?: {
  preset?: string;
  outputDir?: string;
  duration?: number;
  fps?: number;
  transition?: string;
  transitionDuration?: number;
}): Promise<ExportResult>;

// groups
export function loadGroup(name: string): Promise<Group>;
export function normalizeGroup(parsed: unknown, key: string): Group;

// presentation
export function extractNotes(markdown: string, frontmatterNotes?: unknown): { body: string; notes: string };
export function loadSingleFile(filePath: string): Promise<Presentation>;
export function loadDirectoryProject(projectPath: string): Promise<Presentation>;
export function discoverPresentation(inputPath?: string): Promise<Presentation>;

// server
export function startServer(presentation: Presentation, options?: { host?: string; port?: number }): Promise<ServerInstance>;

// templates
export const DEFAULT_TEMPLATE: "flow";
export const TEMPLATES: Record<"flow" | "cover" | "summary", BuiltInTemplate>;
export function lookupTemplate(name: string, extra?: TemplateMap): BuiltInTemplate | Placement | null;
export function resolveSlideTemplate(frontmatterValue: unknown, markdown: string, slideNumber: number, extra?: TemplateMap): { template: string; explicit: boolean; body: string };
export function flipbookHome(): string;
export function libraryRoot(): string;
export function templateLibraryDirs(): string[];
export function themeLibraryDirs(): string[];
export function parsePlacement(name: string, value: unknown): Placement;
export function parseTemplatesDocument(parsed: unknown): TemplateMap;
export function loadDeckTemplates(root: string): Promise<TemplateMap>;
export function deckTemplateCss(hostSelector: string, templates?: TemplateMap): string;
export function addSavedTemplate(
  fields: { name: string; column: number; row: number; width: number; height: number; align: Align },
  deckDir?: string
): Promise<{ libraryFile: string; deckFile: string | null; placement: Placement }>;
export function templateAreaCss(hostSelector: string): string;

// theme
export function assetMime(filePath: string): string | null;
export function presentationFileUrl(root: string, absolutePath: string): string | null;
export function scopeThemeCss(css: string): string;
export function themeAssetPath(value: string): string | null;
export function rewriteThemeUrls(css: string): string;
export function resolveThemeAsset(root: string, relative: string): Promise<string | null>;
export function inlineThemeAssets(css: string, root: string): Promise<string>;
export function cssForStyleTag(css: string): string;
export function loadNamedTheme(name: string): Promise<string>;
export function loadThemeCss(directory: string): Promise<string>;
