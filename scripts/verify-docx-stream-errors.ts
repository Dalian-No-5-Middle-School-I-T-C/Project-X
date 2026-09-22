import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { extractDocxFiles, PaperInputError } from "../src/apps/answer-card/server/paper-docx";

const scenario = process.argv[2];
if (!scenario) {
  // A stuck promise must fail the test even if Node exits with unresolved awaits.
  for (const name of ["first-chunk", "later-chunk", "end-size"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), name], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(child.status, 0, `${name}: ${child.error ?? child.stderr}\n${child.stdout}`);
    assert.match(child.stdout, /PASS: rejection and subsequent extraction/);
    console.log(`PASS: ${name}`);
  }
} else {
  const dir = await mkdtemp(path.join(tmpdir(), "projectx-docx-stream-"));
  try {
    const zip = new AdmZip();
    zip.addFile("[Content_Types].xml", Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
    zip.addFile("_rels/.rels", Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
    const xml = Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"a".repeat(150_000)}</w:t></w:r></w:p></w:body></w:document>`);
    zip.addFile("word/document.xml", xml);
    const good = zip.toBuffer();
    const bad = Buffer.from(good);
    let offset = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    let patched = false;
    while (offset >= 0 && bad.readUInt32LE(offset) === 0x02014b50) {
      const nameLength = bad.readUInt16LE(offset + 28);
      if (bad.subarray(offset + 46, offset + 46 + nameLength).toString() === "word/document.xml") {
        bad.writeUInt32LE(scenario === "first-chunk" ? 1 : scenario === "later-chunk" ? 32_769 : xml.length + 1, offset + 24);
        patched = true;
        break;
      }
      offset += 46 + nameLength + bad.readUInt16LE(offset + 30) + bad.readUInt16LE(offset + 32);
    }
    assert(patched);
    const invalidPath = path.join(dir, "invalid.docx");
    const validPath = path.join(dir, "valid.docx");
    await writeFile(invalidPath, bad);
    await writeFile(validPath, good);
    const deadline = setTimeout(() => {
      console.error("FAIL: extraction did not settle within 3 seconds");
      process.exit(2);
    }, 3000);
    try {
      await assert.rejects(extractDocxFiles([invalidPath]),
        (error: unknown) => error instanceof PaperInputError && error.code === "INVALID_DOCX");
      assert.equal((await extractDocxFiles([validPath]))?.length, 150_000);
      console.log("PASS: rejection and subsequent extraction");
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
