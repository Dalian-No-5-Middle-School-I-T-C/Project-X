import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

await build({
  entryPoints: ["src/apps/answer-card/server/index.ts"],
  outfile: "dist/server/index.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  logLevel: "info"
});

await mkdir("dist/server", { recursive: true });
await copyFile("src/server/db/schema.sql", "dist/server/schema.sql");
