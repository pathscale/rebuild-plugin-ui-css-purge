# @pathscale/rebuild-plugin-ui-css-purge

Three-level CSS purge for `@pathscale/ui` consumers. Analyzes JSX usage at build time, cross-references with a component class manifest, and strips unused CSS rules, attribute selectors, and custom properties.

Runs as a postbuild step under Bun. Zero Node dependencies.

## How it works

The purge operates in two phases across two repositories:

**Phase 1 (lib-side, `@pathscale/ui`):** Each component ships a `.classnames.ts` file declaring all CSS classes it uses, organized by slot (`base`, `variant`, `size`, `flag`, `color`, `attrs`). A prebuild script reads these files and produces `purge-manifest.json` — a compact database mapping components to their class and attribute requirements.

**Phase 2 (consumer-side, e.g. `honey.id`):** After `rsbuild build`, the postbuild script scans the consumer's JSX source with [swc](https://swc.rs/), finds all `@pathscale/ui` component usages with their prop values, and cross-references with the manifest to determine exactly which CSS classes and attribute selectors are needed. Three purge levels run in sequence:

| Level | What it does | Engine |
|-------|-------------|--------|
| L1 | Removes entire CSS rules whose class selectors aren't in the safelist | [purgecss](https://purgecss.com/) |
| L2 | Within kept rules, strips `[data-*]` / `[aria-*]` attribute selectors not in the attr safelist | [postcss](https://postcss.org/) AST walk |
| L3 | Iteratively removes CSS custom properties that are declared but never referenced | postcss AST walk |

## Results

Tested on `honey.id` with 3 components having `.classnames.ts` files (Button, Breadcrumbs, Navbar):

```
440.7 KB  raw CSS (before)
 42.3 KB  after L1 (class purge)
 42.3 KB  after L2 (attr purge)
 27.7 KB  after L3 (var cleanup)
  4.4 KB  brotli compressed
```

93.7% reduction in raw CSS size.

## Installation

```bash
bun add -d @pathscale/rebuild-plugin-ui-css-purge
```

## Usage

### Consumer project (postbuild purge)

Add to your build script in `package.json`:

```json
{
  "scripts": {
    "build": "rsbuild build && bunx rebuild-plugin-ui-css-purge --manifest node_modules/@pathscale/ui/dist/purge-manifest.json"
  }
}
```

Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--manifest` | (required) | Path to `purge-manifest.json` |
| `--dist` | `./dist` | Directory containing built CSS files |
| `--src` | `./src` | Consumer source directory to scan for JSX usage |

### Lib-side (manifest generation)

Run from `@pathscale/ui` as a prebuild step:

```json
{
  "scripts": {
    "prebuild": "bunx generate-manifest src/components --out dist/purge-manifest.json"
  }
}
```

This scans all `*.classnames.ts` files and produces the manifest that consumers use.

## The `.classnames.ts` convention

Every component in `@pathscale/ui` gets a sibling `.classnames.ts` file exporting a `CLASSES` const. The component imports it and references every class through `CLASSES.*`. This makes static analysis trivial — no JSX parsing needed to know which classes a component can produce.

```ts
// Button.classnames.ts
export const CLASSES = {
  base: "inline-flex items-center justify-center rounded-md font-medium",
  variant: {
    primary: "bg-primary text-white",
    secondary: "bg-secondary text-white",
    ghost: "bg-transparent",
  },
  size: {
    sm: "h-8 px-3 text-sm",
    md: "h-10 px-4 text-base",
    lg: "h-12 px-6 text-lg",
  },
  flag: {
    isDisabled: "opacity-50 cursor-not-allowed",
  },
} as const;
```

**Slots:**

| Slot | Shape | Purpose |
|------|-------|---------|
| `base` | `string \| string[]` | Always rendered when the component mounts |
| `variant`, `size`, `color` | `{ enumValue: classString }` | Enum prop value maps to classes |
| `flag` | `{ propName: classString }` | Boolean prop name maps to classes |
| `attrs` | `{ propName: { attr: value } }` | L2 attribute selectors tied to props |

Compound components use a nested shape: `CLASSES = { Root: { base, ... }, Item: { base, ... } }`.

## Programmatic API

The scanner and safelist builder are also exported for custom integrations:

```ts
import { scanConsumerSource, buildSafelists } from "@pathscale/rebuild-plugin-ui-css-purge";

const usages = await scanConsumerSource("/path/to/consumer/src");
const manifest = JSON.parse(await Bun.file("purge-manifest.json").text());
const { classSafelist, attrSafelist } = buildSafelists(usages, manifest);
```

## Development

```bash
bun install
bun run build    # dist/index.js + dist/postbuild-purge.js + type declarations
bun run lint
bun run format
```

## License

MIT
