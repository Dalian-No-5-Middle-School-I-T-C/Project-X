/** Run under the installed Electron ABI to select a marked input for one synthetic TWAIN record. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const [sessionId, recordId, cardId, installed] = process.argv.slice(2);
const root = process.env.PROJECTX_FLOW_SHARED_ROOT;
const spec = JSON.parse(fs.readFileSync(path.join(root, "cache-exam.json")));
assert.equal(cardId, spec.card);
const data = path.join(process.env.APPDATA, "answer-card-designer", "data");
const Database = require(
  path.join(
    installed,
    "resources",
    "app.asar",
    "node_modules",
    "better-sqlite3",
  ),
);
const db = new Database(path.join(data, "projectx.db"), {
  fileMustExist: true,
});
try {
  const row = db
    .prepare(
      "SELECT image_path FROM twain_scan_records WHERE id=? AND card_id=? AND session_id=?",
    )
    .get(recordId, cardId, sessionId);
  assert.ok(row);
  assert.equal(
    path.dirname(row.image_path),
    path.join(data, "answer-card", "scans", cardId),
  );
  const marked = path.join(
    path.dirname(row.image_path),
    sessionId + "-draft-e2e.png",
  );
  fs.writeFileSync(
    marked,
    fs.readFileSync(path.join(root, "缓存测试", "images", "答题卡-10009.png")),
    { flag: "wx" },
  );
  const updated = db
    .prepare(
      "UPDATE twain_scan_records SET image_path=? WHERE id=? AND session_id=? AND card_id=? AND image_path=?",
    )
    .run(marked, recordId, sessionId, cardId, row.image_path);
  assert.equal(updated.changes, 1);
  // Keep the driver's unmodified original next to the new input for audit.
  console.log(
    "Selected a marked PNG for the dedicated record, original TWAIN image retained",
  );
} finally {
  db.close();
}
