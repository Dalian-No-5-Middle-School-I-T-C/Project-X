import { build } from "esbuild";

await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "dist/server/index.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  logLevel: "info"
});
