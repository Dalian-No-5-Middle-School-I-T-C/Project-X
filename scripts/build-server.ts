import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { collectBuildInfo, writeBuildInfoFile } from "./lib/build-info";

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
await copyFile("src/server/db/schema.mariadb.sql", "dist/server/schema.mariadb.sql");

// 构建元信息与服务端产物同目录：部署包整目录带走，管理员页面据此判断「这台服务器是哪次构建」。
const buildInfo = collectBuildInfo(path.resolve("."));
writeBuildInfoFile(path.resolve("."), buildInfo);

console.log(
  `[build:server] schema.sql + schema.mariadb.sql copied; build-info.json written (v${buildInfo.version ?? "unknown"} @ ${buildInfo.commitShort ?? "no-git"}, built ${buildInfo.builtAt})`
);
