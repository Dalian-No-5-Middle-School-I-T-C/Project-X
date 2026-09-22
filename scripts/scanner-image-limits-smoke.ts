import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";

const tempDir = mkdtempSync(path.join(tmpdir(), "projectx-image-limits-"));
process.env.PROJECTX_DB_PATH = path.join(tempDir, "test.db");
process.env.ANSWER_CARD_DATA_DIR = path.join(tempDir, "data");
process.env.USERPROFILE = path.join(tempDir, "home");
process.env.PROJECTX_AUTH_ENFORCE = "0";
process.env.PROJECTX_ENABLE_SCANNER = "false";
process.env.PROJECTX_ENABLE_SCANNER_CLIENT_API = "false";
for (const key of [
  "PROJECTX_MARIADB_HOST", "PROJECTX_MARIADB_PORT", "PROJECTX_MARIADB_USER",
  "PROJECTX_MARIADB_PASSWORD", "PROJECTX_MARIADB_DATABASE", "PROJECTX_MYSQL_HOST",
]) delete process.env[key];

async function main() {
  const { createApp } = await import("../src/apps/answer-card/server/index");
  const { closeDatabase } = await import("../src/server/db/index");
  let server: Server | undefined;
  try {
    const app = await createApp();
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    async function post(route: string, field: string, sizeMiB: number, count = 1) {
      const form = new FormData();
      const image = new Blob([new Uint8Array(sizeMiB * 1024 * 1024)], { type: "image/bmp" });
      for (let i = 0; i < count; i++) form.append(field, image, `page_${i}.bmp`);
      const res = await fetch(`${base}/api/cards/size-limit-test/${route}`, { method: "POST", body: form });
      const body = await res.json() as { message?: string };
      // Deliberately use a missing card: 404 proves real multipart middleware
      // accepted the payload and reached the handler, without invoking native OMR.
      return { status: res.status, message: body.message };
    }
    for (const route of ["recognition", "recognition/objective", "grading", "grading/objective"]) {
      const result = await post(route, route.startsWith("grading") ? "files" : "file", 21);
      assert.deepEqual(result, { status: 404, message: "答题卡不存在" }, `${route}: image above old 20 MiB limit`);
    }
    assert.equal((await post("recognition", "file", 49)).status, 404, "large image below 50 MiB accepted");
    assert.equal((await post("grading", "files", 3, 24)).status, 404, "24-image batch above 50 MiB total accepted");
    assert.equal((await post("recognition", "file", 51)).status, 413, "oversized individual image remains bounded");
    console.log("scanner-image-limits-smoke: 7 real HTTP cases passed");
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
