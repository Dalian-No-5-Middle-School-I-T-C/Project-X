/**
 * 将 testdata/demo-exams 数据集写入 public/demo/demo-data.json
 * 用法: npx tsx scripts/build-demo-static-data.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticDemoPayload } from "../testdata/demo-exams/demo-dataset.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "demo");
const outFile = path.join(outDir, "demo-data.json");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(buildStaticDemoPayload(), null, 2), "utf8");
console.log(`[build-demo-static] wrote ${outFile}`);
