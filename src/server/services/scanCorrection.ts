import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { recognizeCorrectionCard, type RecognitionRequest } from "../../apps/answer-card/server/recognition";
import { recoverySource, recoveredPage, signRecovery, verifyRecovery } from "./scanCorrectionRecovery";
import path from "node:path";
import { buildInsertIgnore, buildUpsertSQL, getMysqlDb, type DbAdapter } from "../db";
import { databaseTimestamp } from "../db/timestamp";
import { buildLayout } from "../../shared/layout";
import { cardFingerprint } from "../../shared/cardVersion";
import { correctionCells, correctionState, recognizedCells, type CorrectionDocument, type CorrectionEdit, type CorrectionPage } from "../../shared/scanCorrection";
import { gradeObjectiveQuestion, gradeSubjectiveRecognition } from "../../shared/grading";
import type { AnswerCard, CombinedRecognitionResult } from "../../shared/types";
import { listScanRecordsGroupedByStudent } from "../../apps/answer-card/server/database/scan-store";
import { groupSessionPages, validateSessionGroupStructure } from "../../apps/answer-card/server/scanner/session-results";
import { enqueueScannerSubmission, processScannerSessionInQueue, savedReceiptOwnerOfPage } from "./scannerSubmissions";
import { recomputeExamRankings } from "./rankingUpdate";
import { markScoreMutated } from "./examPublishEvents";
import { resolveScannerExam } from "./scannerExam";
import { analysisCache } from "./analysisCache";
import { CardRepository } from "../repositories/CardRepository";
import { assertCorrectionGroupVersion, assertCorrectionPageProvenance, assertCorrectionSessionVersion, correctionProvenanceState, correctionSourceFingerprint, needsCorrectionProvenance, STALE_CORRECTION_PROVENANCE } from "./scanCorrectionProvenance";

export async function storeCorrectionPage(card: AnswerCard, sourceType: CorrectionPage["sourceType"], sourceId: string | number,
  recognition: CombinedRecognitionResult, db = getMysqlDb()) {
  // Do not synthesize alignment for old recognizers or failed marker detection.
  if (!recognition.geometry) {
    await db.run("DELETE FROM scan_correction_pages WHERE source_type=? AND source_id=?", sourceType, String(sourceId));
    return;
  }
  const layout = buildLayout(card).pages.find(p => p.pageNumber === (recognition.pageNumber ?? 1));
  if (!layout) throw new Error("识别页码与答题卡不匹配");
  const { imagePath, layoutPath, blockCrops, ...safe } = recognition;
  const upsert = buildUpsertSQL(db.dialect, "scan_correction_pages",
    ["source_type","source_id","card_version","layout_json","recognition_json","revision"], ["source_type","source_id"],
    ["card_version","layout_json","recognition_json"]);
  await db.run(`${upsert}, revision = revision + 1, recovery_fingerprint = NULL`,
    sourceType, String(sourceId), cardFingerprint(card), JSON.stringify(layout), JSON.stringify(safe), Date.now());
}
export async function loadCorrectionPage(sourceType: CorrectionPage["sourceType"], sourceId: string, imageUrl: string, db = getMysqlDb()): Promise<CorrectionPage | null> {
  const row = await db.get<{ layout_json: string; recognition_json: string; revision: number }>(
    "SELECT layout_json,recognition_json,revision FROM scan_correction_pages WHERE source_type=? AND source_id=?",sourceType,sourceId);
  if (!row) return null;
  const layout = JSON.parse(row.layout_json), recognition = JSON.parse(row.recognition_json);
  return { sourceType, sourceId, revision: Number(row.revision), layout, recognition, ...recognizedCells(layout, recognition), imageUrl };
}
export async function sessionCorrection(card: AnswerCard, sessionId: string, groupId: string, remote: boolean, allowRecovery = remote): Promise<CorrectionDocument> {
  return loadSessionCorrection(card, sessionId, groupId, remote, allowRecovery);
}
async function loadSessionCorrection(card: AnswerCard, sessionId: string, groupId: string, remote: boolean, allowRecovery: boolean,
  savedOwner?: { examId: number; studentNumber: string }): Promise<CorrectionDocument> {
  const receipt = savedOwner ? await getMysqlDb().get<{pages_json:string}>("SELECT pages_json FROM scanner_submissions WHERE session_id=? AND group_id=? AND exam_id=? AND student_number=? AND state='saved'",
    sessionId,groupId,savedOwner.examId,savedOwner.studentNumber) : null;
  if (savedOwner && !receipt) throw new Error("原卷归属已变化，请重新打开成绩修改");
  const session = await getMysqlDb().get<{card_version:string|null;version_source:string}>("SELECT card_version,version_source FROM twain_scan_sessions WHERE id=?",sessionId);
  if (!session) throw new Error("扫描会话不存在");
  if (session.card_version && session.card_version !== cardFingerprint(card)) throw new Error("答题卡版本已变化，请核对原卷版本后重新扫描");
  const records = (await listScanRecordsGroupedByStudent(sessionId)).flatMap(g => g.records);
  const group = groupSessionPages(card, records).groups.get(groupId);
  if (!group) throw new Error("答题卡分组不存在");
  if (receipt) {
    const owned = JSON.parse(receipt.pages_json) as Array<{recordId:string}>;
    if (owned.length !== group.length || group.some(row=>!owned.some(page=>page.recordId===row.record.id))) throw new Error("原卷页序或归属已变化，请先处理异常卷");
    validateSessionGroupStructure(card,group,buildLayout(card).pages.length);
  }
  const pages: CorrectionPage[] = [];
  for (const { record, page: mapped } of group) {
    const url = remote ? `/api/scanner/upload/records/${encodeURIComponent(record.id)}/image` : `/api/scanner/scan-image/${encodeURIComponent(record.id)}`;
    let page = await loadCorrectionPage("twain_scan_record", record.id, url);
    const provenance = allowRecovery ? await correctionProvenanceState(getMysqlDb(),card,record.id) : null;
    // A recovery fingerprint binds current-version drafts as well as legacy papers.
    const unverified = allowRecovery && (provenance === "invalid"
      || (provenance === "absent" && needsCorrectionProvenance(session)));
    if (!page || unverified) {
      if (!allowRecovery) throw new Error("此卷缺少坐标映射，请在服务器异常卷处理中重新识别");
      if (!savedOwner && await getMysqlDb().get("SELECT exam_id FROM scanner_submissions WHERE session_id=? AND group_id=? AND state IN ('saved','discarded')",sessionId,groupId)) throw new Error("此卷已入库或已作废，请从成绩修改进入整卡改分");
      const source = await recoverySource(getMysqlDb(),card,record.id);
      const layout = buildLayout(card).pages.find(p=>p.pageNumber===mapped.layoutPage)!;
      page = {sourceType:"twain_scan_record",sourceId:record.id,revision:page?.revision ?? 0,layout,imageUrl:url,
        recognition:{status:"partial",pageNumber:mapped.layoutPage,questions:[],subjectiveQuestions:[]},selected:[],invalid:[],
        recovery:{fingerprint:source.fingerprint,identityMode:source.identityMode,dpi:source.dpi,...(unverified?{reason:"provenance" as const}:{})}};
    }
    // ID-only correction predating the overlay must be reflected on reopening.
    if (!page.recovery && record.student_id && page.recognition.studentId?.value !== record.student_id) {
      page.recognition.studentId = { status: "ok", value: record.student_id };
      Object.assign(page, recognizedCells(page.layout, page.recognition));
    }
    pages.push(page);
  }
  return { card, pages, version: cardFingerprint(card) };
}
let recoveryRunning = false;
/** Only this explicit recovery operation invokes Linux OMR; it never persists the draft. */
export async function recognizeSessionCorrection(card: AnswerCard, sessionId: string, groupId: string, raw: unknown,
  recognize: (request:RecognitionRequest)=>Promise<Record<string,unknown>> = recognizeCorrectionCard): Promise<CorrectionDocument> {
  return recognizeCorrectionDocument(() => sessionCorrection(card,sessionId,groupId,true),raw,recognize);
}
export async function recognizeStudentCorrection(card: AnswerCard, examId: number, studentId: number, raw: unknown,
  recognize: (request:RecognitionRequest)=>Promise<Record<string,unknown>> = recognizeCorrectionCard): Promise<CorrectionDocument> {
  return recognizeCorrectionDocument(() => studentCorrection(card,examId,studentId),raw,recognize);
}
async function recognizeCorrectionDocument(load: () => Promise<CorrectionDocument>, raw: unknown,
  recognize: (request:RecognitionRequest)=>Promise<Record<string,unknown>>): Promise<CorrectionDocument> {
  if (recoveryRunning) throw new Error("另一份旧卷正在识别，请稍后重试");
  recoveryRunning = true;
  let dir:string|undefined;
  try {
    const document = await load(), card = document.card;
    const missing = document.pages.filter(p=>p.recovery && !p.recognition.geometry);
    const input = raw as {version?:string;pages?:Array<{sourceId:string;fingerprint:string}>}|null;
    if (input?.version !== document.version || !Array.isArray(input.pages) || input.pages.length!==missing.length ||
      new Set(input.pages.map(p=>p?.sourceId)).size!==missing.length || missing.some(p=>!input.pages!.some(e=>e?.sourceId===p.sourceId && e.fingerprint===p.recovery!.fingerprint))) throw new Error("原卷或版式已变化，请重新打开后识别");
    if (!missing.length) return document;
    dir = await mkdtemp(path.join(tmpdir(),"projectx-correction-"));
    const layoutPath = path.join(dir,"layout.json");
    await writeFile(layoutPath,JSON.stringify(buildLayout(card)));
    for (const page of missing) {
      const source = await recoverySource(getMysqlDb(),card,page.sourceId);
      if (source.fingerprint !== page.recovery!.fingerprint) throw new Error("原卷已变化，请重新打开后识别");
      const recognition = await recognize({imagePath:source.imagePath,layoutPath,pageNumber:page.layout.pageNumber,dpi:source.dpi,identityMode:source.identityMode});
      const result = recoveredPage(card,page,recognition);
      if (result.recognition.geometry?.imageWidth!==source.width || result.recognition.geometry.imageHeight!==source.height) throw new Error("重新识别坐标与原卷尺寸不匹配");
      // Pre-provenance snapshots may already contain saved teacher edits. Verify
      // alignment afresh, then retain those marks for the teacher's explicit save.
      if (page.recovery?.reason === "provenance") {
        const previous = await getMysqlDb().get<{card_version:string;revision:number;recognition_json:string;modified_by:number|null;recovery_fingerprint:string|null}>(
          "SELECT card_version,revision,recognition_json,modified_by,recovery_fingerprint FROM scan_correction_pages WHERE source_type=? AND source_id=?",page.sourceType,page.sourceId);
        if (previous && Number(previous.revision)===page.revision && previous.card_version===document.version && previous.modified_by!==null && !previous.recovery_fingerprint) {
          const selected = recognizedCells(page.layout,JSON.parse(previous.recognition_json)).selected;
          result.recognition = correctionState(card,result,selected).recognition;
          Object.assign(result,recognizedCells(page.layout,result.recognition));
        }
      }
      const latest = await recoverySource(getMysqlDb(),card,page.sourceId);
      if (latest.fingerprint!==source.fingerprint) throw new Error("识别期间原卷已变化，请重新打开");
      result.recovery = {...page.recovery!,signature:signRecovery(source.fingerprint,result.recognition)};
      Object.assign(page,result);
    }
    return document;
  } finally {
    try { if(dir) await rm(dir,{recursive:true,force:true}); } finally { recoveryRunning=false; }
  }
}
export async function studentCorrection(card: AnswerCard, examId: number, studentId: number): Promise<CorrectionDocument> {
  const db = getMysqlDb();
  const student = await db.get<{student_number: string}>("SELECT student_number FROM users WHERE id=?",studentId);
  if (!student) throw new Error("学生不存在");
  const receipts = await db.all<{session_id:string;group_id:string}>(
    "SELECT session_id,group_id FROM scanner_submissions WHERE exam_id=? AND student_number=? AND state='saved'",examId,student.student_number);
  if (receipts.length > 1) throw new Error("存在多份已保存原卷，请先处理重复卷");
  if (receipts.length === 1) return loadSessionCorrection(card,receipts[0].session_id,receipts[0].group_id,false,true,
    {examId,studentNumber:student.student_number});
  // A regrade creates a new batch but retains historical source records.
  const latest = await db.get<{batch_id:number}>(`SELECT sr.batch_id FROM scan_records sr JOIN scan_batches sb ON sb.id=sr.batch_id
    WHERE sb.exam_id=? AND sr.student_id=? AND sb.status IN ('done','partial') ORDER BY sb.id DESC LIMIT 1`,examId,studentId);
  const scans = latest ? await db.all<{id:number;file_path:string}>(`SELECT id,file_path FROM scan_records
    WHERE batch_id=? AND student_id=? ORDER BY id`,latest.batch_id,studentId) : [];
  const pages: CorrectionPage[] = [];
  for (const scan of scans) {
    const page = await loadCorrectionPage("scan_record",String(scan.id),`/api/scanner/grading-image/${encodeURIComponent(card.id)}/${encodeURIComponent(path.basename(scan.file_path))}`);
    if (!page) throw new Error("此卷缺少坐标映射，请使用新版 Windows 扫描端重新识别后改分");
    pages.push(page);
  }
  if (!pages.length) throw new Error("未找到可编辑的完整原卷");
  if (pages.length !== buildLayout(card).pages.length) throw new Error("答题卡缺页，请补齐原卷后再改分");
  if (new Set(pages.map(p => p.layout.pageNumber)).size !== pages.length) throw new Error("存在重复扫描页，请先处理重复卷");
  return {card,pages,version:cardFingerprint(card)};
}
function validateEdits(document: CorrectionDocument, raw: unknown): CorrectionEdit[] {
  if (!Array.isArray(raw) || raw.length !== document.pages.length) throw new Error("请提交完整答题卡");
  const seen = new Set<string>();
  for (const edit of raw) {
    const page = document.pages.find(p => p.sourceId === edit?.sourceId);
    if (!page || seen.has(page.sourceId) || edit.revision !== page.revision) throw new Error("答题卡已更新，请重新打开后修改");
    seen.add(page.sourceId);
    if (page.recovery) {
      if (page.recovery.reason === "provenance" && !edit.recovery) throw new Error(STALE_CORRECTION_PROVENANCE);
      if (edit.recovery?.fingerprint !== page.recovery.fingerprint) throw new Error("原卷已变化，请重新打开后识别");
      verifyRecovery(edit.recovery.fingerprint,edit.recovery.recognition,edit.recovery.signature);
      Object.assign(page,recoveredPage(document.card,page,edit.recovery.recognition));
    } else if (edit.recovery) throw new Error("此卷已有识别数据，请重新打开后修改");
    const ids = new Set(correctionCells(page.layout).map(c => c.id));
    if (!Array.isArray(edit.selected) || edit.selected.length > ids.size || new Set(edit.selected).size !== edit.selected.length || edit.selected.some((id: unknown) => typeof id !== "string" || !ids.has(id))) throw new Error("填涂格数据无效");
    if (edit.touched !== undefined && (!Array.isArray(edit.touched) || edit.touched.length > ids.size || edit.touched.some((id: unknown) => typeof id !== "string" || !ids.has(id)))) throw new Error("修改记录无效");
  }
  return raw;
}
async function writePages(tx: DbAdapter, document: CorrectionDocument, edits: CorrectionEdit[], userId: number | null) {
  const result = [];
  for (const page of document.pages) {
    const edit = edits.find(e => e.sourceId === page.sourceId)!;
    let revision = edit.revision;
    if (page.recovery) {
      const source = await recoverySource(tx,document.card,page.sourceId);
      if (source.fingerprint !== page.recovery.fingerprint) throw new Error("原卷已变化，请重新打开后识别");
      if (source.width !== page.recognition.geometry?.imageWidth || source.height !== page.recognition.geometry?.imageHeight) throw new Error("坐标映射与原卷尺寸不匹配");
      if (revision === 0) {
        revision = Date.now();
        const inserted = await tx.run(buildInsertIgnore(tx.dialect,"scan_correction_pages",["source_type","source_id","card_version","layout_json","recognition_json","revision"]),
          page.sourceType,page.sourceId,document.version,JSON.stringify(page.layout),JSON.stringify(page.recognition),revision);
        if (!inserted.changes) throw new Error("另一位教师已更新此卷，请重新打开");
      } else {
        const updated = await tx.run(`UPDATE scan_correction_pages SET card_version=?,layout_json=?,recognition_json=?,recovery_fingerprint=NULL
          WHERE source_type=? AND source_id=? AND revision=?`,document.version,JSON.stringify(page.layout),JSON.stringify(page.recognition),page.sourceType,page.sourceId,revision);
        if (!updated.changes) throw new Error("另一位教师已更新此卷，请重新打开");
      }
    }
    const row = await tx.get<{card_version:string;revision:number}>("SELECT card_version,revision FROM scan_correction_pages WHERE source_type=? AND source_id=?",page.sourceType,page.sourceId);
    if (!row || Number(row.revision) !== revision || row.card_version !== document.version) throw new Error("答题卡版式或识别结果已变化，请重新识别或重新打开");
    const state = correctionState(document.card,page,edit.selected,edit.touched);
    if (state.errors.length) throw new Error(state.errors.join("；"));
    const updated = await tx.run(`UPDATE scan_correction_pages SET recognition_json=?,revision=revision+1,modified_by=?,modified_at=?
      WHERE source_type=? AND source_id=? AND revision=?`,JSON.stringify(state.recognition),userId,databaseTimestamp(),page.sourceType,page.sourceId,revision);
    if (!updated.changes) throw new Error("另一位教师已修改此卷，请重新打开");
    result.push({page,edit,recognition:state.recognition});
  }
  return result;
}
function changedScores(card: AnswerCard, page: CorrectionPage, edit: CorrectionEdit, recognition: CombinedRecognitionResult) {
  const changedCells = correctionCells(page.layout).filter(c => page.selected.includes(c.id) !== edit.selected.includes(c.id) || (page.invalid.includes(c.id) && edit.selected.includes(c.id) && edit.touched?.includes(c.id)));
  return [
          ...recognition.questions.filter(q => changedCells.some(c => c.type === "objective_option" && c.questionNumber === q.questionNumber)).map(q => ({number:String(q.questionNumber),type:"objective",score:gradeObjectiveQuestion(card,q).score,options:JSON.stringify(q.selectedOptions)})),
          ...recognition.subjectiveQuestions.filter(q => changedCells.some(c => c.type === "score_cell" && c.questionId === q.questionId && (!q.blockId || c.blockId === q.blockId))).flatMap(q => {
            const grade = gradeSubjectiveRecognition(card, q);
            return grade ? [{number:String(grade.questionNumber),type:"subjective",score:grade.score,options:null}] : [];
          }),
  ];
}

/** Commit corrected marks, then admit only this card through the existing receipt and duplicate checks. */
export async function saveSessionCorrection(card: AnswerCard, sessionId: string, groupId: string, raw: unknown, userId: number | null, allowRecovery = false, draft = false) {
  return enqueueScannerSubmission(async () => {
    const db = getMysqlDb(), document = await sessionCorrection(card,sessionId,groupId,false,allowRecovery);
    const edits = validateEdits(document,raw);
    const resolved = await resolveScannerExam(card.id,sessionId);
    await db.transaction(async tx => {
      if (resolved.exam) await tx.run("UPDATE exams SET id=id WHERE id=?",resolved.exam.id);
      const current = await new CardRepository(tx).findById(card.id);
      if (!current || cardFingerprint(current)!==document.version) throw new Error("答题卡版本已变化，请重新打开后核对");
      if (await tx.get("SELECT exam_id FROM scanner_submissions WHERE session_id=? AND group_id=? AND state IN ('saved','discarded')",sessionId,groupId)) throw new Error("此卷已入库或已作废，请从成绩修改进入整卡改分");
      // Recheck existing evidence after obtaining the exam lock, before changing its inputs.
      const verifiedPageIds = document.pages.filter(p=>!p.recovery).map(p=>p.sourceId);
      if (allowRecovery) {
        const session = await tx.get<{card_id:string;card_version:string|null;version_source:string}>("SELECT card_id,card_version,version_source FROM twain_scan_sessions WHERE id=?",sessionId);
        assertCorrectionSessionVersion(card,session);
        if (verifiedPageIds.length) await assertCorrectionGroupVersion(tx,card,session,verifiedPageIds);
      } else {
        for (const sourceId of verifiedPageIds) await assertCorrectionPageProvenance(tx,card,sourceId);
      }
      const results = await writePages(tx,document,edits,userId);
      const number = results.find(r => r.page.layout.studentArea)?.recognition.studentId?.value;
      if (!number) throw new Error("请完整填写学号");
      for (const {page,recognition} of results) {
        // Marker/QR failures cannot be turned into valid scans by a manual mark.
        if (!recognition.geometry || recognition.identity?.status === "rejected") throw new Error("原卷定位或二维码校验失败，请重新识别");
        await tx.run("UPDATE twain_scan_records SET student_id=?,ocr_status='review',ocr_error=NULL,identity_json=? WHERE id=? AND session_id=?",number,JSON.stringify(recognition.identity),page.sourceId,sessionId);
        await tx.run(buildUpsertSQL(tx.dialect,"twain_recognition_results",["id","scan_record_id","objective_json","subjective_json","grade_status"],["scan_record_id"],["objective_json","subjective_json","grade_status"]),
          page.sourceId,page.sourceId,JSON.stringify(recognition.questions),JSON.stringify(recognition.subjectiveQuestions),"recognized");
      }
      // Stamp only the pages verified by signed recovery, or carrying a verified
      // recovery into a subsequent edit. Other originals in this session stay unknown.
      // The fingerprint binds the post-write revision, so it must be computed after writePages.
      for (const {page} of results) {
        const prior = await tx.get<{recovery_fingerprint:string|null}>("SELECT recovery_fingerprint FROM scan_correction_pages WHERE source_type=? AND source_id=?",page.sourceType,page.sourceId);
        if (page.recovery || prior?.recovery_fingerprint) {
          const fingerprint = await correctionSourceFingerprint(tx,card,page.sourceId);
          await tx.run("UPDATE scan_correction_pages SET recovery_fingerprint=? WHERE source_type=? AND source_id=?",fingerprint,page.sourceType,page.sourceId);
        }
      }
      // Existing pages were checked before writes; recovered pages were checked
      // against their signed source in writePages. Do not hash newly stamped pages again.
      // Validate against transactional records before committing any correction.
      const records = (await tx.all<any>(`SELECT r.*,s.identity_mode,g.objective_json,g.subjective_json FROM twain_scan_records r
        JOIN twain_scan_sessions s ON s.id=r.session_id
        LEFT JOIN twain_recognition_results g ON g.scan_record_id=r.id WHERE r.session_id=?`,sessionId))
        .map(r => ({...r, recognition:r.objective_json ? {objective_json:r.objective_json,subjective_json:r.subjective_json} : null}));
      const grouped = groupSessionPages(card,records);
      validateSessionGroupStructure(card,grouped.groups.get(groupId)!,grouped.pageCount);
      // A withdrawn original may carry manual/review grades. Patch its saved snapshot
      // so restoring it preserves those grades and also applies this correction.
      const receipts = await tx.all<{exam_id:number;score_snapshot:string}>("SELECT exam_id,score_snapshot FROM scanner_submissions WHERE session_id=? AND group_id=? AND score_snapshot IS NOT NULL",sessionId,groupId);
      for (const receipt of receipts) {
        const snapshot = JSON.parse(receipt.score_snapshot) as {score:Record<string,unknown>;questions:Array<Record<string,unknown>>};
        for (const {page,edit,recognition} of results) for (const update of changedScores(card,page,edit,recognition)) {
          const question = snapshot.questions.find(q => String(q.question_number)===update.number && q.score_type===update.type);
          if (!question) throw new Error(`成绩快照缺少第 ${update.number} 题`);
          Object.assign(question,{score:update.score,selected_options:update.options,manually_modified:1,modified_by:userId,modified_at:databaseTimestamp()});
        }
        const sum = (type:string) => snapshot.questions.filter(q=>q.score_type===type).reduce((n,q)=>n+Number(q.score),0);
        Object.assign(snapshot.score,{objective_score:sum("objective"),subjective_score:sum("subjective"),total_score:Math.round((sum("objective")+sum("subjective"))*100)/100});
        await tx.run("UPDATE scanner_submissions SET score_snapshot=? WHERE exam_id=? AND session_id=? AND group_id=?",JSON.stringify(snapshot),receipt.exam_id,sessionId,groupId);
      }
    });
    // 远端上传模式只把订正留在本机识别结果里。本机考试能解析时若直接入库，
    // 后处理页会把 saved 当成远端回执，确认过的卷不再上传。
    if (draft) return { saved: false, drafted: true, message: "填涂订正已保存，等待上传到服务器" };
    // Retain queue ownership until this card has passed normal admission checks;
    // retry previews must not observe corrected marks with a still-pending receipt.
    const admission = await resolveScannerExam(card.id,sessionId);
    if (!admission.exam) return {saved:false,message:"填涂订正已保存，等待上传到关联考试"};
    const batch = await processScannerSessionInQueue(card,sessionId,"save",groupId);
    const row = batch.results.find(r => r.groupId === groupId);
    const saved = Boolean(row?.saved);
    if (row && !saved && row.needsReviewCount > 0) {
      return {saved:false,message:"仍有存疑题，本次订正已留下，全部确认后再入库"};
    }
    return {saved,message:saved ? "改分已保存" : batch.failures.find(f=>f.groupId===groupId)?.message ?? "订正已保存，请继续处理重复卷"};
  });
}
/** Patch only changed objective answers / paper-marked scores. Never rewrite online review submissions. */
export async function saveStudentCorrection(card: AnswerCard, examId: number, studentId: number, raw: unknown, userId: number | null) {
  await enqueueScannerSubmission(async () => {
    const db = getMysqlDb(), document = await studentCorrection(card,examId,studentId), edits = validateEdits(document,raw);
    await db.transaction(async tx => {
      await tx.run("UPDATE exams SET id=id WHERE id=?",examId);
      const current = await new CardRepository(tx).findById(card.id);
      if (!current || cardFingerprint(current)!==document.version) throw new Error("答题卡版本已变化，请重新打开后核对");
      const student = await tx.get<{student_number:string}>("SELECT student_number FROM users WHERE id=?",studentId);
      const recoveredIds: string[] = [];
      for (const page of document.pages) {
        if (page.sourceType !== "twain_scan_record") continue;
        if (page.recovery) {
          const record = await tx.get<{session_id:string}>("SELECT session_id FROM twain_scan_records WHERE id=?",page.sourceId);
          const owner = record && await savedReceiptOwnerOfPage(record.session_id,page.sourceId,false,tx);
          if (!owner || Number(owner.exam_id)!==examId || owner.student_number!==student?.student_number) throw new Error("原卷归属已变化，请重新打开成绩修改");
          recoveredIds.push(page.sourceId);
          continue;
        }
        const provenance = await correctionProvenanceState(tx, card, page.sourceId);
        if (provenance === "invalid") throw new Error(STALE_CORRECTION_PROVENANCE);
        if (provenance === "absent") {
          const session = await tx.get<{ card_version: string | null; version_source: string }>(
            "SELECT s.card_version,s.version_source FROM twain_scan_records r JOIN twain_scan_sessions s ON s.id=r.session_id WHERE r.id=?",
            page.sourceId,
          );
          // v64 之前保存的旧卷没有指纹；要求先走签名补识别，不能直接改正式成绩。
          if (session && needsCorrectionProvenance(session)) throw new Error(STALE_CORRECTION_PROVENANCE);
        }
        if (provenance === "valid") recoveredIds.push(page.sourceId);
      }
      const results = await writePages(tx,document,edits,userId);
      const number = results.find(r => r.page.layout.studentArea)?.recognition.studentId?.value;
      if (number && number !== student?.student_number) throw new Error("已入库答卷的学号归属不能直接覆盖，请在异常卷处理中订正归属后保存");
      let changed = false;
      for (const {page,edit,recognition} of results) {
        const updates = changedScores(card,page,edit,recognition);
        for (const u of updates) {
          const prior = await tx.get<{score:number;selected_options:string|null;max_score:number}>("SELECT score,selected_options,max_score FROM question_scores WHERE exam_id=? AND student_id=? AND question_number=? AND score_type=?",examId,studentId,u.number,u.type);
          if (!prior || u.score > Number(prior.max_score)) throw new Error(`第 ${u.number} 题成绩不存在或分值已变化`);
          await tx.run("UPDATE question_scores SET score=?,selected_options=?,manually_modified=1,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=? AND question_number=? AND score_type=?",u.score,u.options,userId,databaseTimestamp(),examId,studentId,u.number,u.type);
          await tx.run(`INSERT INTO answer_overrides (exam_id,card_id,question_number,score_type,override_type,old_value,new_value,created_by,created_at) VALUES (?,?,?,?,'score',?,?,?,?)`,examId,card.id,u.number,u.type,JSON.stringify({studentId,...prior}),JSON.stringify({studentId,score:u.score,selectedOptions:u.options}),userId,databaseTimestamp());
          changed = true;
        }
      }
      for (const sourceId of recoveredIds) await tx.run(
        "UPDATE scan_correction_pages SET recovery_fingerprint=? WHERE source_type='twain_scan_record' AND source_id=?",
        await correctionSourceFingerprint(tx,card,sourceId),sourceId);
      if (document.pages.some(page => page.recovery)) await tx.run(
        "INSERT INTO answer_overrides (exam_id,card_id,question_number,score_type,override_type,old_value,new_value,created_by,created_at) VALUES (?,?,NULL,'objective','score',?,?,?,?)",
        examId,card.id,JSON.stringify({studentId,action:"correction_reverify"}),
        JSON.stringify({studentId,action:"correction_reverify",pages:document.pages.filter(page=>page.recovery).map(page=>({sourceId:page.sourceId,fingerprint:page.recovery!.fingerprint}))}),userId,databaseTimestamp());
      if (changed) {
        const sums = await tx.all<{score_type:string;total:number}>("SELECT score_type,SUM(score) AS total FROM question_scores WHERE exam_id=? AND student_id=? GROUP BY score_type",examId,studentId);
        const objective = Number(sums.find(s => s.score_type === "objective")?.total ?? 0), subjective = Number(sums.find(s => s.score_type === "subjective")?.total ?? 0);
        await tx.run("UPDATE student_scores SET objective_score=?,subjective_score=?,total_score=?,manually_modified=1,modified_by=?,modified_at=? WHERE exam_id=? AND student_id=?",objective,subjective,Math.round((objective+subjective)*100)/100,userId,databaseTimestamp(),examId,studentId);
        await markScoreMutated(tx,examId,userId,"score_edit");
        const recalc = await recomputeExamRankings(tx,examId);
        if (!recalc.assignedScoresRecalculated) {
          throw new Error(`赋分重算失败，改分未保存：${recalc.assignedScoreError ?? "请检查赋分公式后重试"}`);
        }
      }
    });
    analysisCache.invalidateExam(examId);
  });
}
