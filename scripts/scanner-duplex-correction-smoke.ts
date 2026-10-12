/** Upload interruption -> ID correction -> authenticated HTTP -> persisted duplex grade. */
import assert from "node:assert/strict";
import { createScannerUploadManager } from "../src/apps/answer-card/client/lib/scannerUploadManager";
import { startScannerFlowFixture } from "./scanner-upload-flow-fixture";

const fixture = await startScannerFlowFixture(0, "127.0.0.1", { duplex: true });
try {
  const info = await (await fetch(`${fixture.baseUrl}/test/fixture`)).json();
  const { getMysqlDb } = await import("../src/server/db");
  const db = getMysqlDb();
  let failBack = true;
  let failCorrection = true;
  let frontReads = 0;
  const events: string[] = [];
  const manager = createScannerUploadManager({
    isOnline: () => true, getServerKind: () => "online", sleep: async () => {},
    timeoutSignal: () => new AbortController().signal,
    localFetch: async (_url, init) => {
      const page = Number((init!.body as FormData).get("page"));
      return Response.json({ status: "ok", identity: { status: "verified", code: "QR_VERIFIED", cardId: info.cardId, pageNumber: page },
        studentId: { status: "ok", value: page === 1 ? "91001" : null }, quality: { matchCount: 4, missingRoles: [] },
        questions: page === 1 ? [{ questionNumber: 1, selectedOptions: ["A"], confidence: 1 }] : [], subjectiveQuestions: [] });
    },
    remoteFetch: async (url, init) => {
      if (url.endsWith("/pages")) {
        const form = init!.body as FormData;
        if (form.get("side") === "back" && failBack) throw new Error("Interrupted back upload");
        events.push(`upload:${form.get("side")}`);
      }
      if (url.endsWith("/correct")) {
        events.push(`correct:${JSON.parse(String(init!.body)).studentId}`);
        if (failCorrection) return Response.json({ message: "Correction rejected by remote server" }, { status: 409 });
      }
      const headers = new Headers(init?.headers); headers.set("X-Api-Key", info.key);
      return fetch(`${fixture.baseUrl}${url}`, { ...init, headers });
    },
  });
  async function terminal(id: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const job = manager.getState().jobs.find(job => job.id === id)!;
      if (job.status === "error" || job.status === "done") return job;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Duplex correction stalled");
  }
  const id = manager.startUpload({ kind: "import", cardId: info.cardId, cardVersion: info.version, name: "duplex correction",
    pages: (["front", "back"] as const).map((side, index) => ({ pageNum: 1, side, layoutPage: index + 1, groupId: "local-card",
      getBlob: async () => { if (side === "front") frontReads++; return new Blob([Buffer.from(info.images.original, "base64")], { type: "image/png" }); } })) });
  assert.equal((await terminal(id)).status, "error");
  assert.deepEqual((await db.all<{ student_id: string }>("SELECT student_id FROM twain_scan_records WHERE ocr_status='uploaded'")).map(row => row.student_id), ["91001"]);
  assert.equal((await db.all("SELECT * FROM student_scores")).length, 0);
  failBack = false;
  manager.correctStudentId(id, "91002");
  assert.equal((await terminal(id)).status, "error", "Rejected correction must not resume the back");
  assert.equal((await db.all("SELECT * FROM student_scores")).length, 0);
  assert(!events.includes("upload:back"));
  assert.equal((await manager.getFailedPageBlobs(id)).length, 1);
  failCorrection = false;
  manager.correctStudentId(id, "91003");
  const completed = await terminal(id);
  assert.equal(completed.status, "done", completed.message);
  assert.deepEqual((await db.all<{ student_id: string }>("SELECT student_id FROM twain_scan_records ORDER BY page_num,side")).map(row => row.student_id), ["91003", "91003"]);
  const scores = await db.all<{ student_number: string; total_score: number }>("SELECT u.student_number,ss.total_score FROM student_scores ss JOIN users u ON u.id=ss.student_id");
  assert.equal(scores.length, 1);
  assert.equal(scores[0].student_number, "91003");
  assert.equal(Number(scores[0].total_score), 5);
  assert.equal((await db.all("SELECT * FROM scanner_submissions WHERE state='saved'")).length, 1);
  assert.deepEqual(events, ["upload:front", "correct:91002", "correct:91003", "upload:back"]);
  assert.equal(frontReads, 1, "Released successful front must stay released");
  console.log(`PASS duplex correction: ${db.dialect}, released front / rejected correction / retry / paired records / one correct grade`);
} finally { await fixture.close(); }
