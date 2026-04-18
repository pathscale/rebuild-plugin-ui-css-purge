#!/usr/bin/env bun
/**
 * Postbuild CSS purge — standalone Bun script.
 *
 * Runs after rsbuild build, purges CSS files in dist/ using the purge manifest
 * and consumer JSX analysis. Zero Node imports.
 *
 * Three-level purge:
 *   L1 — class-level: drop rules whose class selectors aren't in the safelist (postcss)
 *   L2 — attr-level: drop rules with data/aria attribute selectors for unused props (postcss)
 *   L3 — var cleanup: iteratively remove declared-but-unreferenced CSS custom properties (postcss)
 *   Final — minification via Lightning CSS
 *
 * Usage:
 *   bunx @pathscale/rebuild-plugin-ui-css-purge \
 *     --dist dist --src src --manifest node_modules/@pathscale/ui/dist/purge-manifest.json
 */

import { Glob } from "bun";
import { transform } from "lightningcss";
import postcss from "postcss";
import type { Rule, AtRule } from "postcss";
import { scanConsumerSource, buildSafelists } from "./scan-consumer";
import type { PurgeManifest } from "./scan-consumer";

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { distDir: string; srcDir: string; manifestPath: string } {
  const args = argv.slice(2);
  let distDir = "./dist";
  let srcDir = "./src";
  let manifestPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dist" && args[i + 1]) distDir = args[++i];
    else if (args[i] === "--src" && args[i + 1]) srcDir = args[++i];
    else if (args[i] === "--manifest" && args[i + 1]) manifestPath = args[++i];
  }

  if (!manifestPath) {
    console.error(
      "Usage: bunx @pathscale/rebuild-plugin-ui-css-purge --manifest <path> [--dist <path>] [--src <path>]",
    );
    process.exit(1);
  }

  return { distDir, srcDir, manifestPath };
}

// ── Extract all UI classes from manifest (the "universe" of purgeable classes) ─

function extractAllManifestClasses(manifest: PurgeManifest): Set<string> {
  // Derive component prefixes from manifest entry names:
  //   "Badge" → "badge", "Calendar.Calendar" → "calendar",
  //   "ButtonGroup" → "button-group", "Accordion.Item" → "accordion"
  const componentPrefixes = new Set<string>();
  for (const key of Object.keys(manifest)) {
    const root = key.split(".")[0];
    const kebab = root.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
    componentPrefixes.add(kebab);
  }

  // Collect all classes from the manifest
  const allManifestClasses: string[] = [];
  for (const entry of Object.values(manifest)) {
    allManifestClasses.push(...entry.classes.always);
    for (const value of Object.values(entry.classes.byProp)) {
      if (Array.isArray(value)) {
        allManifestClasses.push(...value);
      } else {
        for (const classes of Object.values(value)) {
          allManifestClasses.push(...classes);
        }
      }
    }
  }

  // Only include classes that match a component prefix (BEM naming).
  // This excludes Tailwind utilities (flex-col, gap-1, items-center, etc.)
  // that UI components embed in their class maps.
  const ui = new Set<string>();
  for (const cls of allManifestClasses) {
    for (const prefix of componentPrefixes) {
      if (cls === prefix || cls.startsWith(`${prefix}--`) || cls.startsWith(`${prefix}__`)) {
        ui.add(cls);
        break;
      }
    }
  }

  return ui;
}

// ── Level 1: class-level purge + keyframes + font-face + element selectors ───

function extractClassesFromSelector(selector: string): string[] {
  const matches = selector.matchAll(/\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g);
  return [...matches].map((m) => m[1]);
}

// Elements that are always kept (fundamental reset targets).
// Everything else (sub, sup, img, select, textarea, etc.) is stripped
// unless it appears alongside a safelisted class.
const ALWAYS_KEEP_SELECTORS = new Set([
  "*", "html", "body", ":root", "::before", "::after",
  ":before", ":after", "::backdrop",
]);

function isKeepableNonClassSelector(sel: string): boolean {
  const stripped = sel.trim();

  // Exact match on fundamental selectors
  for (const el of ALWAYS_KEEP_SELECTORS) {
    if (stripped === el) return true;
    // Allow pseudo-elements/classes attached to fundamental selectors
    // e.g. *::before, html:not([data-theme])
    if (stripped.startsWith(el + ":") || stripped.startsWith(el + "[") || stripped.startsWith(el + " ")) return true;
  }

  // Keep :root with pseudo/attr (theme selectors like :root:not([data-theme]))
  if (/^:root/.test(stripped)) return true;

  // Keep attribute-only selectors like [data-theme=dark] — theme variable declarations
  if (/^\[data-theme/.test(stripped)) return true;

  // Keep [hidden] reset rules
  if (/^\[hidden/.test(stripped)) return true;

  // Drop everything else: :host, :where(select...), element selectors (sub, sup, img, etc.)
  return false;
}

function purgeClasses(css: string, classSafelist: Set<string>, uiClassUniverse: Set<string>): string {
  const root = postcss.parse(css);

  // Pass 1: purge style rules — only remove selectors whose classes are
  // ALL from the UI universe and NONE are safelisted.  Selectors that
  // contain any non-UI class (Tailwind, app) are always kept.
  root.walkRules((rule) => {
    const selectors = rule.selectors;
    const kept: string[] = [];

    for (const sel of selectors) {
      const classes = extractClassesFromSelector(sel);
      if (classes.length === 0) {
        // No class in the selector — keep only fundamental reset targets
        if (isKeepableNonClassSelector(sel)) {
          kept.push(sel);
        }
        continue;
      }

      // If any class is NOT a UI class → keep (it's app/Tailwind CSS)
      const hasNonUIClass = classes.some((c) => !uiClassUniverse.has(c));
      if (hasNonUIClass) {
        kept.push(sel);
        continue;
      }

      // All classes are UI classes — keep only if at least one is safelisted
      if (classes.some((c) => classSafelist.has(c))) {
        kept.push(sel);
      }
    }

    if (kept.length === 0) {
      rule.remove();
    } else if (kept.length < selectors.length) {
      rule.selectors = kept;
    }
  });

  // Pass 2: collect animation names referenced by surviving rules
  const usedKeyframes = new Set<string>();
  root.walkDecls(/^animation(-name)?$/, (decl) => {
    // animation-name can be comma-separated
    for (const part of decl.value.split(",")) {
      const name = part.trim().split(/\s+/)[0];
      if (name && name !== "none" && name !== "initial" && name !== "inherit") {
        usedKeyframes.add(name);
      }
    }
  });

  // Pass 3: remove unused @keyframes
  root.walkAtRules("keyframes", (atRule) => {
    if (!usedKeyframes.has(atRule.params.trim())) {
      atRule.remove();
    }
  });

  // Pass 4: collect font families referenced by surviving rules
  const usedFonts = new Set<string>();
  root.walkDecls(/^font(-family)?$/, (decl) => {
    // Extract font family names (rough but catches common patterns)
    for (const part of decl.value.split(",")) {
      const name = part.trim().replace(/^["']|["']$/g, "");
      if (name) usedFonts.add(name);
    }
  });

  // Pass 5: remove unused @font-face
  root.walkAtRules("font-face", (atRule) => {
    let family = "";
    atRule.walkDecls("font-family", (decl) => {
      family = decl.value.trim().replace(/^["']|["']$/g, "");
    });
    if (family && !usedFonts.has(family)) {
      atRule.remove();
    }
  });

  // Pass 6: clean empty at-rules
  let cleaned = true;
  while (cleaned) {
    cleaned = false;
    root.walkAtRules((atRule) => {
      if (atRule.nodes && atRule.nodes.length === 0) {
        atRule.remove();
        cleaned = true;
      }
    });
  }

  return root.toString();
}

// ── Level 2: attribute purge (postcss) ───────────────────────────────────────

function purgeAttributes(css: string, attrSafelist: Set<string>): string {
  const root = postcss.parse(css);

  root.walkRules((rule) => {
    const selectors = rule.selectors;
    const kept: string[] = [];

    for (const sel of selectors) {
      const attrMatches = sel.matchAll(/\[(data-[a-z-]+|aria-[a-z-]+)="([^"]+)"\]/g);
      let shouldKeep = true;

      for (const match of attrMatches) {
        if (match[1] === "data-slot") continue;
        const attrSelector = `[${match[1]}="${match[2]}"]`;
        if (!attrSafelist.has(attrSelector)) {
          shouldKeep = false;
          break;
        }
      }

      if (shouldKeep) kept.push(sel);
    }

    if (kept.length === 0) {
      rule.remove();
    } else if (kept.length < selectors.length) {
      rule.selectors = kept;
    }
  });

  return root.toString();
}

// ── Level 3: unused CSS variable cleanup (postcss) ───────────────────────────

function cleanUnusedVars(css: string): string {
  let changed = true;
  let result = css;

  while (changed) {
    changed = false;
    const root = postcss.parse(result);

    const declared = new Map<string, { rule: Rule | AtRule; prop: string }[]>();
    root.walkDecls(/^--/, (decl) => {
      const entries = declared.get(decl.prop) ?? [];
      entries.push({ rule: decl.parent as Rule, prop: decl.prop });
      declared.set(decl.prop, entries);
    });

    const referenced = new Set<string>();
    root.walkDecls((decl) => {
      const refs = decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g);
      for (const ref of refs) referenced.add(ref[1]);
    });

    for (const [varName, entries] of declared) {
      if (!referenced.has(varName)) {
        for (const entry of entries) {
          entry.rule.walkDecls(entry.prop, (decl) => {
            decl.remove();
            changed = true;
          });
        }
      }
    }

    root.walkRules((rule) => {
      if (rule.nodes && rule.nodes.length === 0) rule.remove();
    });
    root.walkAtRules((atRule) => {
      if (atRule.nodes && atRule.nodes.length === 0) atRule.remove();
    });

    result = root.toString();
  }

  return result;
}

// ── Minification: Lightning CSS ──────────────────────────────────────────────

function minify(css: string): string {
  const { code } = transform({
    filename: "purged.css",
    code: Buffer.from(css),
    minify: true,
    errorRecovery: true,
  });
  return code.toString();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { distDir, srcDir, manifestPath } = parseArgs(process.argv);

  // 1. Load manifest
  const manifest: PurgeManifest = JSON.parse(
    await Bun.file(manifestPath).text(),
  );
  console.log(`[css-purge] Manifest loaded: ${Object.keys(manifest).length} entries`);

  // 2. Scan consumer source
  const usages = await scanConsumerSource(srcDir);
  console.log(`[css-purge] Scanned ${srcDir}: ${usages.length} component usages`);

  // 3. Build safelists + UI class universe
  const { classSafelist, attrSafelist } = buildSafelists(usages, manifest);
  const uiClassUniverse = extractAllManifestClasses(manifest);
  console.log(`[css-purge] UI universe: ${uiClassUniverse.size} classes, safelist: ${classSafelist.size} classes, ${attrSafelist.size} attrs`);

  // 4. Glob CSS files in dist
  const glob = new Glob("**/*.css");
  let totalBefore = 0;
  let totalAfter = 0;

  for await (const relPath of glob.scan({ cwd: distDir })) {
    const fullPath = `${distDir}/${relPath}`;
    const originalCss = await Bun.file(fullPath).text();
    const originalSize = Buffer.byteLength(originalCss, "utf-8");
    totalBefore += originalSize;

    console.log(`[css-purge] Processing ${relPath} (${(originalSize / 1024).toFixed(1)} KB)`);

    // Level 1: class-level purge (UI classes only)
    let purgedCss = purgeClasses(originalCss, classSafelist, uiClassUniverse);
    const afterL1 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L1 class purge: ${(originalSize / 1024).toFixed(1)} → ${(afterL1 / 1024).toFixed(1)} KB`);

    // Level 2: attribute-level purge
    purgedCss = purgeAttributes(purgedCss, attrSafelist);
    const afterL2 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L2 attr purge: ${(afterL1 / 1024).toFixed(1)} → ${(afterL2 / 1024).toFixed(1)} KB`);

    // Level 3: unused CSS variable cleanup
    purgedCss = cleanUnusedVars(purgedCss);
    const afterL3 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L3 var cleanup: → ${(afterL3 / 1024).toFixed(1)} KB`);

    // Final: minification via Lightning CSS
    purgedCss = minify(purgedCss);
    const finalSize = Buffer.byteLength(purgedCss, "utf-8");
    totalAfter += finalSize;
    console.log(`[css-purge]   Minify (lightningcss): → ${(finalSize / 1024).toFixed(1)} KB`);
    console.log(`[css-purge]   Final: ${(originalSize / 1024).toFixed(1)} → ${(finalSize / 1024).toFixed(1)} KB (${((1 - finalSize / originalSize) * 100).toFixed(1)}% reduction)`);

    await Bun.write(fullPath, purgedCss);
  }

  console.log(`\n[css-purge] Total: ${(totalBefore / 1024).toFixed(1)} → ${(totalAfter / 1024).toFixed(1)} KB (${((1 - totalAfter / totalBefore) * 100).toFixed(1)}% reduction)`);
}

main();
