import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(process.cwd());
const globalsPath = join(projectRoot, "app", "globals.css");
const tokensPath = join(projectRoot, "styles", "tokens.css");
const sourceRoots = ["app", "components", "styles"].map((directory) => join(projectRoot, directory));
const sourceExtensions = new Set([".css", ".ts", ".tsx"]);
const runtimeRequire = createRequire(import.meta.url);

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

function matches(source: string, pattern: RegExp) {
  return Array.from(source.matchAll(pattern), (match) => match[1]);
}

function parseTokens(source: string) {
  return new Map(
    Array.from(source.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/gm), (match) => [match[1], match[2].trim()])
  );
}

function resolveToken(tokens: Map<string, string>, name: string, visited = new Set<string>()): string {
  if (visited.has(name)) throw new Error(`Circular custom property reference: ${name}`);
  const rawValue = tokens.get(name);
  if (!rawValue) throw new Error(`Unknown custom property: ${name}`);

  const alias = rawValue.match(/^var\((--[A-Za-z0-9-]+)\)$/);
  if (!alias) return rawValue;

  visited.add(name);
  return resolveToken(tokens, alias[1], visited);
}

function hexToRgb(value: string) {
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`Expected a six-digit hex color, received ${value}`);
  return {
    red: Number.parseInt(match[1].slice(0, 2), 16),
    green: Number.parseInt(match[1].slice(2, 4), 16),
    blue: Number.parseInt(match[1].slice(4, 6), 16),
  };
}

function luminance(value: string) {
  const { red, green, blue } = hexToRgb(value);
  const channels = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("UI theme contract", () => {
  it("uses Tailwind v4 CSS-first theme and plugin configuration", () => {
    const globals = readFileSync(globalsPath, "utf8");

    expect(globals).toContain('@import "tailwindcss";');
    expect(globals).toContain('@plugin "tailwind-scrollbar";');
    expect(globals).toContain("@theme inline");
    expect(globals).toContain("--color-textSecondary: var(--text-secondary);");
    expect(globals).toContain("--animate-shimmer: shimmer 2s linear infinite;");
    expect(globals).not.toMatch(/@tailwind\s+(base|components|utilities)/);
    expect(existsSync(join(projectRoot, "tailwind.config.ts"))).toBe(false);
  });

  it("compiles the required theme and plugin utilities", async () => {
    type PostCssResult = { css: string };
    type PostCssProcessor = {
      process: (source: string, options: { from: string }) => Promise<PostCssResult>;
    };
    type PostCssFactory = (plugins: unknown[]) => PostCssProcessor;
    type TailwindPluginFactory = (options: { base: string }) => unknown;

    const tailwindPostcssEntry = runtimeRequire.resolve("@tailwindcss/postcss");
    const tailwindRequire = createRequire(tailwindPostcssEntry);
    const postcss = tailwindRequire("postcss") as PostCssFactory;
    const tailwindPostcss = runtimeRequire("@tailwindcss/postcss") as TailwindPluginFactory;
    const result = await postcss([tailwindPostcss({ base: projectRoot })]).process(
      readFileSync(globalsPath, "utf8"),
      { from: globalsPath }
    );

    for (const selector of [
      ".text-textSecondary",
      ".text-textMuted",
      ".scrollbar-thin",
      ".animate-shimmer",
      ".ui-dialog-enter",
    ]) {
      expect(result.css, selector).toContain(selector);
    }
  }, 30_000);

  it("defines every referenced application custom property", () => {
    const definitions = new Set<string>();
    const references = new Set<string>();

    for (const file of sourceRoots.flatMap(collectSourceFiles)) {
      const source = readFileSync(file, "utf8");
      for (const definition of matches(source, /(?:^|[\s{"'])(--[A-Za-z0-9-]+)["']?\s*:/gm)) {
        definitions.add(definition);
      }
      for (const fontVariable of matches(source, /\bvariable\s*:\s*["'](--[A-Za-z0-9-]+)["']/g)) {
        definitions.add(fontVariable);
      }
      for (const reference of matches(source, /var\((--[A-Za-z0-9-]+)/g)) {
        references.add(reference);
      }
    }

    const missingDefinitions = Array.from(references)
      .filter((reference) => !definitions.has(reference))
      .sort();

    expect(missingDefinitions).toEqual([]);
  });

  it("binds application typography to the optimized Geist fonts", () => {
    const globals = readFileSync(globalsPath, "utf8");
    const tokens = parseTokens(readFileSync(tokensPath, "utf8"));

    expect(globals).toContain('--font-sans: var(--font-geist-sans)');
    expect(globals).toContain('--font-display: var(--font-geist-sans)');
    expect(globals).toContain('--font-mono: var(--font-geist-mono)');
    expect(globals.match(/font-family: var\(--font-geist-sans\)/g)).toHaveLength(3);
    expect(tokens.has("--font-ops")).toBe(false);
  });

  it("keeps normal muted text at WCAG AA contrast on core dark surfaces", () => {
    const tokens = parseTokens(readFileSync(tokensPath, "utf8"));
    const foregroundTokens = [
      "--text-secondary",
      "--text-muted",
      "--ui-dialog-description",
      "--ui-form-help",
      "--ui-form-input-placeholder",
    ];
    const backgroundTokens = ["--bg-app", "--bg-surface", "--ui-dialog-bg", "--ui-form-input-select-bg"];

    for (const foregroundToken of foregroundTokens) {
      for (const backgroundToken of backgroundTokens) {
        const ratio = contrastRatio(
          resolveToken(tokens, foregroundToken),
          resolveToken(tokens, backgroundToken)
        );
        expect(ratio, `${foregroundToken} on ${backgroundToken}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the keyboard focus indicator distinguishable from dark surfaces", () => {
    const tokens = parseTokens(readFileSync(tokensPath, "utf8"));
    const focusColor = resolveToken(tokens, "--ui-focus-ring");

    for (const backgroundToken of ["--bg-app", "--bg-surface", "--ui-dialog-bg"]) {
      const ratio = contrastRatio(focusColor, resolveToken(tokens, backgroundToken));
      expect(ratio, `--ui-focus-ring on ${backgroundToken}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("provides an app-wide reduced-motion safety rule", () => {
    const globals = readFileSync(globalsPath, "utf8");
    const reducedMotionBlock = globals.slice(globals.indexOf("@media (prefers-reduced-motion: reduce)"));

    expect(reducedMotionBlock).toContain("*::before");
    expect(reducedMotionBlock).toContain("animation-duration: 0.01ms !important");
    expect(reducedMotionBlock).toContain("transition-duration: 0.01ms !important");
    expect(reducedMotionBlock).toContain("scroll-behavior: auto !important");
  });
});
