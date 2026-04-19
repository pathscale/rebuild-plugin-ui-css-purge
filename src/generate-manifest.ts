/**
 * Lib-side database generator.
 *
 * Reads all `*.classes.ts` files from @pathscale/ui's component tree
 * and produces a `purge-manifest.json` that the consumer-side plugin uses
 * to build safelists.
 *
 * Usage:  bun run src/generate-manifest.ts <path-to-ui-src/components>
 * Output: purge-manifest.json in cwd (or pass --out <path>)
 */

import { Glob } from "bun";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

type ClassValue = string | readonly string[];

interface ComponentManifest {
  classes: {
    always: string[];
    byProp: Record<string, string[] | Record<string, string[]>>;
  };
  attrs?: Record<string, Record<string, string>>;
  deps?: string[];
}

type PurgeManifest = Record<string, ComponentManifest>;

// ── Tailwind utility filter ───────────────────────────────────────────────────

/** Matches Tailwind utility class prefixes — these should NOT appear in the manifest. */
const twPattern = /^(-?)(flex|grid|gap|items|justify|self|place|order|col|row|auto|basis|grow|shrink|space|overflow|relative|absolute|fixed|sticky|static|block|inline|hidden|visible|invisible|z|inset|top|right|bottom|left|float|clear|isolate|object|aspect|container|columns|break|box|display|table|caption|border|rounded|outline|ring|shadow|opacity|mix|bg|from|via|to|text|font|leading|tracking|indent|align|whitespace|word|hyphens|content|list|decoration|underline|overline|line|no-underline|uppercase|lowercase|capitalize|normal|italic|not-italic|antialiased|subpixel|truncate|w|h|min|max|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|size|scroll|snap|touch|select|resize|cursor|caret|pointer|will|appearance|accent|transition|duration|delay|ease|animate|scale|rotate|translate|skew|transform|origin|filter|blur|brightness|contrast|drop|grayscale|hue|invert|saturate|sepia|backdrop|sr|forced|print|motion|lg|md|sm|xl|2xl|dark|hover|focus|active|disabled|first|last|odd|even|group|peer)($|[-:\[.])/;

function isTailwindUtility(cls: string): boolean {
  return twPattern.test(cls);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Flatten a class value (string, string[], or nested object) into an array of individual class names, filtering out Tailwind utilities. */
function flattenClasses(val: ClassValue): string[] {
  let classes: string[];
  if (typeof val === "string") {
    classes = val.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(val)) {
    classes = val.flatMap((s) => typeof s === "string" ? s.split(/\s+/).filter(Boolean) : flattenClasses(s));
  } else if (val !== null && typeof val === "object") {
    classes = Object.values(val).flatMap((v) => flattenClasses(v as ClassValue));
  } else {
    return [];
  }
  return classes.filter((cls) => !isTailwindUtility(cls));
}

/** Check if a value is a plain object (not array, not null). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Walk a single CLASSES object (one component or one part of a compound component)
 * and produce the manifest entry.
 */
function walkClassesObject(obj: Record<string, unknown>): ComponentManifest {
  const always: string[] = [];
  const byProp: Record<string, string[] | Record<string, string[]>> = {};
  let attrs: Record<string, Record<string, string>> | undefined;

  for (const [slot, value] of Object.entries(obj)) {
    if (slot === "base") {
      always.push(...flattenClasses(value as ClassValue));
    } else if (slot === "attrs") {
      if (isRecord(value)) {
        attrs = {};
        for (const [propName, attrMap] of Object.entries(value)) {
          if (isRecord(attrMap)) {
            attrs[propName] = attrMap as Record<string, string>;
          }
        }
      }
    } else if (slot === "flag") {
      if (isRecord(value)) {
        for (const [propName, classVal] of Object.entries(value)) {
          byProp[propName] = flattenClasses(classVal as ClassValue);
        }
      }
    } else if (isRecord(value)) {
      const enumMap: Record<string, string[]> = {};
      for (const [enumKey, classVal] of Object.entries(value)) {
        enumMap[enumKey] = flattenClasses(classVal as ClassValue);
      }
      byProp[slot] = enumMap;
    }
  }

  const manifest: ComponentManifest = { classes: { always, byProp } };
  if (attrs && Object.keys(attrs).length > 0) {
    manifest.attrs = attrs;
  }
  return manifest;
}

/**
 * Detect whether CLASSES is compound (top-level keys are part names like Root, Item)
 * or flat (top-level keys are slots like base, variant, flag).
 */
const KNOWN_SLOTS = new Set(["base", "variant", "size", "flag", "color", "attrs"]);

function isCompound(obj: Record<string, unknown>): boolean {
  for (const key of Object.keys(obj)) {
    if (KNOWN_SLOTS.has(key)) return false;
  }
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let componentsDir = args[0];
  let outPath = "purge-manifest.json";

  const outIdx = args.indexOf("--out");
  if (outIdx !== -1 && args[outIdx + 1]) {
    outPath = args[outIdx + 1];
  }

  if (!componentsDir) {
    console.error("Usage: bun run src/generate-manifest.ts <path-to-components-dir> [--out <path>]");
    process.exit(1);
  }

  componentsDir = path.resolve(componentsDir);
  console.log(`Scanning ${componentsDir} for *.classes.ts files…`);

  const manifest: PurgeManifest = {};
  const glob = new Glob("**/*.classes.ts");

  for await (const relPath of glob.scan({ cwd: componentsDir })) {
    const fullPath = path.join(componentsDir, relPath);

    const mod = await import(fullPath);
    const CLASSES = mod.CLASSES;

    if (!CLASSES || typeof CLASSES !== "object") {
      console.warn(`  SKIP ${relPath} — no CLASSES export found`);
      continue;
    }

    const fileName = path.basename(relPath, ".classes.ts");

    if (isCompound(CLASSES as Record<string, unknown>)) {
      for (const [partName, partObj] of Object.entries(CLASSES as Record<string, unknown>)) {
        if (isRecord(partObj)) {
          const entryName = `${fileName}.${partName}`;
          manifest[entryName] = walkClassesObject(partObj as Record<string, unknown>);
          console.log(`  ✓ ${entryName}`);
        }
      }
    } else {
      manifest[fileName] = walkClassesObject(CLASSES as Record<string, unknown>);
      console.log(`  ✓ ${fileName}`);
    }
  }

  // ── Scan inter-component dependencies ──────────────────────────────────────
  const { readdirSync } = await import("fs");
  const dirs = readdirSync(componentsDir, { withFileTypes: true })
    .filter((d: any) => d.isDirectory())
    .map((d: any) => d.name);

  function kebabToPascal(s: string): string {
    return s.split("-").map((p: string) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  }

  const dirToPascal = new Map<string, string>();
  for (const dir of dirs) {
    dirToPascal.set(dir, kebabToPascal(dir));
  }

  const importRegex = /from\s+["']\.\.\/([^/"']+)/g;
  const depGlob = new Glob("**/*.{tsx,ts,js,mjs}");

  for (const dir of dirs) {
    const pascal = dirToPascal.get(dir)!;
    const componentDeps = new Set<string>();
    const scanDir = path.join(componentsDir, dir);

    for await (const relFile of depGlob.scan({ cwd: scanDir })) {
      const fullFile = path.join(scanDir, relFile);
      const code = await Bun.file(fullFile).text();

      for (const match of code.matchAll(importRegex)) {
        const depDir = match[1];
        if (depDir === "types" || depDir === "utils" || depDir === "..") continue;
        const depPascal = dirToPascal.get(depDir);
        if (depPascal && depPascal !== pascal) {
          componentDeps.add(depPascal);
        }
      }
    }

    if (componentDeps.size > 0) {
      const depsArray = [...componentDeps].sort();
      // Attach deps to the base component entry (or all compound parts)
      for (const key of Object.keys(manifest)) {
        if (key === pascal || key.startsWith(`${pascal}.`)) {
          manifest[key].deps = depsArray;
        }
      }
      console.log(`  → ${pascal} deps: ${depsArray.join(", ")}`);
    }
  }

  const json = JSON.stringify(manifest, null, 2);
  await Bun.write(outPath, json);
  console.log(`\nWrote ${outPath} (${Object.keys(manifest).length} entries, ${json.length} bytes)`);
}

if (import.meta.main) {
  main();
}
