#!/usr/bin/env bun
/**
 * Postbuild CSS purge — standalone Bun script.
 *
 * Runs after rsbuild build, purges CSS files in dist/ using the purge manifest
 * and consumer JSX analysis. Zero Node imports.
 *
 * Usage:
 *   bunx @pathscale/rebuild-plugin-ui-css-purge \
 *     --dist dist --src src --manifest node_modules/@pathscale/ui/dist/purge-manifest.json
 */

import { Glob } from "bun";
import { PurgeCSS } from "purgecss";
import postcss from "postcss";
import type { Rule, AtRule } from "postcss";
import path from "path";
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

  return {
    distDir: path.resolve(distDir),
    srcDir: path.resolve(srcDir),
    manifestPath: path.resolve(manifestPath),
  };
}

// ── Level 2: attribute purge ──────────────────────────────────────────────────

function purgeAttributes(css: string, attrSafelist: Set<string>): string {
  const root = postcss.parse(css);

  root.walkRules((rule) => {
    const selectors = rule.selectors;
    const kept: string[] = [];

    for (const sel of selectors) {
      const attrMatches = sel.matchAll(/\[(data-[a-z-]+|aria-[a-z-]+)="([^"]+)"\]/g);
      let shouldKeep = true;

      for (const match of attrMatches) {
        const attrSelector = `[${match[1]}="${match[2]}"]`;
        if (match[1] === "data-slot") continue;
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

// ── Level 3: unused CSS variable cleanup ──────────────────────────────────────

function cleanUnusedVars(css: string): string {
  let changed = true;
  let result = css;

  while (changed) {
    changed = false;
    const root = postcss.parse(result);

    const declared = new Map<string, { rule: Rule | AtRule; prop: string; index: number }[]>();
    root.walkDecls(/^--/, (decl) => {
      const entries = declared.get(decl.prop) ?? [];
      entries.push({ rule: decl.parent as Rule, prop: decl.prop, index: entries.length });
      declared.set(decl.prop, entries);
    });

    const referenced = new Set<string>();
    root.walkDecls((decl) => {
      const refs = decl.value.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g);
      for (const ref of refs) {
        referenced.add(ref[1]);
      }
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

  // 3. Build safelists
  const { classSafelist, attrSafelist } = buildSafelists(usages, manifest);
  console.log(`[css-purge] Safelist: ${classSafelist.size} classes, ${attrSafelist.size} attrs`);

  // 4. Glob CSS files in dist
  const glob = new Glob("**/*.css");
  let totalBefore = 0;
  let totalAfter = 0;

  for await (const relPath of glob.scan({ cwd: distDir })) {
    const fullPath = path.join(distDir, relPath);
    const originalCss = await Bun.file(fullPath).text();
    const originalSize = Buffer.byteLength(originalCss, "utf-8");
    totalBefore += originalSize;

    console.log(`[css-purge] Processing ${relPath} (${(originalSize / 1024).toFixed(1)} KB)`);

    // Level 1: class-level purge
    const purgeResult = await new PurgeCSS().purge({
      content: [],
      css: [{ raw: originalCss }],
      safelist: [...classSafelist],
      keyframes: false,
      fontFace: false,
    });

    let purgedCss = purgeResult[0]?.css ?? originalCss;
    const afterL1 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L1 class purge: ${(originalSize / 1024).toFixed(1)} → ${(afterL1 / 1024).toFixed(1)} KB`);

    // Level 2: attribute-level purge
    if (attrSafelist.size > 0) {
      purgedCss = purgeAttributes(purgedCss, attrSafelist);
      const afterL2 = Buffer.byteLength(purgedCss, "utf-8");
      console.log(`[css-purge]   L2 attr purge: ${(afterL1 / 1024).toFixed(1)} → ${(afterL2 / 1024).toFixed(1)} KB`);
    }

    // Level 3: unused CSS variable cleanup
    purgedCss = cleanUnusedVars(purgedCss);
    const afterL3 = Buffer.byteLength(purgedCss, "utf-8");
    console.log(`[css-purge]   L3 var cleanup: → ${(afterL3 / 1024).toFixed(1)} KB`);

    const finalSize = Buffer.byteLength(purgedCss, "utf-8");
    totalAfter += finalSize;
    console.log(`[css-purge]   Final: ${(originalSize / 1024).toFixed(1)} → ${(finalSize / 1024).toFixed(1)} KB (${((1 - finalSize / originalSize) * 100).toFixed(1)}% reduction)`);

    // Write back
    await Bun.write(fullPath, purgedCss);
  }

  console.log(`\n[css-purge] Total: ${(totalBefore / 1024).toFixed(1)} → ${(totalAfter / 1024).toFixed(1)} KB (${((1 - totalAfter / totalBefore) * 100).toFixed(1)}% reduction)`);
}

main();
