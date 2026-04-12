/**
 * Lib-side database generator.
 *
 * Reads all `*.classnames.ts` files from @pathscale/ui's component tree
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
}

type PurgeManifest = Record<string, ComponentManifest>;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Flatten a class value (string or string[]) into an array of individual class names. */
function flattenClasses(val: ClassValue): string[] {
  if (typeof val === "string") {
    return val.split(/\s+/).filter(Boolean);
  }
  return (val as readonly string[]).flatMap((s) => s.split(/\s+/).filter(Boolean));
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
  console.log(`Scanning ${componentsDir} for *.classnames.ts files…`);

  const manifest: PurgeManifest = {};
  const glob = new Glob("**/*.classnames.ts");

  for await (const relPath of glob.scan({ cwd: componentsDir })) {
    const fullPath = path.join(componentsDir, relPath);

    const mod = await import(fullPath);
    const CLASSES = mod.CLASSES;

    if (!CLASSES || typeof CLASSES !== "object") {
      console.warn(`  SKIP ${relPath} — no CLASSES export found`);
      continue;
    }

    const fileName = path.basename(relPath, ".classnames.ts");

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

  const json = JSON.stringify(manifest, null, 2);
  await Bun.write(outPath, json);
  console.log(`\nWrote ${outPath} (${Object.keys(manifest).length} entries, ${json.length} bytes)`);
}

main();
