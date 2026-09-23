import QRCode from "qrcode";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createCardQrCode, qrDarkRects } from "../src/shared/cardIdentity";
import { createDefaultCard } from "../src/shared/defaultCard";
import { buildLayout } from "../src/shared/layout";
import { recognizeAnswerCard, validateIdentity } from "../src/apps/answer-card/server/recognition";
import type { CombinedRecognitionResult, Rect } from "../src/shared/types";

const box = (r: Rect, fill = "#000") => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${fill}"/>`;
const dir = await mkdtemp(path.join(os.tmpdir(), "projectx-qr-"));
try {
  for (const size of ["A4", "A3"] as const) {
    const card = createDefaultCard("90000002", "二维码回归测试长标题");
    card.paper.size = size;
    card.studentInfo.showStudentNumber = false;
    card.bodyBlocks = [{ id: "qr_objective", type: "objective", title: "选择题", questionStart: 1, questionCount: 1,
      optionCount: 4, mode: "single", scorePerQuestion: 1, density: "compact", questions: [{ questionNumber: 1, optionCount: 4, mode: "single", score: 1 }] }];
    const layout = buildLayout(card), page = layout.pages[0];
    const layoutPath = path.join(dir, `${size}.json`);
    await writeFile(layoutPath, JSON.stringify(layout));
    const marks = page.markers.map(m => box(m.rect)).join("");
    const options = page.blocks.flatMap(b => b.type === "objective" ? b.items : []).flatMap(q => q.options)
      .map(o => box(o.rect, o.label === "A" ? "#000" : "#fff")).join("");
    const qr = (id = card.id, number = 1, rect = page.header.qrCode.rect) => qrDarkRects(createCardQrCode(id, number, rect)).map(r => box(r)).join("");
    const render = async (name: string, code: string, angle = 0, blur = false) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${page.width} ${page.height}"><rect width="100%" height="100%" fill="#fff"/>${marks}${options}${code}</svg>`;
      let image = sharp(Buffer.from(svg)).resize(Math.round(page.width / 25.4 * 200), Math.round(page.height / 25.4 * 200));
      const raw = await image.png().toBuffer();
      image = sharp(raw).rotate(angle, { background: "white" });
      if (blur) image = image.blur(0.5);
      const imagePath = path.join(dir, `${size}-${name}.png`);
      await image.png().toFile(imagePath);
      return { imagePath, layoutPath, pageNumber: 1, dpi: 200 };
    };
    let cropGeometry: unknown;
    for (const angle of [0, 90, 180, 270, 2]) {
      const request = await render(String(angle), qr(), angle, angle === 2);
      const result = await recognizeAnswerCard({ ...request, cropsDir: path.join(dir, `crops-${size}-${angle}`) }) as CombinedRecognitionResult;
      assert.equal(result.identity?.status, "verified");
      assert.deepEqual(result.questions[0]?.selectedOptions, ["A"], `${size} ${angle}: ${JSON.stringify(result)}`);
      assert.ok(result.blockCrops?.length, "Expected objective crop");
      const geometry = result.blockCrops!.map(c => ({ rect: c.rect, width: c.widthPx, height: c.heightPx, page: c.pageNumber }));
      if (cropGeometry) assert.deepEqual(geometry, cropGeometry, "Rotation preserves crop geometry");
      else cropGeometry = geometry;
      if (angle !== 2) assert.equal(result.quality?.rotationDegrees, (360 - angle) % 360);
      console.log(`PASS ${size} rotation ${angle}`);
    }
    const invalidMatrix = QRCode.create("PXAC:2:90000002:1", { errorCorrectionLevel: "M" }).modules;
    const invalidCode = qrDarkRects({ ...page.header.qrCode, size: invalidMatrix.size, modules: Array.from(invalidMatrix.data) }).map(r => box(r)).join("");
    const invalidRequest = await render("protocol", invalidCode);
    await assert.rejects(recognizeAnswerCard(invalidRequest), /协议或内容无效/);
    await assert.rejects(recognizeAnswerCard({ ...invalidRequest, identityMode: "legacy" }), /协议或内容无效/);
    const damaged = await render("damaged", qr() + box({ x: page.header.qrCode.rect.x + 5, y: page.header.qrCode.rect.y + 5, width: 8, height: 8 }, "#fff"));
    await assert.rejects(recognizeAnswerCard(damaged), /未找到二维码|无法读取/);
    assert.equal((await recognizeAnswerCard({ ...damaged, identityMode: "legacy" }) as CombinedRecognitionResult).identity?.status, "unverified");
    const missing = await render("missing", "");
    await assert.rejects(recognizeAnswerCard(missing), /未找到二维码|无法读取/);
    const legacy = await recognizeAnswerCard({ ...missing, identityMode: "legacy" }) as CombinedRecognitionResult;
    assert.equal(legacy.identity?.status, "unverified");
    for (const [name, code, pattern] of [
      ["wrong-card", qr("90000003"), /ID 不匹配/],
      ["wrong-page", qr(card.id, 2), /页码不匹配/],
      ["conflict", qr() + qr("90000003", 1, { ...page.header.qrCode.rect, x: 110 }), /多个不同二维码/],
    ] as const) {
      const request = await render(name, code);
      await assert.rejects(recognizeAnswerCard(request), pattern);
      await assert.rejects(recognizeAnswerCard({ ...request, identityMode: "legacy" }), pattern);
      console.log(`PASS ${size} ${name} strict + legacy`);
    }
    await assert.rejects(validateIdentity({ status: "ok", questions: [] }, missing), /升级/);
    await assert.rejects(validateIdentity({ status: "ok", identity: { status: "verified", cardId: "other", pageNumber: 1 } }, missing), /身份校验失败/);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
