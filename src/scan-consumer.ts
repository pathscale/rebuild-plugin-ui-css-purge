/**
 * Consumer-side JSX scanner.
 *
 * Walks a consumer's source tree, finds component imports from @pathscale/ui,
 * collects prop values, and cross-references with the purge manifest to build
 * Level 1 (class) and Level 2 (attribute) safelists.
 *
 * Usage:  bun run src/scan-consumer.ts <consumer-src-dir> <purge-manifest.json>
 */

import swc from "@swc/core";
import { Glob } from "bun";
import path from "path";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComponentManifest {
  classes: {
    always: string[];
    byProp: Record<string, string[] | Record<string, string[]>>;
  };
  attrs?: Record<string, Record<string, string>>;
}

type PurgeManifest = Record<string, ComponentManifest>;

/** What we collect per component usage from JSX */
interface PropUsage {
  component: string;
  props: Map<string, string | "DYNAMIC">; // propName → literal value or DYNAMIC
  booleanProps: Set<string>; // props present without a value (truthy)
  hasSpread: boolean;
}

// ── AST walker ─────────────────────────────────────────────────────────────────

function walkAST(node: any, visitor: (node: any) => void) {
  if (!node || typeof node !== "object") return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === "span") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const item of val) walkAST(item, visitor);
    } else if (val && typeof val === "object") {
      walkAST(val, visitor);
    }
  }
}

/** Extract @pathscale/ui imports from a parsed module */
function extractUIImports(ast: any): Map<string, string> {
  const imports = new Map<string, string>();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    const src = node.source?.value as string;
    if (!src || !src.startsWith("@pathscale/ui")) continue;

    for (const spec of node.specifiers) {
      if (spec.type === "ImportSpecifier") {
        const imported = spec.imported?.value ?? spec.local?.value;
        const local = spec.local?.value;
        if (local && imported) imports.set(local, imported);
      } else if (spec.type === "ImportDefaultSpecifier") {
        const local = spec.local?.value;
        if (local) imports.set(local, local);
      }
    }
  }
  return imports;
}

/** Extract JSX usages of UI components */
function extractJSXUsages(ast: any, uiComponents: Map<string, string>): PropUsage[] {
  const usages: PropUsage[] = [];

  walkAST(ast, (node) => {
    if (node.type !== "JSXOpeningElement") return;

    let elementName: string | null = null;
    let rootName: string | null = null;

    if (node.name?.type === "Identifier") {
      elementName = node.name.value;
      rootName = elementName;
    } else if (node.name?.type === "JSXMemberExpression") {
      const parts: string[] = [];
      let cursor = node.name;
      while (cursor?.type === "JSXMemberExpression") {
        parts.unshift(cursor.property?.value);
        cursor = cursor.object;
      }
      if (cursor?.type === "Identifier") {
        parts.unshift(cursor.value);
        rootName = cursor.value;
      }
      elementName = parts.join(".");
    }

    if (!rootName || !uiComponents.has(rootName)) return;

    const usage: PropUsage = {
      component: elementName!,
      props: new Map(),
      booleanProps: new Set(),
      hasSpread: false,
    };

    for (const attr of node.attributes || []) {
      if (attr.type === "SpreadElement" || attr.type === "JSXSpreadAttribute") {
        usage.hasSpread = true;
        continue;
      }
      if (attr.type !== "JSXAttribute") continue;

      const propName = attr.name?.value;
      if (!propName) continue;

      if (!attr.value) {
        usage.booleanProps.add(propName);
      } else if (attr.value.type === "StringLiteral") {
        usage.props.set(propName, attr.value.value);
      } else {
        usage.props.set(propName, "DYNAMIC");
      }
    }

    usages.push(usage);
  });

  return usages;
}

// ── Safelist builder ───────────────────────────────────────────────────────────

interface Safelists {
  classSafelist: Set<string>;
  attrSafelist: Set<string>;
}

function buildSafelists(
  allUsages: PropUsage[],
  manifest: PurgeManifest,
): Safelists {
  const classSafelist = new Set<string>();
  const attrSafelist = new Set<string>();

  const componentUsages = new Map<string, PropUsage[]>();
  for (const usage of allUsages) {
    const existing = componentUsages.get(usage.component) ?? [];
    existing.push(usage);
    componentUsages.set(usage.component, existing);
  }

  for (const [entryName, entry] of Object.entries(manifest)) {
    const matchingUsages = findMatchingUsages(entryName, componentUsages);

    if (matchingUsages.length === 0) {
      continue;
    }

    for (const cls of entry.classes.always) {
      classSafelist.add(cls);
    }

    for (const [propOrSlot, value] of Object.entries(entry.classes.byProp)) {
      if (Array.isArray(value)) {
        if (isPropUsed(propOrSlot, matchingUsages)) {
          for (const cls of value) classSafelist.add(cls);
        }
      } else {
        const usedValues = getUsedEnumValues(propOrSlot, matchingUsages);
        if (usedValues === "ALL") {
          for (const classes of Object.values(value)) {
            for (const cls of classes) classSafelist.add(cls);
          }
        } else {
          for (const val of usedValues) {
            if (value[val]) {
              for (const cls of value[val]) classSafelist.add(cls);
            }
          }
        }
      }
    }

    if (entry.attrs) {
      for (const [propName, attrMap] of Object.entries(entry.attrs)) {
        if (isPropUsed(propName, matchingUsages)) {
          for (const [attr, val] of Object.entries(attrMap)) {
            attrSafelist.add(`${attr}=${val}`);
          }
        }
      }
    }
  }

  return { classSafelist, attrSafelist };
}

function findMatchingUsages(
  entryName: string,
  usageMap: Map<string, PropUsage[]>,
): PropUsage[] {
  if (usageMap.has(entryName)) {
    return usageMap.get(entryName)!;
  }

  const results: PropUsage[] = [];
  for (const [usageName, usages] of usageMap) {
    if (usageName === entryName) {
      results.push(...usages);
    }
    if (entryName.includes(".")) {
      const [family, part] = entryName.split(".");
      if (part === family && usageName === family) {
        results.push(...usages);
      }
    }
  }
  return results;
}

function isPropUsed(propName: string, usages: PropUsage[]): boolean {
  for (const usage of usages) {
    if (usage.hasSpread) return true;
    if (usage.booleanProps.has(propName)) return true;
    if (usage.props.has(propName)) return true;
  }
  return false;
}

function getUsedEnumValues(slotName: string, usages: PropUsage[]): Set<string> | "ALL" {
  const values = new Set<string>();
  for (const usage of usages) {
    if (usage.hasSpread) return "ALL";
    const val = usage.props.get(slotName);
    if (val === "DYNAMIC") return "ALL";
    if (val !== undefined) values.add(val);
    if (usage.booleanProps.has(slotName)) return "ALL";
  }
  return values;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const [srcDir, manifestPath] = process.argv.slice(2);
  if (!srcDir || !manifestPath) {
    console.error("Usage: bun run src/scan-consumer.ts <consumer-src-dir> <purge-manifest.json>");
    process.exit(1);
  }

  const manifest: PurgeManifest = JSON.parse(
    await Bun.file(manifestPath).text(),
  );
  const resolvedSrc = path.resolve(srcDir);
  console.log(`Scanning ${resolvedSrc} for @pathscale/ui component usage…`);
  console.log(`Manifest: ${Object.keys(manifest).length} entries\n`);

  const allUsages: PropUsage[] = [];
  const glob = new Glob("**/*.{tsx,ts,jsx,js}");
  let fileCount = 0;

  for await (const relPath of glob.scan({ cwd: resolvedSrc })) {
    if (relPath.includes("node_modules")) continue;

    const fullPath = path.join(resolvedSrc, relPath);
    const code = await Bun.file(fullPath).text();

    if (!code.includes("@pathscale/ui")) continue;

    const isTsx = /\.[tj]sx$/.test(relPath);
    const ast = await swc.parse(code, {
      syntax: "typescript",
      tsx: isTsx,
    });

    const uiImports = extractUIImports(ast);
    if (uiImports.size === 0) continue;

    const usages = extractJSXUsages(ast, uiImports);
    if (usages.length > 0) {
      fileCount++;
      console.log(`  ${relPath}: ${usages.length} usage(s) — [${usages.map(u => u.component).join(", ")}]`);
      allUsages.push(...usages);
    }
  }

  console.log(`\n${fileCount} files with UI component usages, ${allUsages.length} total usages\n`);

  const { classSafelist, attrSafelist } = buildSafelists(allUsages, manifest);

  console.log("=== Class Safelist ===");
  for (const cls of [...classSafelist].sort()) {
    console.log(`  ${cls}`);
  }

  console.log(`\n=== Attribute Safelist ===`);
  for (const attr of [...attrSafelist].sort()) {
    console.log(`  [${attr}]`);
  }

  console.log(`\nTotal: ${classSafelist.size} classes, ${attrSafelist.size} attribute selectors`);

  return { classSafelist, attrSafelist };
}

main();

export { extractUIImports, extractJSXUsages, buildSafelists };
export type { PropUsage, PurgeManifest, ComponentManifest, Safelists };
