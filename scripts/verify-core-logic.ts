import "./verify-subjective-identity";
/**
 * 核心业务逻辑单元验证（纯函数 + 请求校验，不依赖数据库/服务器）。
 *
 * 覆盖此前零脚本覆盖的模块：
 *   1. validateCardScores —— 卡面总分 / 客观题异常分 / 填空低分 / 解答题低分
 *   2. formatBlankLabel —— 填空标签罗马数字 / 阿拉伯数字 / 无标签
 *   3. server/helpers —— 查询参数、布尔值、数字数组、考试日期解析
 *   4. server/validation —— Zod 请求校验与 validateBody 中间件
 *
 * 运行：npm run verify:core-logic
 */
import { validateCardScores } from "../src/shared/cardScoreValidation";
import { takeLadder } from "../src/shared/ranking";
import { LadderService } from "../src/server/services/LadderService";
import { formatBlankLabel } from "../src/shared/blankLabels";
import { csvCell } from "../src/shared/csv";
import {
  paramValue,
  fieldValue,
  boolField,
  requestFlag,
  numberArray,
  optionalPositiveNumber,
  parsePositiveNumber,
  parseRecognitionDpi,
  isValidExamDate
} from "../src/apps/answer-card/server/helpers";
import {
  isImageExtension, isValidImageBuffer, isValidImageFile, safeImageExtension
} from "../src/apps/answer-card/server/validate-upload";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gradeCombinedRecognition, gradeSubjectiveRecognition } from "../src/shared/grading";
import {
  CreateCardSchema,
  UpdateUserSettingsSchema,
  AssignedFormulaSchema,
  validateBody
} from "../src/apps/answer-card/server/validation";
import type { AnswerCard, ObjectiveBlock, SubjectiveBlock } from "../src/shared/types";

let passed = 0;
let failed = 0;

function check(label: string, condition: unknown): void {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${label}`);
  }
}

function section(label: string): void {
  console.log(`\n== ${label} ==`);
}

function card(subject: string | undefined, blocks: Array<ObjectiveBlock | SubjectiveBlock>): AnswerCard {
  return {
    id: "test-card",
    title: "测试卡",
    subject,
    paper: { size: "A4", orientation: "portrait" },
    studentInfo: { fields: [], studentNumberDigits: 5 },
    bodyBlocks: blocks,
    sided: "single",
    layoutVersion: 1,
    updatedAt: new Date(0).toISOString()
  };
}

function objectiveBlock(count: number, scorePerQuestion: number, scores?: number[]): ObjectiveBlock {
  return {
    id: "obj",
    type: "objective",
    title: "客观题",
    questionStart: 1,
    questionCount: count,
    optionCount: 4,
    mode: "single",
    scorePerQuestion,
    density: "compact",
    questions: scores
      ? scores.map((score, i) => ({
          questionNumber: i + 1,
          mode: "single" as const,
          optionCount: 4,
          score,
          answerKey: ["A"]
        }))
      : undefined
  };
}

function fillBlankBlock(score: number): SubjectiveBlock {
  return {
    id: "fb",
    type: "subjective",
    blockKind: "fill_blank",
    title: "填空题",
    questions: [
      {
        id: "fb1",
        number: 26,
        score,
        style: "manual_score_grid",
        kind: "blank",
        blanks: { count: 2, widthMm: 10, heightMm: 8 },
        minHeightMm: 20
      }
    ]
  };
}

function answerBlock(score: number): SubjectiveBlock {
  return {
    id: "ans",
    type: "subjective",
    title: "解答题",
    questions: [
      {
        id: "ans1",
        number: 27,
        score,
        style: "plain_subjective",
        kind: "lined_answer",
        minHeightMm: 30
      }
    ]
  };
}

/** 含一道 10 分主观题（id=s1）的答题卡：用于主观题身份校验断言。 */
function subjectiveCard(): AnswerCard {
  return card("shuxue", [{
    id: "subj",
    type: "subjective",
    title: "解答题",
    questions: [{
      id: "s1",
      number: 28,
      score: 10,
      style: "manual_score_grid",
      kind: "plain_box",
      minHeightMm: 30
    }]
  }]);
}

section("1. validateCardScores —— 总分与科目");
{
  const r = validateCardScores(card("shuxue", [objectiveBlock(25, 4)]));
  check("理科 25×4=100 分，无任何告警", r.totalScore === 100 && r.issues.length === 0);
  check("非灵活总分科目标记为 false", r.flexibleTotalSubject === false);

  const rFlex = validateCardScores(card("yuwen", [objectiveBlock(25, 4)]));
  check("语文按拼音 yuwen 识别为灵活总分", rFlex.flexibleTotalSubject === true && rFlex.issues.length === 0);

  const rFlexBad = validateCardScores(card("yuwen", [objectiveBlock(10, 4)]));
  check(
    "语文 40 分豁免总分 100/150 告警",
    rFlexBad.flexibleTotalSubject === true && !rFlexBad.issues.some((i) => i.kind === "total")
  );

  const rBadTotal = validateCardScores(card("shuxue", [objectiveBlock(10, 4)]));
  check(
    "总分 40 非 100/150 时产生 total 告警",
    rBadTotal.totalScore === 40 && rBadTotal.issues.some((i) => i.kind === "total")
  );
}

section("2. validateCardScores —— 客观题异常分");
{
  const r = validateCardScores(card("shuxue", [objectiveBlock(5, 4, [4, 4, 3, 4, 4])]));
  check(
    "多数题 4 分中的 3 分题被标记为 objective 异常",
    r.issues.some((i) => i.kind === "objective" && i.questionRefs?.includes("3"))
  );
}

section("3. validateCardScores —— 主观题低分");
{
  const rFill = validateCardScores(card("shuxue", [objectiveBlock(25, 4), fillBlankBlock(0)]));
  check("2 个空却只 0 分产生 fill_blank 告警", rFill.issues.some((i) => i.kind === "fill_blank"));

  const rAnswer = validateCardScores(card("shuxue", [objectiveBlock(25, 4), answerBlock(0)]));
  check("解答题 0 分产生 answer 告警", rAnswer.issues.some((i) => i.kind === "answer"));
}

section("4. formatBlankLabel");
{
  check("无样式返回空串", formatBlankLabel(undefined, 0) === "");
  check("none 返回空串", formatBlankLabel("none", 2) === "");
  check("阿拉伯数字 (1)", formatBlankLabel("arabic_parentheses", 0) === "(1)");
  check("罗马数字 (i)", formatBlankLabel("roman_parentheses", 0) === "(i)");
  check("罗马数字 (ii)", formatBlankLabel("roman_parentheses", 1) === "(ii)");
  check("罗马数字 (iv)", formatBlankLabel("roman_parentheses", 3) === "(iv)");
  check("罗马数字 (v)", formatBlankLabel("roman_parentheses", 4) === "(v)");
  check("罗马数字 (ix)", formatBlankLabel("roman_parentheses", 8) === "(ix)");
  check("罗马数字 (x)", formatBlankLabel("roman_parentheses", 9) === "(x)");
  check("罗马数字 (xl)", formatBlankLabel("roman_parentheses", 39) === "(xl)");
  check("罗马数字 (l)", formatBlankLabel("roman_parentheses", 49) === "(l)");
}

section("5. server/helpers —— 参数解析");
{
  check("paramValue 字符串原样", paramValue("a") === "a");
  check("paramValue 数组取首项", paramValue(["x", "y"]) === "x");
  check("paramValue undefined 为空串", paramValue(undefined) === "");
  check("fieldValue 数组取首项", fieldValue(["7"]) === "7");
  check("fieldValue 数字转字符串", fieldValue(7) === "7");
  check("fieldValue null 为空串", fieldValue(null) === "");
  check("boolField 1/true/yes 均为真", boolField("1") && boolField("true") && boolField("yes") && boolField(" TRUE "));
  check("boolField 0/no 均为假", !boolField("0") && !boolField("no"));
  check("requestFlag 布尔与字符串均识别", requestFlag(true) && requestFlag("true") && !requestFlag(false) && !requestFlag("0"));
  check("numberArray 去重过滤非法值", JSON.stringify(numberArray(["1", "2", -1, 0, 2.5, "2", "3"])) === "[1,2,3]");
  check("optionalPositiveNumber 空为 undefined", optionalPositiveNumber("") === undefined);
  check("optionalPositiveNumber 负数无效", optionalPositiveNumber("-1") === undefined);
  check("optionalPositiveNumber 0 保留", optionalPositiveNumber(0) === 0);
  check("parsePositiveNumber 非法回退", parsePositiveNumber("abc", 10) === 10 && parsePositiveNumber("0", 10) === 10);
  check("parsePositiveNumber 合法解析", parsePositiveNumber("8", 10) === 8);
  check("isValidExamDate 闰年 2024-02-29", isValidExamDate("2024-02-29"));
  check("isValidExamDate 非闰年 2023-02-29 拒绝", !isValidExamDate("2023-02-29"));
  check("isValidExamDate 月份/日期越界拒绝", !isValidExamDate("2024-13-01") && !isValidExamDate("2024-02-30") && !isValidExamDate("2024-00-10"));
  check("isValidExamDate 格式不严格拒绝", !isValidExamDate("2024-1-1") && !isValidExamDate("2024/01/01") && !isValidExamDate(""));
  check("isValidExamDate 年份边界", isValidExamDate("1900-01-01") && isValidExamDate("2100-12-31") && !isValidExamDate("2101-01-01"));
}

section("6. server/validation —— Zod 请求校验");
{
  const ok = CreateCardSchema.safeParse({ subject: "数学", title: "期中考试", examDate: "2026-08-12" });
  check("CreateCardSchema 合法输入带默认值", ok.success && ok.data.englishListening === true && ok.data.paperSize === "A4");
  check("CreateCardSchema 空 subject 拒绝", !CreateCardSchema.safeParse({ subject: "", title: "考试", examDate: "2026-08-12" }).success);
  check("CreateCardSchema 非法日期格式拒绝", !CreateCardSchema.safeParse({ subject: "数学", title: "考试", examDate: "2026/08/12" }).success);

  const boolParsed = UpdateUserSettingsSchema.safeParse({ showTabBar: "false" });
  check("showTabBar=\"false\" 不会被误转 true", boolParsed.success && boolParsed.data.showTabBar === false);
  const boolZero = UpdateUserSettingsSchema.safeParse({ showTabBar: "0" });
  check("showTabBar=0 解析为 false", boolZero.success && boolZero.data.showTabBar === false);
  const boolOne = UpdateUserSettingsSchema.safeParse({ showTabBar: "1" });
  check("showTabBar=1 解析为 true", boolOne.success && boolOne.data.showTabBar === true);
  const boolBad = UpdateUserSettingsSchema.safeParse({ showTabBar: "maybe" });
  check("showTabBar 非法值拒绝", !boolBad.success);

  const formula = AssignedFormulaSchema.safeParse({ type: "linear", enabled: true, params: { a: 1, b: 2 } });
  check("AssignedFormulaSchema 合法线性公式通过", formula.success);
  const formulaBad = AssignedFormulaSchema.safeParse({ type: "linear", enabled: true, params: { a: Infinity } });
  check("AssignedFormulaSchema 拒绝 Infinity", !formulaBad.success);
}

section("7. server/validation —— validateBody 中间件");
{
  const bad = await runValidate(CreateCardSchema, { subject: "", title: "考试", examDate: "2026-08-12" });
  check("非法请求返回 400 + INVALID_VALUE", bad.status === 400 && bad.payload?.code === "INVALID_VALUE" && !bad.next);
  const good = await runValidate(CreateCardSchema, { subject: "数学", title: "考试", examDate: "2026-08-12" });
  check("合法请求放行并应用默认值", good.next && good.body?.englishListening === true);
}

section("8. shared/csv —— 名册/成绩导出统一转义");
{
  check("普通值加引号", csvCell("张三") === '"张三"');
  check("内嵌双引号转义", csvCell('a"b') === '"a""b"');
  check("公式注入加单引号前缀", csvCell("=1+1") === `"'=1+1"`);
  check("日期型加制表符防 Excel 转日期", csvCell("8/10").includes("\t8/10"));
  check("空值输出空单元格", csvCell(null) === '""');
}

section("9. 云端安全检查 —— 上传扩展名白名单（#33）");
{
  check("图片扩展名原样保留", safeImageExtension("scan.PNG") === ".png" && safeImageExtension("a.jpeg") === ".jpeg");
  check("HTML/SVG 扩展名回落 .png", safeImageExtension("payload.html") === ".png"
    && safeImageExtension("payload.svg") === ".png" && safeImageExtension("payload") === ".png");
  check("预览扩展名白名单判定", isImageExtension(".PNG") && !isImageExtension(".html")
    && !isImageExtension(".svg") && !isImageExtension(""));
}

section("10. 云端安全检查 —— 识别 DPI 夹紧（#24）");
{
  check("默认 300", parseRecognitionDpi(undefined) === 300 && parseRecognitionDpi("") === 300);
  check("正常值保留", parseRecognitionDpi(600) === 600 && parseRecognitionDpi("150") === 150);
  check("超大 DPI 夹紧到 1200", parseRecognitionDpi(1e9) === 1200 && parseRecognitionDpi("99999999") === 1200);
  check("过小/非法值回落", parseRecognitionDpi(1) === 50 && parseRecognitionDpi("abc") === 300);
}

section("11. 云端安全检查 —— 主观题身份以卡面为准（#03）");
{
  const card = subjectiveCard();
  const forged = gradeSubjectiveRecognition(card, {
    questionId: "s-forged",
    questionNumber: 999999,
    score: 1_000_000,
    maxScore: 1_000_000,
    status: "ok",
    confidence: 1,
    validCells: [],
    invalidCells: []
  });
  check("卡面外主观题返回 null（不采用自报满分）", forged === null);

  const real = gradeSubjectiveRecognition(card, {
    questionId: "s1",
    questionNumber: 999999,
    score: 99,
    maxScore: 1_000_000,
    status: "ok",
    confidence: 1,
    validCells: [],
    invalidCells: []
  });
  check("卡面内主观题按卡面满分裁剪", real?.maxScore === 10 && real?.score === 10);
  check("题号以卡面定义为准（伪造 questionNumber 被忽略）", real?.questionNumber === 28);

  const combined = gradeCombinedRecognition(card, "forged.png", {
    status: "ok",
    studentId: { status: "ok", value: "20231" },
    questions: [],
    subjectiveQuestions: [{
      questionId: "s-forged",
      questionNumber: 999999,
      score: 1_000_000,
      maxScore: 1_000_000,
      status: "ok",
      confidence: 1,
      validCells: [],
      invalidCells: []
    }]
  });
  check("伪造主观题不进入总分/满分", combined.subjectiveQuestions.length === 0
    && combined.subjectiveScore === 0 && combined.subjectiveMaxScore === 0);
}

section("12. 云端安全检查 —— 磁盘文件魔数校验（RIFF 需带 WEBP，PR280 评审 P2）");
{
  const uploadTmpDir = mkdtempSync(path.join(tmpdir(), "projectx-upload-check-"));
  const riffHeader = (tag: string): Buffer =>
    Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from(tag, "ascii"), Buffer.from([0, 0, 0, 0])]);
  const writeSample = (name: string, bytes: Buffer): string => {
    const target = path.join(uploadTmpDir, name);
    writeFileSync(target, bytes);
    return target;
  };
  check("内存态：RIFF/WEBP 通过", isValidImageBuffer(riffHeader("WEBP")));
  check("内存态：RIFF/AVI 拒绝", !isValidImageBuffer(riffHeader("AVI ")));
  check("磁盘态：PNG 通过", await isValidImageFile(writeSample("ok.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))));
  check("磁盘态：RIFF/WEBP 通过", await isValidImageFile(writeSample("ok.webp", riffHeader("WEBP"))));
  check("磁盘态：AVI 改名 .webp 拒绝", !await isValidImageFile(writeSample("fake.webp", riffHeader("AVI "))));
  check("磁盘态：HTML 改名 .png 拒绝", !await isValidImageFile(writeSample("fake.png", Buffer.from("<html><script>1</script>"))));
  check("磁盘态：过短文件拒绝", !await isValidImageFile(writeSample("short.png", Buffer.from([0x89, 0x50]))));
  rmSync(uploadTmpDir, { recursive: true, force: true });
}

section("13. shared/ranking —— 天梯截断不切开同分并列");
{
  const picked = (ranks: number[]) =>
    takeLadder(ranks.map((rank) => ({ rank })), (r) => r.rank).map((r) => r.rank);
  const tiedFirst = (n: number, tail: number[]) =>
    Array.from({ length: n }, () => 1).concat(tail);

  check("空榜返回空", picked([]).length === 0);
  check("不足 10 人时全量返回", picked([1, 2, 3]).length === 3);
  check("无并列时仍只取前十", picked([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]).length === 10);
  check("恰好 10 人并列第 1 时不扩表", picked(tiedFirst(10, [11, 12])).length === 10);
  check("12 人并列第 1 全部保留", picked(tiedFirst(12, [13, 14])).length === 12);
  check("23 人并列第 1 全部保留且都是第 1 名",
    picked(tiedFirst(23, [24, 25])).length === 23 && picked(tiedFirst(23, [24, 25])).every((r) => r === 1));
  check("第 9 名并列 5 人跨截断线时顺延到 13 条", picked([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9]).length === 13);
  check("第 10 名并列 2 人时顺延到 11 条", picked([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10]).length === 11);
  check("并列组完全落在前十之内时不扩表", picked([1, 2, 2, 2, 4, 5, 6, 7, 8, 9, 10, 11]).length === 10);
  check("顺延只覆盖跨线的那一组，不吞掉后续不同名次",
    picked([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13]).length === 11);

  // LadderService.fromScoreTableRows 的入参形态：analysis 的 score-table 只产出 gradeRank
  const scoreTableRows = (ranks: number[]) =>
    ranks.map((gradeRank, i) => ({
      gradeRank,
      classRank: i + 1,
      totalScore: 150 - gradeRank,
      assignedScore: null,
      rankChange: null,
      prevRank: null,
      studentId: i + 1,
      studentNumber: String(i + 1).padStart(4, "0"),
      studentName: `学生${i + 1}`,
      className: "高一(1)班",
      classId: 1,
      gradeName: "高一",
    })) as any[];
  const plainRanks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

  const plainBoard = LadderService.fromScoreTableRows(scoreTableRows(plainRanks), 13, 5);
  check("单场天梯无并列时仍只取前十", plainBoard.board.length === 10 && plainBoard.board[0].rank === 1);
  check("单场天梯名次与百分位来自 gradeRank（不再丢失 rank 字段）",
    plainBoard.board.every((r) => Number.isFinite(r.rank) && Number.isFinite(r.percentile)));
  check("单场天梯 myRank 取年排、不再为空", plainBoard.myRank === 5 && plainBoard.myScore === 145);
  check("单场天梯只给本人那一条打标记",
    plainBoard.board.filter((r) => r.isCurrentUser).length === 1 &&
    plainBoard.board.some((r) => r.isCurrentUser && r.studentId === 5));

  const outsideBoard = LadderService.fromScoreTableRows(scoreTableRows(plainRanks), 13, 13);
  check("本人在榜外时不打标记、但 myRank 仍是全量年排",
    outsideBoard.board.every((r) => !r.isCurrentUser) && outsideBoard.myRank === 13);

  const firstTie = LadderService.fromScoreTableRows(
    scoreTableRows([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 13, 14, 15]), 15, 1);
  check("单场天梯 12 人并列第 1 全部返回",
    firstTie.board.length === 12 && firstTie.board.every((r) => r.rank === 1));

  const midTie = LadderService.fromScoreTableRows(
    scoreTableRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 9, 9]), 13, 9);
  check("单场天梯第 9 名并列跨线时顺延到 13 条",
    midTie.board.length === 13 && midTie.board[12].rank === 9);
  check("跨榜本人的年排与榜单名次一致",
    midTie.board.filter((r) => r.isCurrentUser).length === 1 &&
    midTie.board.every((r) => !r.isCurrentUser || r.rank === 9) && midTie.myRank === 9);

  const crossTie = LadderService.fromCrossExamRows(
    scoreTableRows([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 13, 14, 15]).map((r: any) => ({
      studentId: r.studentId, studentNumber: r.studentNumber, studentName: r.studentName,
      className: r.className, classId: r.classId, gradeName: r.gradeName,
      totalScore: r.totalScore, totalFullScore: 150, scoreRate: 1,
      attendedCount: 1, absentCount: 0, gradeRank: r.gradeRank, classRank: r.classRank, scores: [],
    })), 15, 3);
  check("跨考天梯同样不切开并列第 1",
    crossTie.board.length === 12 && crossTie.board.every((r) => r.rank === 1));
  check("跨考天梯 myRank 与本人标记一致",
    crossTie.myRank === 1 && crossTie.board.filter((r) => r.isCurrentUser).length === 1);
}

async function runValidate(
  schema: Parameters<typeof validateBody>[0],
  body: unknown
): Promise<{ status: number; payload: any; next: boolean; body: any }> {
  return new Promise((resolve) => {
    const req: any = { body };
    let status = 0;
    const res: any = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: any) {
        resolve({ status, payload, next: false, body: req.body });
      }
    };
    validateBody(schema)(req, res, () => {
      resolve({ status, payload: null, next: true, body: req.body });
    });
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("verify-core-logic: ALL PASS");
