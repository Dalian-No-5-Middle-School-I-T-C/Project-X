// Prepare new local scan records from the test run's cards. The results page reads the
// records through its usual endpoints. Only the first objective confidence is varied.
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const root = process.env.PROJECTX_FLOW_SHARED_ROOT;
const installed = process.argv[2];
const load = (filename) =>
  JSON.parse(fs.readFileSync(path.join(root, filename)));
const source = load("draft-session.json");
const cache = load("cache-exam.json");
const { B } = load("matrix-exams.json");
assert.equal(source.card, cache.card);
const Database = require(
  path.join(
    installed,
    "resources",
    "app.asar",
    "node_modules",
    "better-sqlite3",
  ),
);
const data = path.join(process.env.APPDATA, "answer-card-designer", "data");
const db = new Database(path.join(data, "projectx.db"), {
  fileMustExist: true,
});
try {
  const original = db
    .prepare(
      "SELECT * FROM twain_scan_records WHERE id=? AND session_id=? AND card_id=?",
    )
    .get(source.record, source.sessionId, cache.card);
  assert.equal(
    path.dirname(original.image_path),
    path.join(data, "answer-card", "scans", cache.card),
  );
  const snapshot = db
    .prepare(
      "SELECT * FROM scan_correction_pages WHERE source_type='twain_scan_record' AND source_id=?",
    )
    .get(original.id);
  const scores = db
    .prepare("SELECT * FROM twain_recognition_results WHERE scan_record_id=?")
    .get(original.id);
  const inserts = db.transaction(() => {
    const fixtures = [];
    for (const [kind, card, student] of [
      ["low", cache.card, process.argv[3] === "active" ? "10021" : "10009"],
      ["missing", B.card, "10001"],
      ["missing", B.card, "10002"],
    ]) {
      if (process.argv[3] === "active" && kind !== "low") continue;
      const sessionId = randomUUID(),
        record = randomUUID();
      const imageDir = path.join(data, "answer-card", "scans", card);
      const file = path.join(imageDir, record + ".png");
      fs.mkdirSync(imageDir, { recursive: true });
      const isLow = kind === "low";
      fs.copyFileSync(
        isLow
          ? original.image_path
          : path.join(root, "卡型B", "images", student + "-1.png"),
        file,
        fs.constants.COPYFILE_EXCL,
      );
      db.prepare(
        "INSERT INTO twain_scan_sessions (id,card_id,name,dpi,duplex,paper_size,color_mode,page_count,status,card_version) VALUES (?,?,?,300,?,'A4','color',1,'completed',?)",
      ).run(
        sessionId,
        card,
        "验收样本 " + student,
        isLow ? 0 : 1,
        isLow ? snapshot.card_version : null,
      );
      db.prepare(
        "INSERT INTO twain_scan_records (id,session_id,card_id,student_id,student_conf,image_path,page_num,side,ocr_status,identity_json) VALUES (?,?,?,?,1,?,1,'front','done',?)",
      ).run(
        record,
        sessionId,
        card,
        student,
        file,
        isLow ? original.identity_json : null,
      );
      if (isLow) {
        const recognition = JSON.parse(snapshot.recognition_json);
        recognition.studentId = {
          ...recognition.studentId,
          status: "ok",
          value: student,
        };
        const target = recognition.questions.find(
          (q) => q.questionNumber === 1,
        );
        assert.ok(target && target.selectedOptions.length === 1);
        target.confidence = 0.05;
        db.prepare(
          "INSERT INTO scan_correction_pages(source_type,source_id,card_version,layout_json,recognition_json) VALUES('twain_scan_record',?,?,?,?)",
        ).run(
          record,
          snapshot.card_version,
          snapshot.layout_json,
          JSON.stringify(recognition),
        );
        db.prepare(
          "INSERT INTO twain_recognition_results(id,scan_record_id,objective_json,subjective_json,total_score,max_score,grade_status) VALUES(?,?,?,?,?,?,'done')",
        ).run(
          randomUUID(),
          record,
          JSON.stringify(recognition.questions),
          JSON.stringify(recognition.subjectiveQuestions ?? []),
          scores.total_score,
          scores.max_score,
        );
      }
      fixtures.push({ kind, card, student, sessionId, record, pageCount: 1 });
    }
    return fixtures;
  });
  process.stdout.write(JSON.stringify(inserts()));
} finally {
  db.close();
}
