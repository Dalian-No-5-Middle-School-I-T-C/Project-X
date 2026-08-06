/**
 * 【临时脚本 · DESIGN_PREVIEW】把 P2 过闸整页长图按固定高度切片，便于逐屏核对。
 * 用法：node scripts/slice-shots.cjs [dir] [sliceHeight]
 * ⚠ P5 清理阶段删除。
 */
const sharp = require("sharp");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.resolve(process.argv[2] || ".workbuddy/plans/p2-shots");
const SLICE = Number(process.argv[3] || 1100);

(async () => {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => /^\d\d-.*\.png$/.test(f))
    .sort();

  for (const file of files) {
    const src = path.join(DIR, file);
    const meta = await sharp(src).metadata();
    const base = file.replace(/\.png$/, "");
    const outDir = path.join(DIR, base);
    fs.mkdirSync(outDir, { recursive: true });

    const n = Math.ceil(meta.height / SLICE);
    for (let i = 0; i < n; i++) {
      const top = i * SLICE;
      const height = Math.min(SLICE, meta.height - top);
      const out = path.join(outDir, `${String(i + 1).padStart(2, "0")}.png`);
      await sharp(src)
        .extract({ left: 0, top, width: meta.width, height })
        .toFile(out);
    }
    console.log(`${file} -> ${n} 片 (${meta.width}x${meta.height})`);
  }
})();
