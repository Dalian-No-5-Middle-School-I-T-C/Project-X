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
import { formatBlankLabel } from "../src/shared/blankLabels";
import {
  paramValue,
  fieldValue,
  boolField,
  requestFlag,
  numberArray,
  optionalPositiveNumber,
  parsePositiveNumber,
  isValidExamDate
} from "../src/apps/answer-card/server/helpers";
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
