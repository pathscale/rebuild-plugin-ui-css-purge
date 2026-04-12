await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  external: ["@rsbuild/core", "postcss", "purgecss", "@swc/core", "fast-glob"],
  sourcemap: "inline",
});

// Generate type declarations
const proc = Bun.spawn(["bunx", "tsc", "--emitDeclarationOnly"], {
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await proc.exited;
if (exitCode !== 0) {
  console.error("tsc declaration generation failed");
  process.exit(exitCode);
}

console.log("Build complete: dist/index.js + type declarations");
