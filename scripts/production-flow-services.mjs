/** Exercise the installed service using the same private VM fixture as the browser. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import targets from "./production-flow-target.cjs";

const root = path.resolve(
  process.env.PROJECTX_FLOW_ROOT || "ignored/production-flow",
);
const state = JSON.parse(await fs.readFile(path.join(root, "state.json")));
targets.validateTargets(state);
const stage = process.argv[2];
const evidence = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function call(
  route,
  {
    method = "GET",
    body,
    token = state.adminToken,
    statuses = [200],
    binary = false,
  } = {},
) {
  const form = body instanceof FormData;
  const headers = {
    ...(token && { Authorization: "Bearer " + token }),
    ...(!form && body && { "Content-Type": "application/json" }),
  };
  const response = await fetch(state.server + route, {
    method,
    headers,
    body: form ? body : JSON.stringify(body),
  });
  evidence.push({ method, route, status: response.status });
  const detail =
    !statuses.includes(response.status) && !route.includes("/auth/")
      ? await response
          .clone()
          .json()
          .then((r) => r.message || r.error || "")
          .catch(() => "")
      : "";
  assert.ok(
    statuses.includes(response.status),
    method + " " + route + " returned " + response.status + " " + detail,
  );
  if (binary)
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      headers: response.headers,
    };
  if (response.status === 204) return;
  return response.json();
}
async function account(identifier) {
  const login = (password) =>
    call("/api/auth/login", {
      method: "POST",
      body: { identifier, password },
      token: "",
      statuses: [200, 401],
    });
  let session = await login(state.password);
  if (!session.token) session = await login(state.changedPassword);
  if (session.passwordChangeRequired) {
    await call("/api/auth/change-password", {
      method: "POST",
      token: session.token,
      body: { oldPassword: state.password, newPassword: state.changedPassword },
    });
    session = await login(state.changedPassword);
  }
  assert.ok(session.token);
  return session.token;
}
async function consoleBuild() {
  for (const name of [
    "summary",
    "activity",
    "preferences",
    "ai-usage",
    "data-quality",
    "soft-deleted-exams",
  ])
    await call("/api/admin/console/" + name);
  await call("/api/admin/data-retention-policies");
  const result = await call("/api/admin/console/build");
  assert.match(result.build.commit, /^[a-f0-9]{40}$/);
  assert.equal(
    result.build.commitShort,
    result.build.commit.slice(0, result.build.commitShort.length),
  );
  assert.ok(Number.isFinite(Date.parse(result.build.builtAt)));
  assert.ok(result.runtime.uptimeSeconds >= 0);
  assert.equal(
    Math.floor(
      (Date.parse(result.runtime.now) - Date.parse(result.runtime.startedAt)) /
        1000,
    ),
    result.runtime.uptimeSeconds,
  );
  evidence.push(result);
}
async function feedback() {
  const teacher = await account("flow_teacher");
  const student = await account("flow_10008");
  const form = new FormData();
  form.set("title", "全链路双机截图核对");
  form.set("content", "测试账号提交两张界面截图供管理员核对。");
  const screenshot = await fs.readFile(
    path.join(root, "evidence", "首次登录强制改密.png"),
  );
  for (const name of ["界面一.png", "界面二.png"])
    form.append("files", new Blob([screenshot], { type: "image/png" }), name);
  await call("/api/feedback", {
    method: "POST",
    token: student,
    body: { title: "角色权限", content: "测试" },
    statuses: [403],
  });
  const { data } = await call("/api/feedback", {
    method: "POST",
    body: form,
    token: teacher,
    statuses: [201],
  });
  assert.ok(data.id);
  const reports = await call("/api/feedback/mine", { token: teacher });
  const record = reports.data.find((r) => r.id === data.id);
  assert.equal(record.attachments.length, 2);
  for (const file of record.attachments) {
    const saved = await call(
      "/api/feedback/" + data.id + "/attachments/" + file.id,
      { binary: true },
    );
    assert.equal(hash(saved.bytes), hash(screenshot));
  }
  await call("/api/feedback/" + data.id, {
    method: "PATCH",
    body: { status: "resolved" },
  });
  const resolved = await call("/api/feedback?status=resolved");
  assert.ok(
    resolved.data.some((r) => r.id === data.id && r.status === "resolved"),
  );
  await call("/api/feedback/" + data.id, { method: "DELETE" });
  assert.ok(
    !(await call("/api/feedback/mine", { token: teacher })).data.some(
      (r) => r.id === data.id,
    ),
  );
}
async function organization() {
  const rows = Array.from({ length: 60 }, (_, i) =>
    ["高一双机验收", (i % 3) + 1 + "班", 20001 + i, "合成学生" + (i + 1)].join(
      ",",
    ),
  );
  const csvText = [
    "年级,班级,学号,姓名",
    ...rows,
    "高一双机验收,2班,20001,合成学生1",
  ].join("\n");
  const result = await call("/api/users/import-csv", {
    method: "POST",
    body: { csvText },
  });
  assert.deepEqual(result.students.errors, []);
  const grade = (await call("/api/classes/grades")).find(
    (g) => g.name === "高一双机验收",
  );
  const classes = await call("/api/classes?gradeId=" + grade.id);
  assert.equal(classes.length, 3);
  const rosters = await Promise.all(
    classes.map((c) => call("/api/classes/" + c.id + "/students")),
  );
  const all = rosters.flat().map((s) => s.student_id);
  assert.equal(new Set(all).size, 60);
  assert.equal(all.length, 61);
  const exported = await call("/api/export/students", { binary: true });
  assert.equal(exported.bytes.readUInt32LE(0), 0x04034b50);
  evidence.push({
    students: 60,
    memberships: 61,
    classes: 3,
    exportBytes: exported.bytes.length,
  });
}
async function paperRevision() {
  const card = await call("/api/cards", {
    method: "POST",
    body: {
      subject: "math",
      subjectLabel: "数学",
      title: "版本门双机复测",
      examDate: new Date().toISOString().slice(0, 10),
    },
    statuses: [200, 201],
  });
  const route = "/api/cards/" + card.id;
  const pdf = await call(route + "/pdf?v=" + card.revision, { binary: true });
  assert.equal(pdf.headers.get("x-card-revision"), String(card.revision));
  assert.match(pdf.headers.get("cache-control"), /no-store/);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
  for (const value of ["-1", "01", "abc"])
    assert.equal(
      (await call(route + "/pdf?v=" + value, { statuses: [400] })).code,
      "CARD_REVISION_INVALID",
    );
  const updated = await call(route, {
    method: "PUT",
    body: { ...card, title: card.title + "第二版" },
  });
  assert.ok(updated.revision > card.revision);
  const stale = await call(route + "/pdf?v=" + card.revision, {
    statuses: [409],
  });
  assert.match(stale.code, /REVISION/);
  const fresh = await call(route + "/pdf?v=" + updated.revision, {
    binary: true,
  });
  assert.equal(fresh.headers.get("x-card-revision"), String(updated.revision));
  await fs.writeFile(
    path.join(root, "evidence", "版本更新后导出.pdf"),
    fresh.bytes,
  );
}

async function transferHistory() {
  const grades = await call("/api/classes/grades");
  const originalGrade = grades.find((g) => g.name === "高一双机验收");
  const classes = await call("/api/classes?gradeId=" + originalGrade.id);
  const home = classes.find((c) => c.name === "1班"),
    other = classes.find((c) => c.name === "2班");
  const newGrade =
    grades.find((g) => g.name === "高二调班核验") ||
    (await call("/api/classes/grades", {
      method: "POST",
      body: { name: "高二调班核验" },
      statuses: [200, 201],
    }));
  const promoted =
    (await call("/api/classes?gradeId=" + newGrade.id)).find(
      (c) => c.name === "晋级班",
    ) ||
    (await call("/api/classes", {
      method: "POST",
      body: { gradeId: newGrade.id, name: "晋级班" },
      statuses: [200, 201],
    }));
  const user = (await call("/api/users?keyword=20031")).users.find(
    (u) => u.student_number === "20031",
  );
  const list = await call("/api/exams");
  const fixture = (list.exams || list).find(
    (e) => e.name === "双机跨年级调班统计复测",
  );
  assert.ok(fixture);
  const exam = "/api/analysis/exams/" + fixture.id;
  const roster = (c) => "/api/classes/" + c.id + "/students";
  const inRoster = async (c) =>
    (await call(roster(c))).some((row) => row.student_id === user.id);
  const check = async (current, totals) => {
    const rows = (await call(exam + "/score-table")).rows;
    assert.equal(rows.length, 2);
    assert.equal(
      rows.find((r) => r.studentId === user.id)?.classId,
      current.id,
    );
    const stats = await call(
      exam +
        "/class-comparison?classIds=" +
        [home.id, other.id, promoted.id].join(","),
    );
    assert.deepEqual(
      stats.classes
        .map((c) => [c.classId, c.count, c.avgScore])
        .sort((a, b) => a[0] - b[0]),
      totals.sort((a, b) => a[0] - b[0]),
    );
    evidence.push({ current: current.name, stats: totals });
  };
  const teacher = await account("matrix_2"),
    leader = await account("flow_review_lead");
  const lead = (await call("/api/users?keyword=flow_review_lead")).users.find(
    (u) => u.username === "flow_review_lead",
  );
  const perm = "/api/admin/permissions";
  const match = (row) =>
    row.teacher_id === lead.id &&
    row.class_id === other.id &&
    row.block_id == null;
  assert.ok(!(await call(perm)).some(match));
  assert.ok(await inRoster(home));
  await check(home, [[home.id, 2, 70]]);
  await call(perm, {
    method: "PUT",
    body: {
      teacher_id: lead.id,
      class_id: other.id,
      can_view_students: 1,
      can_view_scores: 1,
    },
  });
  try {
    const move = (from, to, token) =>
      call(roster(from) + "/" + user.id + "/move", {
        method: "POST",
        body: { targetClassId: to.id },
        token,
      });
    await move(home, other, teacher);
    assert.ok(!(await inRoster(home)) && (await inRoster(other)));
    await check(other, [
      [home.id, 1, 80],
      [other.id, 1, 60],
    ]);
    await move(other, promoted, leader);
    assert.ok(!(await inRoster(other)) && (await inRoster(promoted)));
    await check(promoted, [
      [home.id, 1, 80],
      [promoted.id, 1, 60],
    ]);
    await call(roster(promoted) + "/" + user.id, { method: "DELETE" });
    assert.ok(!(await inRoster(promoted)));
    await check(promoted, [
      [home.id, 1, 80],
      [promoted.id, 1, 60],
    ]);
  } finally {
    for (const cls of [other, promoted])
      if (await inRoster(cls))
        await call(roster(cls) + "/" + user.id, { method: "DELETE" });
    if (!(await inRoster(home)))
      await call(roster(home), {
        method: "POST",
        body: { studentIds: [user.id] },
      });
    const entry = (await call(perm)).find(match);
    if (entry) await call(perm + "/" + entry.id, { method: "DELETE" });
  }
  await check(home, [[home.id, 2, 70]]);
}

async function importNamesakes() {
  const gradeName = "双机同名导入验收";
  const rows = [
    [gradeName, "甲班", "30161", "合成同名学生"],
    [gradeName, "乙班", "30162", "合成同名学生"],
    [gradeName, "乙班", "30161", "合成同名学生"],
  ];
  const csvText = [["年级", "班级", "学号", "姓名"], ...rows]
    .map((row) => row.join(","))
    .join("\n");
  const imported = await call("/api/users/import-csv", {
    method: "POST",
    body: { csvText },
  });
  assert.deepEqual(imported.students.errors, []);
  const grade = (await call("/api/classes/grades")).find(
    (row) => row.name === gradeName,
  );
  const classes = await call("/api/classes?gradeId=" + grade.id);
  for (const [name, numbers] of [
    ["甲班", ["30161"]],
    ["乙班", ["30161", "30162"]],
  ]) {
    const cls = classes.find((row) => row.name === name);
    const roster = await call("/api/classes/" + cls.id + "/students");
    assert.deepEqual(
      roster.map((row) => row.student_number),
      numbers,
    );
    assert.equal(
      new Set(roster.map((row) => row.student_id)).size,
      numbers.length,
    );
    assert.ok(roster.every((row) => row.name === "合成同名学生"));
  }
}
async function standaloneCard(title) {
  return call("/api/cards", {
    method: "POST",
    body: {
      subject: "math",
      subjectLabel: "数学",
      title,
      examDate: new Date().toISOString().slice(0, 10),
    },
    statuses: [200, 201],
  });
}
async function answerFiles() {
  const card = await standaloneCard("文件答案测试卡");
  const exam = await call("/api/exams", {
    method: "POST",
    body: {
      name: "文件答案双机验收",
      cardId: card.id,
      gradeId: state.grade.id,
      classId: state.cls.id,
      subject: "数学",
      mode: "formal",
    },
    statuses: [200, 201],
  });
  const base = "/api/exams/" + exam.id;
  const text = await call(base + "/answer-key", {
    method: "PUT",
    body: { answers: [{ questionNumber: 1, answerText: "A" }] },
  });
  assert.equal(text.saved, 1);
  const bytes = await fs.readFile(path.join(root, "答题卡原版.pdf"));
  const form = new FormData();
  form.append(
    "files",
    new Blob([bytes], { type: "application/pdf" }),
    "参考答案.pdf",
  );
  await call(base + "/answer-key/pages?ocr=0", {
    method: "POST",
    body: form,
    statuses: [200, 201],
  });
  await call(base, {
    method: "PATCH",
    body: { answerKeyMode: "file", showOriginalPaper: false },
  });
  const config = await call(base + "/answer-key");
  assert.equal(config.answerKeyMode, "file");
  assert.equal(config.answerPages.length, 1);
  const file = await call(base + "/answer-key/pages/1/image", { binary: true });
  assert.equal(hash(file.bytes), hash(bytes));
  const student = await account("flow_10008");
  await call("/api/scores/me/exams/" + exam.id + "/paper/answer-file/1", {
    token: student,
    statuses: [403, 404],
  });
  evidence.push({
    exam: exam.id,
    originalBytes: bytes.length,
    sha256: hash(bytes),
  });
}
async function ai() {
  const model = "e2e-local";
  const provider = await call("/api/ai/providers/system", {
    method: "POST",
    body: {
      name: "Ubuntu 回环测试桩",
      providerType: "openai",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local-fixture",
      models: [model],
    },
    statuses: [201],
  });
  try {
    for (const route of [
      "/api/analysis/exams/" + state.examId + "/ai-analysis",
      "/api/exam-groups/" + state.retestGroupId + "/ai-analysis",
    ]) {
      const job = await call(route, {
        method: "POST",
        body: { model, providerId: provider.id },
        statuses: [202],
      });
      let result;
      for (let attempt = 0; attempt < 35; attempt++) {
        result = await call("/api/analysis/ai-analysis/jobs/" + job.jobId);
        if (
          ["completed", "succeeded", "done", "failed", "error"].includes(
            result.status,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      evidence.push({
        job: job.jobId,
        status: result.status,
        report: result.result?.report,
        toolCalls: result.result?.toolCalls?.map((c) => c.name),
        error: result.error,
      });
      assert.ok(
        result.result?.report?.overallJudgement &&
          result.result?.report?.distributionInsight,
        "AI job " +
          job.jobId +
          " " +
          result.status +
          " " +
          (result.error || ""),
      );
      assert.ok(
        result.result.toolCalls?.some((c) => c.name === "get_exam_overview"),
        "Sidecar must execute the overview tool",
      );
    }
  } finally {
    await call("/api/ai/providers/system/" + provider.id, { method: "DELETE" });
  }
}

async function checkClassSummaries(run) {
  const listed = await call("/api/exams");
  const examples = (listed.exams || listed).filter(e => e.name === "分科人数复核数学");
  assert.equal(examples.length, 1, "Prepare the synthetic four-student mathematics exam");
  const examId = examples[0].id;
  const analysis = "/api/analysis/exams/" + examId;
  const scoreRows = async (query = "") => (await call(analysis + "/students" + query))
    .map(r => [String(r.studentNumber), r.studentName, r.totalScore]).sort();
  const sample = [
    ["20016", "合成学生16", 70], ["20017", "合成学生17", 70],
    ["20018", "合成学生18", 80], ["20019", "合成学生19", 85],
  ];
  assert.deepEqual(await scoreRows(), sample);
  const grades = await call("/api/classes/grades");
  const grade = grades.find(g => g.name === "高一双机验收");
  assert.ok(grade, "Prepare the synthetic class rosters");
  const classes = await call("/api/classes?gradeId=" + grade.id);
  for (const [name, rows] of [["1班", [sample[0], sample[3]]], ["2班", [sample[1]]]]) {
    const selected = classes.find(row => row.name === name);
    assert.ok(selected);
    assert.deepEqual(await scoreRows("?classId=" + selected.id), rows);
    const { jobId, result } = await run(examId, selected.id);
    assert.deepEqual(result.toolCalls, [{
      name: "get_class_summaries", arguments: { examId }, summary: "1 classes",
    }]);
    const observed = JSON.parse(result.report.distributionInsight);
    const avg = rows.reduce((sum, row) => sum + row[2], 0) / rows.length;
    assert.deepEqual(observed, {
      scopedClassId: selected.id, classes: [{ id: selected.id, count: rows.length, avg }],
    });
    evidence.push({ jobId, examId, classId: selected.id, calls: result.toolCalls, observed });
  }
}

async function aiScope() {
  const model = "e2e-scope-check";
  const provider = await call("/api/ai/providers", {
    method: "POST",
    body: { name: model, providerType: "openai", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "local-fixture", models: [model] },
    statuses: [201],
  });
  const run = async (examId, classId) => {
    const { jobId } = await call("/api/analysis/exams/" + examId + "/ai-analysis", {
      method: "POST", body: { classId, model, providerId: provider.id }, statuses: [202],
    });
    const deadline = Date.now() + 120000;
    let job;
    do {
      job = await call("/api/analysis/ai-analysis/jobs/" + jobId);
      if (["done", "error"].includes(job.status)) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    } while (Date.now() < deadline);
    assert.equal(job.status, "done", job.error || "Analysis job did not finish");
    assert.equal(job.examId, examId);
    assert.equal(job.classId, classId);
    assert.equal(job.result.report.overallJudgement, "Scope check completed.");
    return { ...job, jobId };
  };
  try {
    if (stage === "ai-class-summaries") {
      await checkClassSummaries(run);
      return;
    }
    const job = await run(state.examId, state.cls.id);
    const calls = job.result.toolCalls;
    assert.equal(calls.length, 3);
    assert.ok(calls.every(item => item.name === "get_exam_overview"));
    assert.deepEqual(calls.slice(0, 2).map(item => item.summary), [
      "tool examId must match the selected exam", "tool classId must match the selected class",
    ]);
    assert.match(calls[2].summary, /^summary count=[1-9]\d*$/);
    evidence.push({ jobId: job.jobId, examId: job.examId, classId: job.classId, status: job.status, calls });
  } finally {
    await call("/api/ai/providers/" + provider.id, { method: "DELETE" });
  }
}

async function seedRank() {
  const exams = [];
  for (const subject of ["化学", "数学"]) {
    const card = await standaloneCard("排名测试卡" + subject);
    const exam = await call("/api/exams", {
      method: "POST",
      body: {
        name: "双机排名验收" + subject,
        cardId: card.id,
        gradeId: state.grade.id,
        classId: state.cls.id,
        subject,
        mode: "formal",
      },
      statuses: [201, 200],
    });
    exams.push(exam.id);
  }
  const group = await call("/api/exam-groups", {
    method: "POST",
    body: {
      name: "双机分科赋分验收",
      grade_id: state.grade.id,
      examIds: exams,
      total_score_mode: "assigned",
    },
    statuses: [201, 200],
  });
  const students = state.students.slice(0, 2).map((s) => s.id);
  await fs.writeFile(
    path.join(root, "rank-seed.json"),
    JSON.stringify({ exams, students, group: group.id }),
  );
}
async function rank() {
  const {
    group,
    students: [a, b],
  } = JSON.parse(await fs.readFile(path.join(root, "rank-seed.json")));
  for (const mode of ["raw", "assigned"]) {
    await call("/api/exam-groups/" + group, {
      method: "PUT",
      body: { total_score_mode: mode },
    });
    for (const fullOnly of [0, 1]) {
      const { rows } = await call(
        "/api/exam-groups/" + group + "/rankings?fullOnly=" + fullOnly,
      );
      const result = rows.map((r) => [
        r.studentId,
        mode === "assigned" ? r.totalAssignedScore : r.totalRawScore,
        r.totalGradeRank,
      ]);
      const expected =
        mode === "assigned"
          ? [
              [b, 165, 1],
              [a, 155, 2],
            ]
          : [
              [a, 150, 1],
              [b, 149, 2],
            ];
      assert.deepEqual(result, expected);
      evidence.push({ mode, fullOnly, result });
    }
  }
}
async function demo() {
  const route = "/api/db/import-demo";
  const blocked = await call(route, {
    method: "POST",
    body: {},
    statuses: [409],
  });
  assert.equal(blocked.code, "DEMO_IMPORT_REQUIRES_CONFIRMATION");
  const seeded = await call(route, {
    method: "POST",
    body: { confirm: "IMPORT_DEMO_INTO_PRODUCTION" },
  });
  assert.ok(seeded.stats.exams > 0);
  const business = await call("/api/exams/" + state.examId);
  assert.equal(business.name, state.cardTitle);
  await call("/api/db/clear-demo", { method: "POST", body: {} });
  assert.equal((await call("/api/exams/" + state.examId)).name, business.name);
  evidence.push({ demoExams: seeded.stats.exams, preservedExam: business.id });
}

async function scopes() {
  const grades = await call("/api/classes/grades");
  const grade = grades.find((g) => g.name === "高一双机验收");
  const classes = await call("/api/classes?gradeId=" + grade.id);
  const source = classes.find((c) => c.name === "1班"),
    target = classes.find((c) => c.name === "2班");
  const roster = "/api/classes/" + source.id + "/students";
  const isTestStudent = (row) => row.student_number === "20004";
  let student = (await call(roster)).find(isTestStudent);
  if (!student) {
    const previousTarget = "/api/classes/" + target.id + "/students";
    student = (await call(previousTarget)).find(isTestStudent);
    assert.ok(student, "Missing class transfer fixture 20004");
    await call(previousTarget + "/" + student.student_id + "/move", {
      method: "POST",
      body: { targetClassId: source.id },
    });
  }
  const ids = {};
  for (const [name, role] of [
    ["年级主任", "grade_leader"],
    ["班主任", "head_teacher"],
    ["学科教师", "subject_teacher"],
    ["限定教师", "subject_teacher"],
  ]) {
    const username =
      "matrix_" +
      (["年级主任", "班主任", "学科教师", "限定教师"].indexOf(name) + 1);
    const all = await call("/api/users");
    const rows = Array.isArray(all) ? all : all.users || all.data || [];
    const user =
      rows.find((u) => u.username === username) ||
      (await call("/api/users", {
        method: "POST",
        body: {
          username,
          name,
          password: state.password,
          role: "teacher",
          teacher_role: role,
        },
        statuses: [200, 201],
      }));
    ids[name] = user.id;
    const subject = {
      年级主任: "物理",
      班主任: "化学",
      学科教师: "数学",
      限定教师: "英语",
    }[name];
    await call("/api/teachers/" + user.id, {
      method: "PUT",
      body: { subject, teacher_role: role },
    });
    for (const c of [source, target]) {
      const list = await call("/api/classes/" + c.id + "/teachers");
      if (
        !list.assignments.some(
          (t) => t.teacherId === user.id && t.subject === subject,
        )
      )
        await call("/api/classes/" + c.id + "/teachers", {
          method: "POST",
          body: { teacherId: user.id, subject },
          statuses: [200, 201],
        });
    }
  }
  await call("/api/classes/" + source.id + "/head-teacher", {
    method: "PUT",
    body: { teacherId: ids["班主任"] },
  });
  const [leader, head, subject] = await Promise.all(
    ["matrix_1", "matrix_2", "matrix_3"].map(account),
  );
  const perm = (teacher, view, classId = source.id) =>
    call("/api/admin/permissions", {
      method: "PUT",
      body: {
        teacher_id: teacher,
        class_id: classId,
        can_view_scores: 1,
        can_view_charts: 1,
        can_view_students: view,
        can_grade: 1,
        can_assign: 0,
      },
    });
  const move = (token, status) =>
    call(roster + "/" + student.student_id + "/move", {
      token,
      method: "POST",
      body: { targetClassId: target.id },
      statuses: [status],
    });
  await perm(ids["学科教师"], 0);
  await call(roster, { token: subject, statuses: [403] });
  await move(subject, 403);
  await perm(ids["年级主任"], 0);
  await move(leader, 403);
  await perm(ids["班主任"], 0);
  await move(head, 403);
  await perm(ids["班主任"], 1);
  await perm(ids["班主任"], 1, target.id);
  await move(head, 200);
  assert.ok(
    !(await call(roster)).some((s) => s.student_id === student.student_id),
  );
  assert.ok(
    (await call("/api/classes/" + target.id + "/students")).some(
      (s) => s.student_id === student.student_id,
    ),
  );
  evidence.push({
    sourceClass: source.id,
    targetClass: target.id,
    studentNumber: student.student_number,
  });
}

async function cardMatrix() {
  const objective = (id, start, count, overrides = {}) => ({
    id,
    type: "objective",
    title: "选择题",
    questionStart: start,
    questionCount: count,
    optionCount: 4,
    mode: "single",
    scorePerQuestion: 3,
    density: "compact",
    ...overrides,
  });
  const question = (id, number, score, extra = {}) => ({
    id,
    number,
    score,
    kind: "lined_answer",
    style: "manual_score_grid",
    minHeightMm: 20,
    ...extra,
  });
  const subjective = (id, blockKind, questions) => ({
    id,
    type: "subjective",
    title: { answer: "解答题", fill_blank: "填空题", essay: "作文" }[blockKind],
    blockKind,
    questions,
  });
  const choices = Array.from({ length: 7 }, (_, i) => ({
    questionNumber: i + 1,
    mode: i < 4 ? "single" : i < 6 ? "multiple" : "indefinite",
    optionCount: 4,
    score: i < 4 ? 3 : 5,
    answerKey: i < 4 ? ["A"] : ["A", "C"],
    ...(i < 4
      ? {}
      : {
          scoringRule: {
            type: "per_selected_count",
            partialScores: { 1: 2 },
            wrongOrExtraScore: 0,
          },
        }),
  }));
  const essayGrid = {
    columns: 0,
    rows: 0,
    cellWidthMm: 5.5,
    cellHeightMm: 5.5,
    targetChars: 800,
    showTitle: true,
    lineColor: "#bd1717",
    lineWidthMm: 0.15,
    showWordScale: true,
  };
  const configs = {
    A: [
      objective("a-1", 1, 7, { questions: choices }),
      subjective("a-2", "fill_blank", [
        question("a8", 8, 4, {
          kind: "blank",
          annotation: "请逐空作答",
          blanks: {
            count: 2,
            widthMm: 24,
            heightMm: 7,
            items: [
              { widthMm: 24, heightMm: 7 },
              { widthMm: 32, heightMm: 7, rightAnnotation: "单位" },
            ],
          },
        }),
        question("a9", 9, 2, {
          kind: "blank",
          blanks: { count: 1, widthMm: 32, heightMm: 7 },
        }),
      ]),
      subjective("a-3", "answer", [
        question("a10", 10, 12),
        question("a11", 11.1, 20),
      ]),
      objective("a-4", 12, 2),
    ],
    B: [
      objective("b-1", 1, 8),
      subjective("b-2", "answer", [
        question("b9", 9, 20, {
          style: "plain_subjective",
          minHeightMm: 95,
          scoreGrid: { enabled: false },
        }),
      ]),
      subjective("b-3", "essay", [
        question("b10", 10, 60, {
          kind: "plain_box",
          style: "plain_subjective",
          minHeightMm: 70,
          essayGrid,
          scoreGrid: { enabled: false },
        }),
      ]),
    ],
    C: [
      objective("c-1", 1, 54, {
        optionCount: 6,
        optionLayout: "vertical-options",
      }),
      subjective("c-2", "answer", [question("c55", 55, 20)]),
    ],
    D: [
      subjective("d-1", "answer", [
        question("d0", 1, 0),
        question("d2", 2, 10),
      ]),
    ],
  };
  const records = {};
  for (const [key, blocks] of Object.entries(configs)) {
    const seed = await standaloneCard("双机卡型 " + key);
    for (const block of blocks) {
      block.id = seed.id + "-" + block.id;
      if (block.type === "subjective")
        for (const q of block.questions) q.id = seed.id + "-" + q.id;
    }
    seed.bodyBlocks = blocks;
    seed.paper = {
      size: key === "C" ? "A3" : "A4",
      orientation: key === "C" ? "landscape" : "portrait",
    };
    seed.sided = ["B", "C"].includes(key) ? "double" : "single";
    const route = "/api/cards/" + seed.id;
    const saved = await call(route, { method: "PUT", body: seed });
    const fresh = await call(route),
      layout = await call(route + "/layout");
    assert.deepEqual(
      fresh.bodyBlocks.map((b) => b.id),
      blocks.map((b) => b.id),
      "interleaved block order",
    );
    if (key === "A") {
      assert.equal(Number(fresh.bodyBlocks[2].questions[1].number), 11.1);
      assert.equal(layout.pages.length, 1);
    }
    if (key === "B")
      assert.equal(
        layout.pages.length,
        2,
        "essay must fit back of duplex sheet",
      );
    if (key === "C") {
      assert.equal(layout.pages[0].panels.length, 3);
      assert.equal(fresh.bodyBlocks[0].optionLayout, "vertical-options");
    }
    if (key === "D") {
      assert.ok(
        !layout.elements.some(
          (e) => e.type === "score_cell" && e.questionId === seed.id + "-d0",
        ),
      );
      fresh.bodyBlocks[0].questions[0].score = 3;
      await call(route, { method: "PUT", body: fresh });
      const changed = await call(route + "/layout");
      assert.ok(
        changed.elements.some(
          (e) => e.type === "score_cell" && e.questionId === seed.id + "-d0",
        ),
      );
    }
    const current = await call(route);
    const pdf = await call(route + "/pdf?v=" + current.revision, {
      binary: true,
    });
    assert.equal(pdf.headers.get("x-card-revision"), String(current.revision));
    await fs.writeFile(
      path.join(root, "evidence", "卡型" + key + ".pdf"),
      pdf.bytes,
    );
    records[key] = {
      id: seed.id,
      revision: current.revision,
      pages: layout.pages.length,
      panels: layout.pages.map((p) => p.panels.length),
      pdfSha256: hash(pdf.bytes),
    };
    await fs.writeFile(
      path.join(root, "card-matrix.json"),
      JSON.stringify(records, null, 2),
    );
    evidence.push({ key, ...records[key] });
  }
}
async function originalPapers() {
  const cards = {
    A: await standaloneCard("双页图片原卷"),
    B: await standaloneCard("文字原卷"),
    D: await standaloneCard("文件类型验收"),
  };
  const pic = await fs.readFile(
    path.join(root, "evidence", "首次登录强制改密.png"),
  );
  const doc = await fs.readFile(path.join(root, "原卷练习.docx"));
  const upload = (id, files, statuses = [200]) => {
    const form = new FormData();
    for (const [name, mime, bytes] of files)
      form.append("files", new Blob([bytes], { type: mime }), name);
    return call("/api/cards/" + id + "/paper", {
      method: "POST",
      body: form,
      statuses,
    });
  };
  const png = ["原卷.png", "image/png", pic];
  const image = await upload(cards.A.id, [
    png,
    ["原卷第二页.png", "image/png", pic],
  ]);
  assert.equal(image.count, 2);
  const info = await call("/api/cards/" + cards.A.id + "/paper/info");
  assert.equal(info.pages.length, 2);
  assert.equal(
    (
      await upload(cards.B.id, [
        [
          "试卷.docx",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          doc,
        ],
      ])
    ).count,
    1,
  );
  const bad = await upload(cards.B.id, [png], [400, 409]);
  assert.equal(bad.code, "MIXED_PAPER_FORMATS");
  evidence.push({ mixed: bad.code });
  assert.ok(
    (await call("/api/cards/" + cards.B.id + "/paper/info")).pages.length === 1,
  );
  const invalid = await upload(
    cards.D.id,
    [
      [
        "旧式文档.doc",
        "application/msword",
        Buffer.from("unsupported file format"),
      ],
    ],
    [400],
  );
  assert.ok(invalid.error || invalid.message);
  const ordinaryText = [
    "假图片.jpg",
    "image/jpeg",
    Buffer.from("This fixture is plain text."),
  ];
  await upload(cards.D.id, [ordinaryText], [400, 415, 422]);
  assert.equal(
    (await call("/api/cards/" + cards.D.id + "/paper/info")).pages.length,
    0,
  );
  const paper = "/api/cards/" + cards.A.id + "/paper";
  for (const page of [1, 2]) {
    const preview = await call(paper + "?format=image&page=" + page, {
      binary: true,
    });
    assert.match(preview.headers.get("content-type"), /^image\//);
    const pdf = await call(paper + "?page=" + page, { binary: true });
    assert.equal(pdf.bytes.subarray(0, 5).toString(), "%PDF-");
  }
  await call(paper + "/page/2", { method: "DELETE" });
  assert.equal((await call(paper + "/info")).pages.length, 1);
  await call(paper + "?page=2", { statuses: [404] });
  await call(paper, { method: "DELETE" });
  assert.equal((await call(paper + "/info")).pages.length, 0);
  await call(paper, { statuses: [404] });
}

async function studentPapers() {
  const student = await account("flow_10008");
  const exam = "/api/exams/" + state.examId;
  const route = "/api/scores/me/exams/" + state.examId + "/paper";
  const config = await call(exam + "/answer-key");
  const initial = await call(exam);
  const bytes = await fs.readFile(path.join(root, "答题卡原版.pdf"));
  const form = new FormData();
  form.append(
    "files",
    new Blob([bytes], { type: "application/pdf" }),
    "双机直发答案.pdf",
  );
  await call(exam + "/answer-key/pages?ocr=0", {
    method: "POST",
    body: form,
    statuses: [200, 201],
  });
  const change = (mode, visible) =>
    call(exam, {
      method: "PATCH",
      body: { answerKeyMode: mode, showOriginalPaper: visible },
    });
  try {
    await change("file", false);
    const file = await call(route, { token: student });
    assert.equal(file.answerKeyMode, "file");
    assert.deepEqual(file.pages, []);
    assert.deepEqual(file.answers, []);
    assert.ok(file.answerFiles.length > 0);
    const url = file.answerFiles.at(-1).fileUrl;
    const ticket = await call("/api/auth/media-ticket", {
      method: "POST",
      body: { path: url },
      token: student,
    });
    const response = await fetch(
      state.server + url + "?mt=" + encodeURIComponent(ticket.ticket),
    );
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(bytes));
    await change("text", true);
    const paper = await call(route, { token: student });
    assert.equal(paper.answerKeyMode, "text");
    assert.deepEqual(paper.answerFiles, []);
    await change("text", false);
    await call(route, { token: student, statuses: [404] });
    evidence.push({
      digest: hash(bytes),
      mediaTicketStatus: response.status,
      textAnswers: paper.answers.length,
      studentCrops: paper.answerBlocks.length,
    });
  } finally {
    await change(
      config.answerKeyMode,
      Boolean(initial.show_original_paper ?? initial.showOriginalPaper),
    );
  }
}
async function governance() {
  const diagnostic = await call("/api/wechat/subscriptions/diagnostic");
  assert.equal(diagnostic.configured, false);
  assert.ok(diagnostic.missing.length);
  evidence.push({ missing: diagnostic.missing });
  const teacher = await account("flow_teacher");
  await call("/api/wechat/subscriptions/diagnostic", {
    token: teacher,
    statuses: [403],
  });
  for (const name of ["flow_teacher", "matrix_2", "matrix_3"]) {
    const dashboard = await call("/api/dashboard", {
      token: await account(name),
    });
    assert.ok(dashboard.ok && dashboard.data);
    evidence.push({ dashboard: name, sections: Object.keys(dashboard.data) });
  }
  const audit = await call(
    "/api/weekly-audit/summary?gradeId=" + state.grade.id,
    { token: teacher },
  );
  assert.ok(Array.isArray(audit.weeks) && Array.isArray(audit.grades));
  const groups = await call("/api/exam-groups");
  const list = Array.isArray(groups) ? groups : groups.groups || groups.data;
  assert.ok(Array.isArray(list));
  assert.ok(list.every((g) => g.source !== "week"));
  evidence.push({
    weeks: audit.weeks.length,
    grades: audit.grades.length,
    manualGroups: list.length,
  });
}

async function analysisReports() {
  const route = "/api/analysis/exams/" + state.examId;
  const teacher = await account("flow_teacher");
  for (const item of [
    "overview",
    "questions",
    "classes",
    "distribution",
    "question-students?questionNumber=1",
    "borderline-students",
    "class-knowledge",
  ]) {
    const value = await call(route + "/" + item, { token: teacher });
    assert.ok(value && typeof value === "object");
    evidence.push({ item, fields: Object.keys(value) });
  }
  const { sourceClass } = JSON.parse(
    await fs.readFile(path.join(root, "evidence", "service-scopes.json")),
  ).at(-1);
  await call(route + "/class-comparison?all=1", {
    token: teacher,
    statuses: [400],
  });
  await call(
    route +
      "/class-comparison?classIds=" +
      [state.cls.id, sourceClass].join(","),
  );
  const wrong = await call(route + "/export-wrong", {
    token: teacher,
    binary: true,
  });
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(wrong.bytes, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]],
    { header: 1 },
  );
  assert.deepEqual(rows[0], [
    "班级",
    "考号",
    "姓名",
    "总分",
    "题号",
    "满分",
    "得分",
    "得分率%",
  ]);
  assert.ok(rows.length > 1);
  await fs.writeFile(path.join(root, "evidence", "逐题错题.xlsx"), wrong.bytes);
  const seed = JSON.parse(await fs.readFile(path.join(root, "rank-seed.json")));
  const group = "/api/exam-groups/" + seed.group;
  for (const track of ["all", "arts", "science"]) {
    for (const fullOnly of [0, 1]) {
      for (const view of [
        "overview",
        "metrics",
        "question-analysis",
        "distribution",
        "class-comparison",
        "rankings",
      ]) {
        const data = await call(
          group + "/" + view + "?track=" + track + "&fullOnly=" + fullOnly,
        );
        assert.ok(data && typeof data === "object");
      }
    }
  }
  const zip = await call(group + "/export", {
    method: "POST",
    body: { subjectExamIds: seed.exams },
    binary: true,
  });
  assert.equal(zip.bytes.readUInt32LE(0), 0x04034b50);
  await fs.writeFile(
    path.join(root, "evidence", "联考多科成绩.zip"),
    zip.bytes,
  );
  evidence.push({
    wrongRows: rows.length - 1,
    groupArchiveBytes: zip.bytes.length,
  });
}
async function backupFormats() {
  const student = await account("flow_10008");
  const score = async () =>
    (await call("/api/scores/me", { token: student })).scores.find(
      (s) => s.exam_id === state.examId,
    )?.total_score;
  const baseline = await score();
  assert.ok(Number.isFinite(baseline), "Prepare the published test score before verifying backup rejection");
  for (const [name, data] of [
    ["SQLite ZIP", await fs.readFile(path.join(root, "SQLite测试备份.zip"))],
    ["损坏 ZIP", Buffer.from("not a zip")],
  ]) {
    const r = await fetch(state.server + "/api/db/restore", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + state.adminToken,
        "Content-Type": "application/zip",
      },
      body: data,
    });
    const message = (await r.json()).message;
    assert.equal(r.status, 400, message);
    assert.equal(await score(), baseline);
    evidence.push({ name, status: r.status, message, score: baseline });
  }
}

async function studentAnalysis() {
  const student = await account("flow_10008");
  const overall = await call("/api/scores/me/ai-analysis", {
    token: student,
    method: "POST",
    body: {},
  });
  assert.equal(overall.model, "server-side-v1");
  assert.ok(overall.report.overallJudgement);
  const one = await call(
    "/api/scores/me/exams/" + state.examId + "/ai-analysis",
    { token: student, method: "POST", body: { model: "gpt-5.5" } },
  );
  assert.ok(one.report.overallJudgement);
  const usage = await call("/api/admin/console/ai-usage");
  evidence.push({
    overallModel: overall.model,
    examModel: one.model,
    examTools: one.toolCalls?.map((t) => t.name),
    usageSections: Object.keys(usage),
  });
}
async function ladderGate() {
  const student = await account("flow_10008");
  const route = "/api/ladder/exams/" + state.examId;
  const original = await call("/api/ladder/config");
  try {
    await call("/api/ladder/config", {
      method: "PUT",
      body: { enabled: true },
    });
    const studentView = await call(route, { token: student });
    assert.ok(studentView && typeof studentView === "object");
    await call("/api/ladder/config", {
      method: "PUT",
      body: { enabled: false },
    });
    await call(route, { token: student, statuses: [403] });
    await call(route);
    evidence.push({
      exam: state.examId,
      studentEnabledFields: Object.keys(studentView),
    });
  } finally {
    await call("/api/ladder/config", {
      method: "PUT",
      body: { enabled: original.enabled },
    });
  }
}

async function matrixSpec(key) {
  return JSON.parse(await fs.readFile(path.join(root, "matrix-exams.json")))[
    key
  ];
}
async function rosterDecisions() {
  const spec = await matrixSpec("B");
  const route = "/api/exams/" + spec.exam + "/scanner-pending";
  const initial = (await call(route)).items.filter(
    (x) => x.reason === "roster",
  );
  assert.equal(initial.length, 2);
  const before = await call("/api/analysis/exams/" + spec.exam + "/overview");
  const ordered = initial.sort((a, b) =>
    a.studentNumber.localeCompare(b.studentNumber),
  );
  for (const [i, row] of ordered.entries()) {
    const action = i === 0 ? "accept" : "discard";
    await call(route, {
      method: "POST",
      body: {
        sessionId: row.sessionId,
        groupId: row.groupId,
        token: row.token,
        action,
      },
    });
    evidence.push({ action, student: row.studentNumber });
  }
  assert.equal(
    (await call(route)).items.filter((x) => x.reason === "roster").length,
    0,
  );
  const after = await call("/api/analysis/exams/" + spec.exam + "/overview");
  assert.equal(after.gradedCount, before.gradedCount + 1);
  const scores = await call("/api/analysis/exams/" + spec.exam + "/students");
  assert.ok(
    scores.some((x) => String(x.studentNumber) === ordered[0].studentNumber),
  );
  assert.ok(
    !scores.some((x) => String(x.studentNumber) === ordered[1].studentNumber),
  );
  evidence.push({ before: before.gradedCount, after: after.gradedCount });
}
async function reviewFlow() {
  const spec = await matrixSpec("B");
  const raw = await call("/api/users");
  const users = Array.isArray(raw) ? raw : raw.users;
  const make = async (username, name, role) => {
    const user =
      users.find((u) => u.username === username) ||
      (await call("/api/users", {
        method: "POST",
        statuses: [200, 201],
        body: {
          username,
          name,
          role: "teacher",
          teacher_role: role,
          password: state.password,
        },
      }));
    const id = user.id;
    const subject = (await call("/api/exams/" + spec.exam)).subject;
    await call("/api/teachers/" + id, {
      method: "PUT",
      body: { teacher_role: role, subject },
    });
    const assignments = (
      await call("/api/classes/" + state.cls.id + "/teachers")
    ).assignments;
    if (!assignments.some((x) => x.teacherId === id && x.subject === subject))
      await call("/api/classes/" + state.cls.id + "/teachers", {
        method: "POST",
        statuses: [200, 201],
        body: { teacherId: id, subject },
      });
    await call("/api/admin/permissions", {
      method: "PUT",
      body: {
        teacher_id: id,
        class_id: state.cls.id,
        can_view_students: 1,
        can_view_scores: 1,
        can_grade: 1,
        can_view_charts: 1,
        can_assign: 1,
      },
    });
    return { id, token: await account(username) };
  };
  const teachers = [];
  for (const [i, label] of ["甲", "乙", "丙", "丁"].entries())
    teachers.push(
      await make(
        "flow_review_" + (i + 1),
        "验收阅卷" + label,
        "subject_teacher",
      ),
    );
  const leader = await make("flow_review_lead", "验收阅卷主任", "grade_leader");
  const [a, b, c, d] = teachers;
  const cfg = (block) =>
    "/api/block-grading-config/exams/" + spec.exam + "/blocks/" + block;
  const pool = (block) =>
    "/api/review-pool/exams/" + spec.exam + "/blocks/" + block;
  const assign = (block) =>
    "/api/review-assign/exams/" + spec.exam + "/blocks/" + block;
  const post = (url, token, body = {}, statuses = [200]) =>
    call(url, { method: "POST", token, body, statuses });
  const set = (url, token, body, statuses = [200]) =>
    call(url, { method: "PUT", token, body, statuses });
  const ab = spec.card + "-b-2",
    eb = spec.card + "-b-3";
  for (const [block, config, counts] of [
    [
      ab,
      {
        reviewMode: 2,
        scoringMode: "per_question",
        disputeThreshold: 2,
        arbitratorId: leader.id,
        rounding: "half",
      },
      [5, 5],
    ],
    [
      eb,
      {
        reviewMode: 3,
        scoringMode: "block_total",
        disputeThreshold: 2,
        hasHalfPoint: true,
        rounding: "half",
        autoReassignNoArb: true,
      },
      [4, 3, 3],
    ],
  ]) {
    const saved = await set(cfg(block), state.adminToken, config);
    assert.equal(saved.data.reviewMode, config.reviewMode);
    await post(
      assign(block),
      leader.token,
      {
        teacherCounts: Object.fromEntries(
          counts.map((n, i) => [teachers[i].id, n]),
        ),
      },
      [200, 201],
    );
    await set(cfg(block), a.token, { reviewMode: 1 }, [403]);
    await set(cfg(block), a.token, { hasHalfPoint: true });
    await set(cfg(block), d.token, { hasHalfPoint: false }, [403]);
  }
  const session = "/api/review-session/exams/" + spec.exam + "/blocks/" + ab;
  await set(session, a.token, {
    currentIndex: 2,
    positionJson: { zoom: 1.5 },
    draftScores: { 9: 8 },
  });
  const draft = (await call(session, { token: a.token })).data;
  assert.equal(draft.currentIndex, 2);
  assert.deepEqual(draft.draftScores, { 9: 8 });
  const pick = async (block, t) => {
    const rows = (await call(pool(block), { token: t.token })).data.entries;
    const fresh =
      rows.find(
        (x) =>
          !x.claimedBy &&
          !x.reviewRound &&
          [
            "unreviewed",
            "unclaimed",
            "pending",
            "in_pool",
            "unassigned",
            "ready",
            "new",
            "uploaded",
            "todo",
          ].includes(x.status),
      ) || rows.find((x) => !x.claimedBy && !x.reviewRound);
    assert.ok(
      fresh,
      JSON.stringify(
        rows.slice(0, 1).map((x) => ({
          status: x.status,
          round: x.reviewRound,
          claimed: x.claimedBy,
        })),
      ),
    );
    return fresh;
  };
  const claim = (block, t, crop) =>
    post(pool(block) + "/crops/" + crop.id + "/claim", t.token);
  const release = (block, t, crop, force = false) =>
    post(pool(block) + "/crops/" + crop.id + "/release", t.token, { force });
  const submit = (crop, t, score, extra = {}, statuses = [200]) =>
    post(
      "/api/review/exams/" + spec.exam + "/block-crops/" + crop.id + "/submit",
      t.token,
      {
        scores: crop.questionNumbers.map((q) => ({
          questionNumber: Number(q),
          scoreType: "subjective",
          score,
        })),
        ...extra,
      },
      statuses,
    );
  const slices = await Promise.all(
    [a, b].map((t) => call(assign(ab), { token: t.token })),
  );
  const claims = await Promise.all(
    [a, b].map((t) => post(pool(ab) + "/claim", t.token)),
  );
  const [p, q] = claims.map((x) => x.data);
  assert.notEqual(p.id, q.id);
  assert.equal(p.claimedBy, a.id);
  assert.equal(q.claimedBy, b.id);
  for (const [i, { data: entry }] of claims.entries()) {
    const assignment = slices[i].data.find(
      (x) => x.teacherId === teachers[i].id,
    );
    assert.ok(assignment.assignedStudentIds.includes(entry.studentId));
  }
  await release(ab, leader, q, true);
  await submit(p, a, 8, { blockTotalScore: 8 }, [422]);
  assert.equal((await submit(p, a, 8)).status, "pending");
  await claim(ab, b, p);
  const avg = await submit(p, b, 10);
  assert.equal(avg.status, "reviewed");
  assert.equal(avg.finalScore, 9 * p.questionNumbers.length);
  evidence.push({
    case: "two reviewers",
    questionNumbers: p.questionNumbers,
    finalScore: avg.finalScore,
  });
  const dispute = await pick(ab, a);
  await claim(ab, a, dispute);
  await submit(dispute, a, 6);
  await claim(ab, b, dispute);
  assert.equal((await submit(dispute, b, 10)).status, "disputed");
  const resolve = "/api/review-arbitration/crops/" + dispute.id + "/resolve";
  if (dispute.questionNumbers.length > 1)
    await post(resolve, leader.token, { score: 7 }, [422]);
  const resolution = await post(resolve, leader.token, {
    questionScores: Object.fromEntries(
      dispute.questionNumbers.map((q) => [q, 7]),
    ),
  });
  assert.equal(resolution.finalScore, 7 * dispute.questionNumbers.length);
  evidence.push({
    case: "arbitration",
    questions: dispute.questionNumbers,
    accepted: resolution.ok === true,
  });
  for (const [votes, expected] of [
    [[42, 43, 55], 42.5],
    [[20, 35, 50], null],
  ]) {
    const crop = await pick(eb, a);
    let result;
    for (const [i, v] of votes.entries()) {
      await claim(eb, teachers[i], crop);
      if (i === 0) await submit(crop, a, 0, {}, [422]);
      result = await submit(crop, teachers[i], 0, { blockTotalScore: v });
    }
    assert.equal(result.finalScore, expected);
    assert.equal(result.disputed, expected == null);
    evidence.push({
      case: "three reviewers",
      votes,
      result: result.finalScore,
      status: result.status,
      crop: crop.id,
    });
    if (expected === null) {
      await claim(eb, a, crop);
      const revised = await submit(crop, a, 0, { blockTotalScore: 35 });
      assert.equal(revised.finalScore, 35);
      assert.equal(revised.reviewRound, 4);
      evidence.push({
        case: "same reviewer replaces vote",
        result: revised.finalScore,
        round: revised.reviewRound,
      });
    }
  }
}

async function retentionSetup() {
  const all = (await call("/api/admin/data-retention-policies")).data;
  const info = path.join(root, "retention-test.json");
  let settings;
  try {
    settings = JSON.parse(await fs.readFile(info));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!settings) {
    const policies = all.filter((x) =>
      process.env.PROJECTX_FLOW_RETENTION_POLICY
        ? x.name === process.env.PROJECTX_FLOW_RETENTION_POLICY
        : x.name.startsWith("E2E_RETENTION_"),
    );
    assert.equal(
      policies.length,
      1,
      "Select a dedicated E2E retention policy using PROJECTX_FLOW_RETENTION_POLICY",
    );
    const [policy] = policies;
    const fixtures = JSON.parse(
      await fs.readFile(path.join(root, "card-matrix.json")),
    );
    const create = async (name) =>
      call("/api/exams", {
        method: "POST",
        statuses: [200, 201],
        body: {
          name,
          cardId: fixtures.D.id,
          gradeId: state.grade.id,
          classId: state.cls.id,
          subject: "数学",
          mode: "formal",
        },
      });
    const closed = await create("双机保留策略专用卷"),
      active = await create("双机清理保护专用卷");
    settings = { closed: closed.id, active: active.id, policy };
    await fs.writeFile(info, JSON.stringify(settings));
  }
  const p = settings.policy;
  await call("/api/admin/data-retention-policies/" + p.id, {
    method: "PUT",
    body: { retainDays: 1, autoDelete: 1, autoArchive: 1 },
  });
  await call("/api/exams/" + settings.closed, {
    method: "PATCH",
    body: { retentionPolicyId: p.id },
  });
}
async function retentionRestore() {
  const { closed, active, policy } = JSON.parse(
    await fs.readFile(path.join(root, "retention-test.json")),
  );
  try {
    const removed = (await call("/api/admin/console/soft-deleted-exams")).exams;
    assert.ok(
      removed.some((x) => Number(x.examId ?? x.id ?? x.exam_id) === closed),
    );
    const t = await account("flow_teacher");
    await call("/api/exams/" + closed, { token: t, statuses: [404] });
    await call("/api/exams/" + active);
    await call("/api/admin/console/exams/" + closed + "/restore", {
      method: "POST",
    });
    const restored = await call("/api/exams/" + closed);
    assert.equal(restored.retention_policy_id, null);
    const grade = await call("/api/analysis/exams/" + closed + "/students");
    assert.equal(
      grade.find((x) => String(x.studentNumber) === "10008").totalScore,
      37,
    );
    await call("/api/admin/console/exams/" + closed + "/restore", {
      method: "POST",
      statuses: [404],
    });
    evidence.push({ closed, active, restoredScore: 37 });
  } finally {
    await call("/api/admin/data-retention-policies/" + policy.id, {
      method: "PUT",
      body: policy,
    });
  }
}

async function reviewRepeat() {
  const orig = JSON.parse(
    await fs.readFile(path.join(root, "evidence", "service-review-flow.json")),
  );
  const last = orig.findLast(
    (x) => x.case === "three reviewers" && x.status === "disputed",
  );
  assert.ok(last);
  const s = await matrixSpec("B"),
    crop = last.crop,
    block = s.card + "-b-3";
  const base =
    "/api/review-pool/exams/" +
    s.exam +
    "/blocks/" +
    block +
    "/crops/" +
    crop +
    "/claim";
  const first = await account("flow_review_1"),
    second = await account("flow_review_2");
  await call(base, {
    method: "POST",
    body: {},
    token: second,
    statuses: [409],
  });
  const entry = (await call(base, { method: "POST", body: {}, token: first }))
    .data;
  const result = await call(
    "/api/review/exams/" + s.exam + "/block-crops/" + crop + "/submit",
    {
      method: "POST",
      token: first,
      body: {
        blockTotalScore: 35,
        scores: entry.questionNumbers.map((q) => ({
          questionNumber: Number(q),
          scoreType: "subjective",
          score: 0,
        })),
      },
    },
  );
  assert.equal(result.finalScore, 35);
  assert.equal(result.reviewRound, 4);
  assert.equal(result.status, "reviewed");
  evidence.push({
    firstThree: last.votes,
    fourth: 35,
    result: result.finalScore,
    round: result.reviewRound,
  });
}
async function loginRate() {
  const identifier = "flow_rate_" + Date.now();
  const codes = [];
  for (let i = 0; i < 11; i++) {
    const r = await fetch(state.server + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password: state.password }),
    });
    await r.arrayBuffer();
    codes.push(r.status);
  }
  assert.deepEqual(codes, [...Array(10).fill(401), 429]);
  evidence.push({ codes });
}
async function ticketExpiry() {
  const student = await account("flow_10008");
  const paper = await call("/api/scores/me/exams/" + state.examId + "/paper", {
    token: student,
  });
  const media =
    paper.answerFiles?.[0]?.fileUrl ||
    paper.answerBlocks?.[0]?.imageUrl ||
    paper.pages?.[0]?.imageUrl;
  assert.ok(media, JSON.stringify(Object.keys(paper)));
  const issued = await call("/api/auth/media-ticket", {
    method: "POST",
    token: student,
    body: { path: media },
  });
  const source =
    state.server + media + "?mt=" + encodeURIComponent(issued.ticket);
  const get = async () => {
    const res = await fetch(source);
    await res.arrayBuffer();
    return res.status;
  };
  assert.equal(await get(), 200);
  await new Promise((resolve) =>
    setTimeout(resolve, issued.ttlSeconds * 1000 + 1000),
  );
  const expired = await get();
  assert.ok([401, 403].includes(expired));
  evidence.push({ ttlSeconds: issued.ttlSeconds, expired });
}

async function multiArbitration(beforeResolve) {
  const s = await matrixSpec("B"),
    block = s.card + "-b-1",
    suffix = "/exams/" + s.exam + "/blocks/" + block;
  const all = await call("/api/users"),
    users = Array.isArray(all) ? all : all.users;
  const reviewers = await Promise.all(
    ["flow_review_1", "flow_review_2", "flow_review_lead"].map(async (u) => ({
      id: users.find((row) => row.username === u).id,
      token: await account(u),
    })),
  );
  const [a, b, lead] = reviewers;
  await call("/api/block-grading-config" + suffix, {
    method: "PUT",
    body: {
      scoringMode: "per_question",
      reviewMode: 2,
      disputeThreshold: 1,
      arbitratorId: lead.id,
    },
  });
  await call("/api/review-assign" + suffix, {
    method: "POST",
    token: lead.token,
    body: { teacherCounts: { [a.id]: 6, [b.id]: 5 } },
    statuses: [200, 201],
  });
  const row = (
    await call("/api/review-pool" + suffix + "/claim", {
      method: "POST",
      token: a.token,
    })
  ).data;
  const qs = row.questionNumbers.map(Number);
  assert.ok(qs.length > 1);
  const scoreRoute =
    "/api/review/exams/" + s.exam + "/block-crops/" + row.id + "/submit";
  const submit = (token, score, statuses = [200]) =>
    call(scoreRoute, {
      token,
      method: "POST",
      body: {
        scores: qs.map((questionNumber) => ({
          questionNumber,
          score,
          scoreType: "objective",
        })),
      },
      statuses,
    });
  await submit(lead.token, 0, [422]);
  assert.equal((await submit(a.token, 1)).status, "pending");
  await call("/api/review-pool" + suffix + "/crops/" + row.id + "/claim", {
    method: "POST",
    token: b.token,
  });
  assert.equal((await submit(b.token, 3)).status, "disputed");
  const cases = (
    await call("/api/review-arbitration/exams/" + s.exam + "/disputes", {
      token: lead.token,
    })
  ).data;
  assert.deepEqual(cases.find((d) => d.cropId === row.id).questionNumbers, qs);
  const path = "/api/review-arbitration/crops/" + row.id + "/resolve",
    scores = Object.fromEntries(qs.map((q, i) => [q, i % 3]));
  const resolve = (body, statuses) =>
    call(path, { method: "POST", token: lead.token, body, statuses });
  await resolve({ score: 8 }, [422]);
  await resolve({ questionScores: { [qs[0]]: 2 } }, [422]);
  if (beforeResolve) await beforeResolve();
  const result = await resolve({ questionScores: scores }, [200]);
  assert.equal(
    result.finalScore,
    Object.values(scores).reduce((n, x) => n + x, 0),
  );
  await resolve({ questionScores: scores }, [409]);
  evidence.push({
    questions: qs,
    scores,
    final: result.finalScore,
    crop: row.id,
  });
}
async function pdfKnowledge() {
  const s = await matrixSpec("A"),
    teacher = await account("flow_teacher"),
    route = "/api/cards/" + s.card;
  const provider = await call("/api/ai/providers/system", {
    method: "POST",
    statuses: [201],
    body: {
      name: "本地知识点验收",
      providerType: "openai",
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "local-fixture",
      models: ["gpt-5.5"],
    },
  });
  try {
    const pdf = await fs.readFile(path.join(root, "卡型A", "答题卡.pdf"));
    const form = new FormData();
    form.append(
      "files",
      new Blob([pdf], { type: "application/pdf" }),
      "知识点验收.pdf",
    );
    await call(route + "/paper?ocr=0", {
      method: "POST",
      token: teacher,
      body: form,
      statuses: [200, 201],
    });
    const analyze = (cardRoute = route) =>
      fetch(state.server + cardRoute + "/knowledge-points/analyze", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + teacher,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ questionRange: "1" }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const empty = await standaloneCard("知识点失败后释放配额");
    const failed = await analyze("/api/cards/" + empty.id);
    assert.equal(failed.status, 400);
    assert.equal(failed.body.error, "NO_FILES");
    evidence.push({ emptyCard: empty.id, status: failed.status, error: failed.body.error });
    const jobs = await Promise.all([analyze(), analyze(), analyze()]);
    const success = jobs.filter((r) => r.status === 200),
      denied = jobs.filter((r) => r.status === 429);
    evidence.push({
      statuses: jobs.map((r) => r.status),
      modes: success.map((r) => r.body.mode),
      errors: jobs
        .filter((r) => r.status !== 200)
        .map((r) => r.body.error || r.body.code),
    });
    assert.deepEqual(jobs.map((r) => r.status).sort(), [200, 200, 429]);
    assert.equal(denied[0].body.error || denied[0].body.code, "AI_QUOTA_EXCEEDED");
    for (const r of success) {
      assert.equal(r.body.mode, "direct");
      assert.equal(r.body.knowledgePoints[0].points[0], "一二三四五六七八九十");
    }
    const next = await analyze();
    assert.equal(next.status, 200);
    evidence.push({ nextStatus: next.status, mode: next.body.mode, points: next.body.knowledgePoints[0].points });
    const suggest = "/api/analysis/knowledge-points/" + s.exam;
    await call(suggest + "/suggest", { token: teacher });
    const applied = await call(suggest + "/apply-suggestions", {
      token: teacher,
      method: "POST",
      body: { points: [{ question_number: 1, point_text: "函数图像" }] },
    });
    assert.equal(applied.applied, 1);
  } finally {
    await call("/api/ai/providers/system/" + provider.id, { method: "DELETE" });
  }
}

async function backgroundSettings() {
  const teacher = await account("flow_teacher"),
    student = await account("flow_10008");
  const prefs = "/api/users/me/settings",
    image = "/api/users/me/background";
  const baseline = await call(prefs, { token: teacher });
  const file = await fs.readFile(
    path.join(root, "evidence", "首次登录强制改密.png"),
  );
  const form = () => {
    const f = new FormData();
    f.append("file", new Blob([file], { type: "image/png" }), "测试背景.png");
    return f;
  };
  const current = await call("/api/app/background", {
    token: teacher,
    binary: true,
    statuses: [200, 404],
  });
  const pre = (await call(prefs, { token: student })).backgroundOpacity;
  assert.equal(pre, 0);
  try {
    await call(image, {
      method: "POST",
      token: teacher,
      body: form(),
      statuses: [200, 201],
    });
    const get = async () =>
      hash(
        (await call("/api/app/background", { token: teacher, binary: true }))
          .bytes,
      );
    assert.equal(await get(), hash(file));
    for (const opacity of [0.2, 0.6, 0.4])
      await call(prefs, {
        method: "PATCH",
        token: teacher,
        body: { backgroundOpacity: opacity },
      });
    assert.equal(
      (await call(prefs, { token: teacher })).backgroundOpacity,
      0.4,
    );
    await call(image, {
      method: "POST",
      token: student,
      body: form(),
      statuses: [403],
    });
    await call(prefs, {
      method: "PATCH",
      token: student,
      body: { backgroundOpacity: 0.5 },
      statuses: [403],
    });
    await call("/api/app/background", { token: student, statuses: [404] });
    await call("/api/admin/backgrounds/purge-students", {
      method: "POST",
      body: {},
    });
    assert.equal(await get(), hash(file));
    await call(image, { method: "DELETE", token: teacher });
    assert.equal((await call(prefs, { token: teacher })).backgroundOpacity, 0);
    evidence.push({ teacherUploadDigest: hash(file), unchangedByPurge: true });
  } finally {
    if (
      current.headers.get("content-type")?.startsWith("image/") &&
      baseline.backgroundOpacity > 0
    ) {
      const prior = new FormData();
      prior.append(
        "file",
        new Blob([current.bytes], {
          type: current.headers.get("content-type"),
        }),
        "原图.png",
      );
      await call(image, {
        method: "POST",
        token: teacher,
        body: prior,
        statuses: [200, 201],
      });
    }
    await call(prefs, {
      method: "PATCH",
      token: teacher,
      body: { backgroundOpacity: baseline.backgroundOpacity },
    });
  }
}
async function scannerKeyLifecycle() {
  const key = await call("/api/admin/api-keys", {
    method: "POST",
    body: { name: "隔离密钥生命周期", scope: "scanner" },
    statuses: [200, 201],
  });
  const request = async (url, expected) => {
    const r = await fetch(state.server + url, {
      headers: { "X-Api-Key": key.api_key },
    });
    await r.arrayBuffer();
    evidence.push({ url, status: r.status });
    assert.equal(r.status, expected);
  };
  try {
    const list = await call("/api/admin/api-keys");
    assert.ok(!JSON.stringify(list).includes(key.api_key));
    await request("/api/scanner/upload/check", 200);
    await request("/api/exams/" + state.examId + "/scanner-pending", 401);
    await request(
      "/api/scanner/upload/sessions/9a633332-12ec-43fa-8111-bcef99ddc833/status",
      404,
    );
    await call("/api/admin/api-keys/" + key.id, {
      method: "PUT",
      body: { is_active: false },
    });
    await request("/api/scanner/upload/check", 403);
  } finally {
    await call("/api/admin/api-keys/" + key.id, { method: "DELETE" });
  }
}
async function formulaChecks() {
  const s = await matrixSpec("C"),
    route = "/api/exams/" + s.exam + "/assigned-formula",
    before = await call(route);
  const rows = async () =>
    (await call("/api/analysis/exams/" + s.exam + "/score-table")).rows;
  const initial = await rows();
  assert.equal(initial.length, 3);
  const values = [2, 1, 0];
  for (const [i, row] of initial.entries()) {
    const raw = await call(
      "/api/exams/" + s.exam + "/student/" + row.studentId + "/scores",
      {
        method: "PUT",
        body: {
          scores: [
            { questionNumber: 1, scoreType: "objective", score: values[i] },
          ],
        },
      },
    );
    assert.ok(raw);
  }
  const put = (formula, statuses = [200]) =>
    call(route, {
      method: "PUT",
      body: { formula, recalculate: true },
      statuses,
    });
  try {
    const set = [
      {
        type: "proportional",
        params: { minIn: 0.5, maxIn: 1.5, minOut: 30, maxOut: 80 },
        expected: [90, 55, 20],
      },
      {
        type: "linear",
        params: { a: 0.33, b: 30 },
        expected: [30.7, 30.3, 30],
      },
    ];
    for (const config of set) {
      const r = await put({
        type: config.type,
        enabled: true,
        params: config.params,
      });
      assert.equal(r.updated, 3);
      const actual = await rows();
      const scores = actual
        .sort((a, b) => b.totalScore - a.totalScore)
        .map((x) => x.assignedScore);
      assert.deepEqual(scores, config.expected);
      evidence.push({ type: config.type, scores });
    }
    await put({ type: "custom", enabled: true, params: {} }, [400, 422]);
    assert.equal((await call(route)).customFormulaDisabled, true);
  } finally {
    await put(before.formula ?? null);
  }
}

async function weeklyDemo() {
  const workload = await call("/api/db/import-demo", {
    method: "POST",
    body: { confirm: "IMPORT_DEMO_INTO_PRODUCTION" },
  });
  assert.ok(workload.stats.exams > 0);
  try {
    const weeks = (await call("/api/weekly-audit/summary")).weeks;
    assert.equal(weeks.length, 5);
    let active;
    for (const week of weeks.slice(1, 4)) {
      const view = await call(
        "/api/weekly-audit/summary?week=" + week.weekStart,
      );
      for (const grade of view.grades) {
        const summary = (
          await call(
            "/api/weekly-audit/summary?week=" +
              week.weekStart +
              "&gradeId=" +
              grade.gradeId,
          )
        ).active;
        if (summary?.coverageDays >= 3 && summary?.attendedCount > 0) {
          active = summary;
          break;
        }
      }
      if (active) break;
    }
    assert.ok(
      active,
      "A historical quiz week with actual attendance is required",
    );
    assert.ok(
      active.fullAttendanceCount <= active.attendedCount &&
        active.coverageDays <= 5,
    );
    assert.ok(active.weakPoints.length <= 5);
    const groups = await call("/api/exam-groups");
    const rows = Array.isArray(groups)
      ? groups
      : (groups.groups ?? groups.data);
    assert.ok(
      !rows.some((x) => x.source === "week" || x.id === active.groupId),
    );
    evidence.push({
      grade: active.gradeId,
      start: active.weekStart,
      exams: active.examCount,
      coverage: active.coverageDays,
      attended: active.attendedCount,
      full: active.fullAttendanceCount,
      weakPoints: active.weakPoints.length,
      previous: active.vsLastWeek,
    });
  } finally {
    await call("/api/db/clear-demo", { method: "POST", body: {} });
    assert.equal(
      (await call("/api/exams/" + state.examId)).name,
      state.cardTitle,
    );
  }
}
async function prepareMatrixExams() {
  const cards = JSON.parse(
    await fs.readFile(path.join(root, "card-matrix.json")),
  );
  const output = path.join(root, "matrix-exams.json");
  let exams = {};
  try {
    exams = JSON.parse(await fs.readFile(output));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const [key, count] of [
    ["B", 10],
    ["C", 3],
    ["A", 50],
  ]) {
    const cardRoute = "/api/cards/" + cards[key].id,
      card = await call(cardRoute);
    if (!exams[key]) {
      card.studentInfo.studentNumberDigits = 5;
      if (key === "B") {
        const [objective, answer, essay] = card.bodyBlocks;
        objective.answerKey = Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [i + 1, ["A"]]),
        );
        const first = answer.questions[0];
        answer.questions = [
          { ...first, number: 9, score: 10, minHeightMm: 38 },
          {
            ...first,
            id: first.id + "-second",
            number: 10,
            score: 10,
            minHeightMm: 38,
          },
        ];
        essay.questions[0].number = 11;
      }
      const saved = await call(cardRoute, { method: "PUT", body: card });
      const exam = await call("/api/exams", {
        method: "POST",
        statuses: [200, 201],
        body: {
          name: "双机识别 " + key,
          cardId: card.id,
          gradeId: state.grade.id,
          classId: state.cls.id,
          subject: key === "C" ? "化学" : "数学",
          mode: "formal",
        },
      });
      exams[key] = {
        exam: exam.id,
        card: card.id,
        title: card.title,
        count,
        revision: saved.revision,
      };
      await fs.writeFile(output, JSON.stringify(exams, null, 2));
    }
    const meta = exams[key],
      exam = await call("/api/exams/" + meta.exam);
    if (!exam || exam.card_id !== meta.card)
      throw Error("Exam card changed; use a fresh private fixture");
    if (exam.status === "draft")
      await call("/api/exams/" + meta.exam + "/participants", {
        method: "PUT",
        body: { studentIds: state.students.slice(0, count).map((u) => u.id) },
      });
    const dir = path.join(root, "卡型" + key);
    await fs.mkdir(dir, { recursive: true });
    const current = await call(cardRoute);
    meta.revision = current.revision;
    await fs.writeFile(
      path.join(dir, "layout.json"),
      JSON.stringify(await call(cardRoute + "/layout")),
    );
    await fs.writeFile(
      path.join(dir, "答题卡.pdf"),
      (await call(cardRoute + "/pdf?v=" + meta.revision, { binary: true }))
        .bytes,
    );
  }
  await fs.writeFile(output, JSON.stringify(exams, null, 2));
}

async function prepareCacheExam() {
  const out = path.join(root, "cache-exam.json");
  let fixture;
  try {
    fixture = JSON.parse(await fs.readFile(out));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fixture) {
    const template = await call("/api/cards/" + state.cardId);
    const seed = await standaloneCard("识别缓存与上传续传");
    const card = {
      ...template,
      id: seed.id,
      title: seed.title,
      revision: seed.revision,
    };
    for (const block of card.bodyBlocks) {
      block.id = seed.id + "-" + block.id;
      if (Array.isArray(block.questions))
        for (const item of block.questions)
          if (item.id) item.id = seed.id + "-" + item.id;
    }
    const saved = await call("/api/cards/" + seed.id, {
      method: "PUT",
      body: card,
    });
    const exam = await call("/api/exams", {
      method: "POST",
      statuses: [200, 201],
      body: {
        name: seed.title,
        cardId: seed.id,
        gradeId: state.grade.id,
        classId: state.cls.id,
        subject: "数学",
        mode: "formal",
      },
    });
    fixture = {
      exam: exam.id,
      card: seed.id,
      title: seed.title,
      revision: saved.revision,
    };
    await fs.writeFile(out, JSON.stringify(fixture));
  }
  const dir = path.join(root, "缓存测试");
  await fs.mkdir(dir, { recursive: true });
  const status = await call("/api/exams/" + fixture.exam);
  if (status.status === "draft")
    await call("/api/exams/" + fixture.exam + "/participants", {
      method: "PUT",
      body: { studentIds: state.students.slice(8, 11).map((s) => s.id) },
    });
  const route = "/api/cards/" + fixture.card;
  await fs.writeFile(
    path.join(dir, "layout.json"),
    JSON.stringify(await call(route + "/layout")),
  );
  await fs.writeFile(
    path.join(dir, "答题卡原版.pdf"),
    (await call(route + "/pdf?v=" + fixture.revision, { binary: true })).bytes,
  );
}
async function correctionOverlap() {
  const s = JSON.parse(
      await fs.readFile(path.join(root, "concurrency-receipt.json")),
    ),
    teacher = await account("flow_teacher");
  const prefix = "/api/scanner/upload/sessions/" + s.session;
  const route = "/api/exams/" + s.exam + "/student/" + s.userId + "/correction";
  const doc = await call(route, { token: teacher }),
    first = doc.pages[0];
  const options = first.layout.elements.filter(
    (c) => c.type === "objective_option" && Number(c.questionNumber) === 1,
  );
  const old = first.selected.find((id) => options.some((c) => c.id === id));
  const wanted = options.find((c) => c.id !== old);
  assert.ok(old && wanted);
  const make = (document, choice) => ({
    pages: document.pages.map((p, i) => ({
      sourceId: p.sourceId,
      revision: p.revision,
      selected:
        i === 0
          ? [
              ...p.selected.filter((id) => !options.some((c) => c.id === id)),
              choice,
            ]
          : p.selected,
      touched: i === 0 ? [choice] : [],
    })),
  });
  const sum = async () =>
    (await call("/api/analysis/exams/" + s.exam + "/score-table")).rows.find(
      (r) => Number(r.studentId) === s.userId,
    );
  const before = await sum();
  const completed = () =>
    call(prefix + "/complete", { method: "POST", body: { groupId: s.group } });
  const result = await Promise.all([
    completed(),
    call(route, { method: "PUT", token: teacher, body: make(doc, wanted.id) }),
  ]);
  assert.ok(result.every(Boolean));
  const reread = await call(route, { token: teacher });
  assert.ok(reread.pages[0].selected.includes(wanted.id));
  assert.ok(!reread.pages[0].selected.includes(old));
  assert.ok(reread.pages[0].revision > first.revision);
  const current = await sum();
  const stale = await call(route, {
    method: "PUT",
    token: teacher,
    body: make(doc, old),
    statuses: [409],
  });
  assert.ok(stale.message);
  await completed();
  assert.equal((await sum()).totalScore, current.totalScore);
  const images = async (document) =>
    Promise.all(
      document.pages.map(async (p) =>
        hash((await call(p.imageUrl, { token: teacher, binary: true })).bytes),
      ),
    );
  assert.deepEqual(await images(doc), await images(reread));
  assert.deepEqual(
    doc.pages.map((p) => p.sourceId),
    reread.pages.map((p) => p.sourceId),
  );
  await call(route, { method: "PUT", token: teacher, body: make(reread, old) });
  assert.equal((await sum()).totalScore, before.totalScore);
  evidence.push({
    exam: s.exam,
    sourcePages: reread.pages.map((p) => p.sourceId),
    before: before.totalScore,
    after: current.totalScore,
    staleStatus: 409,
    restored: before.totalScore,
    oldRevision: first.revision,
    newRevision: reread.pages[0].revision,
  });
}

async function analysisThresholds() {
  const config = "/api/analysis/config/thresholds";
  const original = await call(config),
    rootRoute = "/api/analysis/exams/" + state.examId;
  const table = await call(rootRoute + "/score-table?displayMode=percentile");
  const raw = table.rows.map((r) => r.totalScore).sort((a, b) => b - a);
  for (const row of table.rows) {
    const rank = 1 + raw.indexOf(row.totalScore);
    assert.equal(row.gradeRank, rank);
    assert.equal(
      row.displayValue,
      Math.round(((raw.length - rank) * 1000) / (raw.length - 1)) / 10,
    );
  }
  const cached = await call(rootRoute + "/overview");
  try {
    const settings = {
      ...original,
      passRate: 0.3,
      excellentRate: 0.65,
      errorTiers: [80, 55, 35],
    };
    await call(config, { method: "PUT", body: settings });
    const fresh = await call(rootRoute + "/overview");
    for (const [ratio, field] of [
      [0.3, "pass"],
      [0.65, "excellent"],
    ]) {
      const limit = cached.fullScore * ratio;
      assert.equal(fresh[field + "Score"], limit);
      assert.equal(
        fresh[field + "Rate"],
        Math.round((100 * raw.filter((v) => v >= limit).length) / raw.length),
      );
    }
    assert.notEqual(cached.passRate, fresh.passRate);
    evidence.push({
      students: raw.length,
      previous: cached.passRate,
      updated: fresh.passRate,
      passLine: fresh.passScore,
      excellentLine: fresh.excellentScore,
    });
  } finally {
    await call(config, { method: "PUT", body: original });
  }
  assert.deepEqual(
    (await call(rootRoute + "/overview")).passRate,
    cached.passRate,
  );
}
async function prepareLadderSample() {
  const file = path.join(root, "ladder-sample.json");
  try {
    await fs.access(file);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const card = await standaloneCard("天梯截止线十三人验收");
  const exam = await call("/api/exams", {
    method: "POST",
    statuses: [200, 201],
    body: {
      name: card.title,
      cardId: card.id,
      gradeId: state.grade.id,
      classId: state.cls.id,
      subject: "数学",
      mode: "formal",
    },
  });
  await call("/api/exams/" + exam.id + "/participants", {
    method: "PUT",
    body: { studentIds: state.students.slice(0, 13).map((u) => u.id) },
  });
  const totals = [100, 98, 98, 95, 94, 93, 92, 91, 90, 88, 88, 88, 37];
  await fs.writeFile(
    file,
    JSON.stringify({
      exam: exam.id,
      card: card.id,
      students: state.students
        .slice(0, 13)
        .map((u, i) => ({ id: u.id, score: totals[i] })),
    }),
  );
}
async function ladderCutoff() {
  const sample = JSON.parse(
    await fs.readFile(path.join(root, "ladder-sample.json")),
  );
  const rank = JSON.parse(await fs.readFile(path.join(root, "rank-seed.json")));
  const student = await account("flow_10001"),
    config = await call("/api/ladder/config");
  const ids = [sample.exam, ...rank.exams],
    examRoute = (id) => "/api/exams/" + id;
  try {
    await call("/api/ladder/config", {
      method: "PUT",
      body: { enabled: true },
    });
    await call("/api/exams/publish-batch", {
      method: "POST",
      body: { examIds: ids },
    });
    const view = await call("/api/ladder/exams/" + sample.exam, {
      token: student,
    });
    assert.equal(view.rows.length, 12);
    assert.equal(view.studentCount, 13);
    assert.deepEqual(
      view.rows.map((r) => r.rank),
      [1, 2, 2, 4, 5, 6, 7, 8, 9, 10, 10, 10],
    );
    const group = "/api/ladder/exam-groups/" + rank.group;
    const full = await call(group, { token: student });
    assert.equal(full.studentCount, 2);
    await call(examRoute(rank.exams[0]) + "/unpublish", {
      method: "POST",
      body: {},
    });
    assert.equal((await call(examRoute(rank.exams[0]))).score_published, 2);
    assert.ok(
      !(await call("/api/ladder/options", { token: student })).groups.some(
        (g) => g.id === rank.group,
      ),
    );
    await call(group, { token: student, statuses: [403] });
    await call(examRoute(rank.exams[0]) + "/publish", {
      method: "POST",
      body: {},
    });
    assert.ok(
      (await call("/api/ladder/options", { token: student })).groups.some(
        (g) => g.id === rank.group,
      ),
    );
    evidence.push({
      participants: view.studentCount,
      shown: view.rows.length,
      ranks: view.rows.map((r) => r.rank),
      group: rank.group,
      withdrawn: rank.exams[0],
    });
  } finally {
    await call("/api/ladder/config", {
      method: "PUT",
      body: { enabled: config.enabled },
    });
  }
}

async function feedbackLimits() {
  const teacher = await account("flow_teacher");
  const before = await call("/api/feedback/mine", { token: teacher });
  const base = () => {
    const form = new FormData();
    form.set("title", "双机附件上限");
    form.set("content", "隔离环境验证附件数量和单件容量。");
    return form;
  };
  const count = base();
  for (let index = 0; index < 16; index++)
    count.append(
      "files",
      new Blob(["test"], { type: "text/plain" }),
      "small-" + index + ".txt",
    );
  const many = await call("/api/feedback", {
    method: "POST",
    token: teacher,
    body: count,
    statuses: [400],
  });
  assert.match(many.error, /15/);
  const size = base();
  size.append(
    "files",
    new Blob([new Uint8Array(100 * 1024 * 1024 + 1)], {
      type: "application/octet-stream",
    }),
    "size-limit.bin",
  );
  const large = await call("/api/feedback", {
    method: "POST",
    token: teacher,
    body: size,
    statuses: [413],
  });
  assert.match(large.error, /100/);
  const after = await call("/api/feedback/mine", { token: teacher });
  assert.deepEqual(
    after.data.map((r) => r.id),
    before.data.map((r) => r.id),
  );
  evidence.push({
    files: 16,
    singleBytes: 100 * 1024 * 1024 + 1,
    recordsBefore: before.data.length,
    recordsAfter: after.data.length,
  });
}
async function organizationChecks() {
  const XLSX = await import("xlsx");
  const suffix = Date.now().toString();
  for (const [role, route] of [
    ["student", "students"],
    ["teacher", "teachers"],
  ]) {
    const username = "flow_export_" + role + "_" + suffix;
    const fixture = await call("/api/users", {
      method: "POST",
      statuses: [200, 201],
      body: {
        username,
        name: "导出账户验证",
        role,
        password: state.password,
        ...(role === "student"
          ? { student_number: suffix.slice(-9) }
          : { teacher_role: "subject_teacher" }),
      },
    });
    if (role === "student")
      await call("/api/classes/" + state.cls.id + "/students", {
        method: "POST",
        body: { studentIds: [fixture.id] },
      });
    const response = await call("/api/export/" + route, { binary: true });
    const book = XLSX.read(response.bytes, { type: "buffer" });
    const data = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
    const row = data.find((r) => r["账号"] === username);
    assert.ok(row);
    assert.equal(row["姓名"], "导出账户验证");
    assert.equal(row["密码"], state.password);
    await call("/api/users/" + fixture.id, {
      method: "PUT",
      body: { is_active: false },
    });
    evidence.push({
      role,
      workbookRows: data.length,
      matchesInitialPassword: true,
    });
  }
  const all = await call("/api/users"),
    rows = Array.isArray(all) ? all : all.users;
  const admins = rows.filter((u) => u.role_name === "admin" && u.is_active);
  assert.equal(
    admins.length,
    1,
    "Dedicated VM must have exactly one enabled administrator",
  );
  const account = "/api/users/" + admins[0].id;
  for (const change of [{ is_active: false }, { role: "teacher" }]) {
    const denied = await call(account, {
      method: "PUT",
      body: change,
      statuses: [400],
    });
    assert.match(denied.message, /管理员/);
  }
  await call("/api/admin/console/summary");
  const cls = await call("/api/classes", {
    method: "POST",
    statuses: [201],
    body: { gradeId: state.grade.id, name: "待归档空历史班" + suffix },
  });
  const card = await standaloneCard("历史班建档测试" + suffix);
  const exam = {
    name: card.title,
    cardId: card.id,
    gradeId: state.grade.id,
    classId: cls.id,
    subject: "数学",
    mode: "formal",
  };
  const archived = await call("/api/exams", {
    method: "POST",
    statuses: [200, 201],
    body: exam,
  });
  await call("/api/classes/" + cls.id, { method: "DELETE" });
  const rejected = await call("/api/exams", {
    method: "POST",
    body: { ...exam, name: exam.name + "新" },
    statuses: [400],
  });
  assert.equal(rejected.code, "CLASS_ARCHIVED");
  assert.equal((await call("/api/exams/" + archived.id)).class_id, cls.id);
}

async function conflictProof() {
  const sample = JSON.parse(
    await fs.readFile(path.join(root, "cache-exam.json")),
  );
  const sid = state.students.find((u) => u.username === "flow_10009").id;
  const base = "/api/exams/" + sample.exam,
    list = base + "/scanner-pending";
  const grade = async () =>
    (
      await call("/api/analysis/exams/" + sample.exam + "/score-table")
    ).rows.find((r) => r.studentId === sid);
  const edit = (score) =>
    call(base + "/student/" + sid + "/scores", {
      method: "PUT",
      body: { scores: [{ questionNumber: 5, scoreType: "subjective", score }] },
    });
  if (stage === "conflict-prepare") {
    assert.equal((await grade()).totalScore, 39);
    await edit(21);
    assert.equal((await grade()).totalScore, 41);
  } else {
    assert.equal(await grade(), undefined);
    const rows = (await call(list)).items.filter(
      (r) => r.studentNumber === "10009" && r.reason === "duplicate",
    );
    assert.equal(rows.length, 2);
    const known = JSON.parse(
      await fs.readFile(path.join(root, "concurrency-receipt.json")),
    );
    const old = rows.find((r) => r.sessionId === known.session),
      copy = rows.find((r) => r.sessionId !== known.session);
    assert.ok(old && copy);
    const prefix = "/api/scanner/upload/sessions/" + copy.sessionId,
      correction = prefix + "/groups/" + copy.groupId + "/correction";
    const doc = await call(correction);
    const p = doc.pages[0],
      cells = p.layout.elements.filter(
        (c) => c.type === "objective_option" && c.questionNumber === 1,
      );
    const fresh = cells.find((c) => c.option === "D"),
      before = p.selected.find((id) => cells.some((c) => c.id === id));
    assert.ok(fresh && before);
    const pages = [
      {
        sourceId: p.sourceId,
        revision: p.revision,
        selected: [
          ...p.selected.filter((id) => !cells.some((c) => c.id === id)),
          fresh.id,
        ],
        touched: [fresh.id],
      },
    ];
    const [retry, update] = await Promise.all([
      call(prefix + "/complete", {
        method: "POST",
        body: { groupId: copy.groupId },
        statuses: [200, 409],
      }),
      call(correction, { method: "PUT", body: { pages } }),
    ]);
    assert.ok(retry && update);
    assert.ok((await call(correction)).pages[0].selected.includes(fresh.id));
    await call(correction, { method: "PUT", body: { pages }, statuses: [409] });
    assert.equal(await grade(), undefined);
    await call(prefix + "/groups/" + copy.groupId + "/discard", {
      method: "POST",
      body: {},
    });
    await call("/api/scanner/upload/sessions/" + old.sessionId + "/complete", {
      method: "POST",
      body: { groupId: old.groupId },
    });
    assert.equal((await grade()).totalScore, 41);
    assert.ok(
      !(await call(list)).items.some((r) => r.studentNumber === "10009"),
    );
    await edit(19);
    assert.equal((await grade()).totalScore, 39);
    evidence.push({
      student: "10009",
      old: old.sessionId,
      copy: copy.sessionId,
      originalSource: known.session,
      restoredManual: 41,
      baseline: 39,
    });
  }
}

async function authLifecycle() {
  const student = "flow_10008",
    uid = state.students.find((u) => u.username === student).id;
  const resource = async (token) => {
    const paper = await call(
      "/api/scores/me/exams/" + state.examId + "/paper",
      { token },
    );
    return (
      paper.answerFiles?.[0]?.fileUrl ||
      paper.answerBlocks?.[0]?.imageUrl ||
      paper.pages?.[0]?.imageUrl
    );
  };
  const issue = async (token) => {
    const media = await resource(token);
    assert.ok(media);
    const receipt = await call("/api/auth/media-ticket", {
      method: "POST",
      token,
      body: { path: media },
    });
    return new URL(
      media + "?mt=" + encodeURIComponent(receipt.ticket),
      state.server,
    );
  };
  const status = async (url) => {
    const r = await fetch(url);
    await r.arrayBuffer();
    return r.status;
  };
  const one = await account(student),
    a = await issue(one);
  assert.equal(await status(a), 200);
  await call("/api/users/" + uid, {
    method: "PUT",
    body: { is_active: false },
  });
  try {
    assert.equal(await status(a), 401);
    await call("/api/auth/me", { token: one, statuses: [401] });
  } finally {
    await call("/api/users/" + uid, {
      method: "PUT",
      body: { is_active: true },
    });
  }
  const two = await account(student),
    b = await issue(two);
  assert.equal(await status(b), 200);
  const logout = await fetch(state.server + "/api/auth/logout", {
    method: "POST",
    headers: { Authorization: "Bearer " + two },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") || "", /projectx_auth_token=;/);
  assert.equal(await status(b), 401);
  await call("/api/auth/me", { token: two, statuses: [401] });
  evidence.push({
    beforeDisable: 200,
    afterDisable: 401,
    beforeLogout: 200,
    afterLogout: 401,
    clearedCookie: true,
  });
}

async function savedSheetInvariants() {
  const s = JSON.parse(
    await fs.readFile(path.join(root, "concurrency-receipt.json")),
  );
  const base = "/api/exams/" + s.exam + "/student/" + s.userId;
  const teacher = await account("flow_teacher");
  const get = (suffix) => call(base + suffix, { token: teacher });
  const put = (pages, statuses = [200]) =>
    call(base + "/correction", {
      method: "PUT",
      token: teacher,
      body: { pages },
      statuses,
    });
  const [first, second, prior] = await Promise.all([
    get("/correction"),
    get("/correction"),
    get("/scores"),
  ]);
  assert.equal(first.pages.length, 1);
  const page = first.pages[0];
  const edits = (p, cells, chosen) => [
    {
      sourceId: p.sourceId,
      revision: p.revision,
      selected: [
        ...p.selected.filter((id) => !cells.some((c) => c.id === id)),
        chosen.id,
      ],
      touched: [chosen.id],
    },
  ];
  const digits = page.layout.elements.filter(
    (c) => c.type === "student_digit" && c.digitIndex === 0,
  );
  const changedDigit = digits.find((c) => !page.selected.includes(c.id));
  assert.ok(changedDigit);
  const denied = await put(edits(page, digits, changedDigit), [409]);
  assert.match(denied.message, /学号归属/);
  assert.equal((await get("/correction")).pages[0].revision, page.revision);
  const options = page.layout.elements.filter(
    (c) => c.type === "objective_option" && c.questionNumber === 1,
  );
  const old = options.find((c) => page.selected.includes(c.id)),
    other = options.find((c) => c.id !== old.id);
  const untouched = (scores) =>
    scores.questionScores.filter((q) => q.question_number !== 1);
  assert.ok(untouched(prior).some((q) => q.manually_modified));
  await put(edits(page, options, other));
  try {
    const latest = await get("/scores");
    assert.deepEqual(untouched(latest), untouched(prior));
    await put(edits(second.pages[0], options, other), [409]);
  } finally {
    const live = (await get("/correction")).pages[0];
    await put(edits(live, options, old));
  }
  const restored = await get("/scores");
  assert.deepEqual(untouched(restored), untouched(prior));
  evidence.push({
    untouched: untouched(restored).map((r) => r.question_number),
    manual: untouched(restored)
      .filter((q) => q.manually_modified)
      .map((r) => r.question_number),
    ownerEdit: 409,
    stale: 409,
  });
}
async function scanReviewPublication() {
  const spec = await matrixSpec("B");
  const base = "/api/exams/" + spec.exam;
  const pending = base + "/scanner-pending";
  const original = (await call(base)).score_published;
  const key = "auto_unpublish_on_score_change";
  const originalPolicy = (await call("/api/system-settings")).data[key];
  const setPolicy = (value) =>
    call("/api/system-settings", { method: "PUT", body: { key, value } });
  const publish = async () => {
    if ((await call(base)).score_published !== 1)
      await call(base + "/publish", { method: "POST", body: {} });
  };
  const visible = async (token) =>
    (await call("/api/scores/me", { token })).scores.some(
      (x) => x.exam_id === spec.exam,
    );
  const reader = await account("flow_10001");
  try {
    for (const [number, policy] of [
      ["10015", "0"],
      ["10016", "1"],
    ]) {
      const row = (await call(pending)).items.find(
        (x) => x.studentNumber === number && x.reason === "roster",
      );
      assert.ok(row, "No pending policy sample " + number);
      await setPolicy(policy);
      await publish();
      assert.equal(await visible(reader), true);
      await call(pending, {
        method: "POST",
        body: {
          sessionId: row.sessionId,
          groupId: row.groupId,
          token: row.token,
          action: "accept",
        },
      });
      const expected = policy === "0";
      assert.equal((await call(base)).score_published, Number(expected));
      const student = await account("flow_" + number);
      assert.equal(await visible(student), expected);
      assert.equal(await visible(reader), expected);
      evidence.push({
        number,
        policy,
        visible: expected,
        kind: "scanner save",
      });
    }
    await multiArbitration(async () => {
      await setPolicy("1");
      await publish();
      assert.equal(await visible(reader), true);
    });
    assert.equal((await call(base)).score_published, 0);
    assert.equal(await visible(reader), false);
    evidence.push({ policy: "1", kind: "arbitration", visible: false });
  } finally {
    await setPolicy(originalPolicy);
    if (original === 1) await publish();
    if (original === 2 && (await call(base)).score_published !== 2) {
      await publish();
      await call(base + "/unpublish", { method: "POST", body: {} });
    }
  }
}
async function frozenRosterSearch() {
  const student = state.students.find((x) => x.username === "flow_10005");
  assert.ok(student);
  const base = "/api/exams/" + state.examId + "/participant-search?q=10005";
  const search = async (route) => (await call(route)).students;
  const contains = (rows) =>
    rows.some(
      (row) => Number(row.id ?? row.student_id ?? row.studentId) === student.id,
    );
  assert.ok(contains(await search(base + "&scope=roster")));
  assert.ok(contains(await search(base)));
  await call("/api/users/" + student.id, {
    method: "PUT",
    body: { is_active: false },
  });
  try {
    assert.ok(contains(await search(base + "&scope=roster")));
    assert.equal(contains(await search(base)), false);
    evidence.push({
      active: false,
      retainedByExam: true,
      availableForNewRoster: false,
    });
  } finally {
    await call("/api/users/" + student.id, {
      method: "PUT",
      body: { is_active: true },
    });
  }
}
async function manualPublication() {
  const { exam, userId } = JSON.parse(
    await fs.readFile(path.join(root, "concurrency-receipt.json")),
  );
  const student = await account("flow_10009");
  const base = "/api/exams/" + exam;
  const route = base + "/student/" + userId + "/scores";
  const key = "auto_unpublish_on_score_change";
  const originalPolicy = (await call("/api/system-settings")).data[key];
  const original = (await call(base)).score_published;
  const question = (await call(route)).questionScores.find(
    (q) => q.question_number === 5,
  );
  assert.ok(question);
  const initial = Number(question.score);
  assert.ok(initial > 0);
  const edit = (score) =>
    call(route, {
      method: "PUT",
      body: { scores: [{ questionNumber: 5, scoreType: "subjective", score }] },
    });
  const setPolicy = (value) =>
    call("/api/system-settings", { method: "PUT", body: { key, value } });
  const publish = () => call(base + "/publish", { method: "POST", body: {} });
  const read = async () =>
    (await call("/api/scores/me", { token: student })).scores.find(
      (r) => r.exam_id === exam,
    );
  try {
    await setPolicy("0");
    if (original !== 1) await publish();
    const before = (await read()).total_score;
    await edit(initial - 1);
    assert.equal((await read()).total_score, before - 1);
    await setPolicy("1");
    await edit(initial);
    assert.equal((await call(base)).score_published, 0);
    assert.equal(await read(), undefined);
    await publish();
    assert.equal((await read()).total_score, before);
    evidence.push({
      exam,
      before,
      afterDefault: before - 1,
      afterEnabled: "hidden",
      afterPublish: before,
    });
  } finally {
    await setPolicy("0");
    const current = (await call(route)).questionScores.find(
      (q) => q.question_number === 5,
    );
    if (current.score !== initial) await edit(initial);
    if (original !== 1 && (await call(base)).score_published === 1)
      await call(base + "/unpublish", { method: "POST", body: {} });
    await setPolicy(originalPolicy);
  }
}
async function answerPublishPolicy() {
  const sample = JSON.parse(
    await fs.readFile(path.join(root, "cache-exam.json")),
  );
  const base = "/api/exams/" + sample.exam;
  const settings = "/api/system-settings",
    key = "auto_unpublish_on_score_change";
  const policy = (value) =>
    call(settings, { method: "PUT", body: { key, value } });
  const before = (await call(settings)).data[key];
  const originalExam = await call(base);
  const student = await account("flow_10009");
  const providerScores = async () =>
    (await call("/api/scores/me", { token: student })).scores.find(
      (r) => r.exam_id === sample.exam,
    );
  const answers = await call(base + "/answers"),
    q = answers.questions.find((q) => q.questionNumber === 1);
  assert.deepEqual(q.answerKey, ["A"]);
  const set = (value) =>
    call(base + "/answers", {
      method: "PUT",
      body: { answers: { 1: [value] } },
    });
  const publish = () => call(base + "/publish", { method: "POST", body: {} });
  try {
    await policy("0");
    if ((await call(base)).score_published !== 1) await publish();
    const baseline = (await providerScores()).total_score;
    await set("B");
    assert.equal((await providerScores()).total_score, baseline - q.score);
    assert.equal((await call(base)).score_published, 1);
    await policy("1");
    await set("A");
    assert.equal((await call(base)).score_published, 0);
    assert.equal(await providerScores(), undefined);
    await publish();
    assert.equal((await providerScores()).total_score, baseline);
    evidence.push({
      publishedScore: baseline,
      afterRegrade: baseline - q.score,
      autoWithdraw: true,
    });
  } finally {
    await policy("0");
    if (
      (await call(base + "/answers")).questions.find(
        (x) => x.questionNumber === 1,
      ).answerKey[0] !== "A"
    )
      await set("A");
    if (
      originalExam.score_published !== 1 &&
      (await call(base)).score_published === 1
    )
      await call(base + "/unpublish", { method: "POST", body: {} });
    await policy(before);
  }
}
async function studentCrossSubset() {
  const token = await account("flow_10008");
  const exams = await call("/api/exams");
  const items = Array.isArray(exams) ? exams : exams.exams;
  const other = items.find((e) =>
    /^得分率验收 百点评估 \d{4}-10-15$/.test(e.name),
  );
  assert.ok(other);
  const config = await call("/api/ladder/config");
  await call("/api/ladder/config", { method: "PUT", body: { enabled: true } });
  const mode = "/api/ladder/cross-exam?mode=selected&examIds=";
  try {
    const one = await call(mode + state.examId, { token });
    const both = await call(mode + [state.examId, other.id].join(","), {
      token,
    });
    assert.deepEqual(both, one);
    assert.deepEqual([one.myScore, one.myRank, one.studentCount], [45, 1, 50]);
    await call(mode + other.id, { token, statuses: [403] });
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, "manifest.json")),
    );
    const expected = manifest
      .map((r) => (r.physicalStudent === "10008" ? 45 : r.totalScore))
      .sort((a, b) => b - a);
    const cut = expected[9];
    assert.equal(one.rows.length, expected.filter((s) => s >= cut).length);
    evidence.push({
      participants: 50,
      ownScore: 45,
      rank: 1,
      displayed: one.rows.length,
      untaken: other.id,
    });
  } finally {
    await call("/api/ladder/config", {
      method: "PUT",
      body: { enabled: config.enabled },
    });
  }
}
async function scoreProgress() {
  const token = await account("flow_10040");
  const semester = await call("/api/scores/me/semester-comparison", { token });
  const subjects = await call("/api/scores/me/subject-comparison", { token });
  for (const [subject, current, change, direction] of [
    ["百点评估", 85, 5, "up"],
    ["一百五十点评估", 83, 3, "up"],
    ["进步阈值下界", 82.7, 2.7, "stable"],
  ]) {
    const found = semester.subjectComparisons.find(
      (row) => row.subject === subject,
    );
    assert.ok(found, subject);
    assert.deepEqual(
      [
        found.previousScoreRate,
        found.currentScoreRate,
        found.scoreRateChange,
        found.direction,
      ],
      [80, current, change, direction],
    );
    assert.equal(
      subjects.subjects.find((row) => row.subject === subject)?.trend,
      direction,
    );
    evidence.push(found);
  }
}
async function readAssignedBlock() {
  const spec = await matrixSpec("B");
  const target = await call("/api/exams/" + spec.exam);
  const teacherName = "flow_teacher";
  const user = (await call("/api/users?keyword=" + teacherName)).users.find(
    (u) => u.username === teacherName,
  );
  const student = state.students.find((s) => s.username === "flow_10013");
  const card = await call("/api/cards/" + spec.card);
  const block = card.bodyBlocks.find((b) => b.blockKind === "answer");
  assert.ok(block);
  const permissions = "/api/admin/permissions";
  const grant = {
    teacher_id: user.id,
    grade_id: target.grade_id,
    class_id: target.class_id,
    subject: target.subject,
    block_id: block.id,
    can_view_students: 0,
    can_view_scores: 1,
    can_view_charts: 1,
    can_grade: 1,
    can_assign: 0,
  };
  const matching = (row) =>
    row.teacher_id === user.id && row.block_id === block.id;
  assert.ok(
    !(await call(permissions)).some((row) => row.teacher_id === user.id),
    "Use an unconfigured fixture teacher",
  );
  const token = await account(teacherName);
  const classRoster = "/api/classes/" + target.class_id + "/students";
  const scoreTable = "/api/analysis/exams/" + spec.exam + "/score-table";
  assert.ok((await call(classRoster, { token })).length > 0);
  await call(scoreTable, { token });
  await call(permissions, { method: "PUT", body: grant });
  try {
    const allowed = await call(
      "/api/scanner/exam/" + spec.exam + "/student/" + student.id + "/scans",
    );
    assert.equal(allowed.pages.length, 2);
    const first = allowed.pages.find((r) => r.side === "front"),
      second = allowed.pages.find((r) => r.side === "back");
    const original = (await call("/api/scanner/record/" + first.recordId))
      .recognition;
    assert.ok(original && JSON.parse(original.objective_json).length > 0);
    const readableImage = await call(
      "/api/scanner/scan-image/" + first.recordId,
      { token, binary: true },
    );
    assert.match(readableImage.headers.get("content-type"), /^image\//);
    const filtered = (
      await call("/api/scanner/record/" + first.recordId, { token })
    ).recognition;
    assert.ok(filtered);
    assert.equal(filtered.total_score, null);
    assert.equal(filtered.max_score, null);
    const items = [
      ...JSON.parse(filtered.objective_json || "[]"),
      ...JSON.parse(filtered.subjective_json || "[]"),
    ];
    assert.equal(JSON.parse(filtered.objective_json || "[]").length, 0);
    assert.ok(items.every((b) => b.blockId === block.id));
    await call("/api/scanner/record/" + first.recordId + "/upload-payload", {
      token,
      statuses: [404],
    });
    await call("/api/scanner/scan-image/" + second.recordId, {
      token,
      statuses: [403],
    });
    await call(
      "/api/exams/" + spec.exam + "/student/" + student.id + "/correction",
      { token, statuses: [403] },
    );
    await call(classRoster, { token, statuses: [403] });
    await call(scoreTable, { token, statuses: [403] });
    await call("/api/export/students", { token, statuses: [403] });
    evidence.push({
      allowedRecord: first.recordId,
      excludedPage: second.recordId,
      visibleBlock: block.id,
      rows: items.length,
      maskedScore: filtered.total_score,
    });
  } finally {
    const entry = (await call(permissions)).find(matching);
    if (entry) await call(permissions + "/" + entry.id, { method: "DELETE" });
  }
  assert.ok((await call(classRoster, { token })).length > 0);
  await call(scoreTable, { token });
}

async function answerFormats() {
  const exams = await call("/api/exams");
  const target = (exams.exams || exams).find(
    (e) => e.name === "纯客观信度验收四题",
  );
  assert.ok(target);
  const base = "/api/exams/" + target.id,
    pages = base + "/answer-key/pages";
  const files = [
    ["示例答案.png", "image/png", "答案文字1.png"],
    ["试卷答案.pdf", "application/pdf", "答题卡原版.pdf"],
    [
      "示例解析.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "原卷练习.docx",
    ],
  ];
  const desired = [];
  for (const [name, type, filename] of files)
    desired.push({
      name,
      type,
      bytes: await fs.readFile(path.join(root, filename)),
    });
  const send = (items, statuses = [200]) => {
    const form = new FormData();
    for (const item of items)
      form.append(
        "files",
        new Blob([item.bytes], { type: item.type }),
        item.name,
      );
    return call(pages + "?ocr=0", { method: "POST", body: form, statuses });
  };
  const existing = (await call(base + "/answer-key")).answerPages;
  assert.equal(
    existing.length,
    0,
    "Use a fresh isolated objective sample for the file upload test",
  );
  const uploaded = await send(desired);
  assert.equal(uploaded.count, 3);
  const seven = await send(Array(7).fill(desired[0]));
  assert.equal(seven.answerPages.length, 10);
  const denied = await send([desired[0]], [400]);
  assert.match(denied.message, /10/);
  for (const file of seven.pages)
    await call(pages + "/" + file.pageIndex, { method: "DELETE" });
  await call(base, {
    method: "PATCH",
    body: { answerKeyMode: "file", showOriginalPaper: false },
  });
  if (target.score_published !== 1)
    await call(base + "/publish", { method: "POST", body: {} });
  const token = await account("flow_10008");
  const route = "/api/scores/me/exams/" + target.id + "/paper";
  const view = await call(route, { token });
  assert.deepEqual(
    view.answerFiles.map((f) => f.mimeType),
    desired.map((d) => d.type),
  );
  assert.deepEqual(
    view.answerFiles.map((f) => f.isImage),
    [true, false, false],
  );
  for (const [i, file] of view.answerFiles.entries()) {
    const get = await call(file.fileUrl, { token, binary: true });
    assert.equal(hash(get.bytes), hash(desired[i].bytes));
  }
  const thumb = await call(pages + "/1/image", { binary: true });
  assert.ok(thumb.headers.get("content-type").startsWith("image/"));
  assert.ok(thumb.bytes.length);
  evidence.push({
    formats: view.answerFiles.map((f) => f.mimeType),
    pageLimit: 10,
    eleventh: 400,
    remaining: 3,
    previewBytes: thumb.bytes.length,
  });
}
async function answerOcr() {
  const exams = await call("/api/exams");
  const target = (exams.exams || exams).find(
    (e) => e.name === "纯客观信度验收四题",
  );
  assert.ok(target);
  const base = "/api/exams/" + target.id + "/answer-key";
  const form = new FormData();
  for (const idx of [1, 2]) {
    const filename = "答案文字" + idx + ".png";
    form.append(
      "files",
      new Blob([await fs.readFile(path.join(root, filename))], {
        type: "image/png",
      }),
      filename,
    );
  }
  const initial = await call(base);
  const result = await call(base + "/pages", { method: "POST", body: form });
  evidence.push({ ocr: result.ocr });
  try {
    const drafts = result.ocr.flatMap((page) => page.drafts || []);
    assert.deepEqual(
      drafts.map((row) => row.questionNumber),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      drafts.slice(0, 5).map((row) => row.answerText),
      ["B", "A", "C", "D", "B"],
    );
    assert.match(drafts[5].answerText, /A/);
    assert.deepEqual((await call(base)).answers, initial.answers);
    const reviewed = drafts.map((row) =>
      row.questionNumber === 6 ? { ...row, answerText: "A" } : row,
    );
    const saved = await call(base, {
      method: "PUT",
      body: { answers: reviewed },
    });
    assert.equal(saved.saved, 6);
    const persisted = (await call(base)).answers;
    assert.deepEqual(
      persisted.map((row) => row.answerText),
      ["B", "A", "C", "D", "B", "A"],
    );
    evidence.push({
      ocrSixth: drafts[5].answerText,
      teacherConfirmedSixth: "A",
    });
  } finally {
    for (const page of result.pages)
      await call(base + "/pages/" + page.pageIndex, { method: "DELETE" });
  }
}

async function subjectTracks() {
  const title = "四人分科全科筛选验收";
  const setup = [
    { number: "20016", track: "science", raw: 225, assigned: 230, count: 3 },
    { number: "20017", track: "science", raw: 224, assigned: 240, count: 3 },
    { number: "20018", track: "arts", raw: 175, assigned: 175, count: 2 },
    { number: "20019", track: "arts", raw: 85, assigned: 85, count: 1 },
  ];
  for (const item of setup) {
    const list = await call("/api/users?keyword=" + item.number);
    const user = list.users.find((row) => row.student_number === item.number);
    assert.equal(user?.name, "合成学生" + (Number(item.number) - 20000));
    await call("/api/users/" + user.id, {
      method: "PUT",
      body: { track: item.track },
    });
  }
  const subjects = ["数学", "语文", "化学"];
  const exams = await call("/api/exams");
  const ids = subjects.map(
    (sub) =>
      (exams.exams || exams).find((e) => e.name === "分科人数复核" + sub).id,
  );
  const groups = await call("/api/exam-groups");
  const group =
    groups.find((g) => g.name === title) ||
    (await call("/api/exam-groups", {
      method: "POST",
      statuses: [201],
      body: {
        name: title,
        examIds: ids,
        memberTracks: { [ids[2]]: "science" },
        total_score_mode: "assigned",
      },
    }));
  const route = "/api/exam-groups/" + group.id;
  const original = await call(route);
  try {
    for (const mode of ["raw", "assigned"]) {
      for (const fullOnly of [0, 1]) {
        await call(route, {
          method: "PUT",
          body: { total_score_mode: mode, only_full_participants: fullOnly },
        });
        for (const track of ["all", "science", "arts"]) {
          const columns = track === "arts" ? subjects.slice(0, 2) : subjects;
          const result = await call(
            route + "/rankings?track=" + track + "&fullOnly=" + fullOnly,
          );
          const wanted = setup
            .filter(
              (r) =>
                (track === "all" || r.track === track) &&
                (!fullOnly || r.count === columns.length),
            )
            .sort((a, b) => b[mode] - a[mode]);
          assert.deepEqual(result.displayColumns, columns);
          assert.deepEqual(
            result.rows.map((r) => [
              r.studentNumber,
              r.totalRawScore,
              r.totalAssignedScore,
              r.totalGradeRank,
            ]),
            wanted.map((r, i) => [r.number, r.raw, r.assigned, i + 1]),
          );
          assert.equal(result.totalStudents, wanted.length);
          evidence.push({
            mode,
            fullOnly,
            track,
            ranked: wanted.map((r) => r.number),
            columnCount: columns.length,
          });
        }
      }
    }
  } finally {
    await call(route, {
      method: "PUT",
      body: {
        total_score_mode: original.total_score_mode,
        only_full_participants: original.only_full_participants,
      },
    });
  }
}

async function analysisStatistics() {
  const expected = JSON.parse(
    await fs.readFile(path.join(root, "expected-statistics.json")),
  );
  const exams = await call("/api/exams");
  const pure = (exams.exams || exams).find(
    (row) => row.name === "纯客观信度验收四题",
  );
  assert.ok(pure);
  const pathFor = (id) => "/api/analysis/exams/" + id;
  const [mixed, objective, distributions] = await Promise.all([
    call(pathFor(state.examId) + "/metrics"),
    call(pathFor(pure.id) + "/metrics"),
    call(pathFor(state.examId) + "/distribution"),
  ]);
  const dist = distributions[0];
  assert.equal(dist.sampleSize, expected.mixedSamples);
  const values = {
    w: dist.normality.shapiroFrancia.W,
    alpha: mixed.reliability,
    kr20: objective.reliability,
  };
  for (const [key, actual] of Object.entries(values)) {
    assert.ok(
      Number.isFinite(actual) && Math.abs(actual - expected[key]) <= 0.00051,
      key + " expected " + expected[key] + ", received " + actual,
    );
  }
  evidence.push({ expected, values });
}
const stages = {
  "namesake-import": importNamesakes,
  "transfer-history": transferHistory,
  "analysis-statistics": analysisStatistics,
  "answer-formats": answerFormats,
  "assigned-block-read": readAssignedBlock,
  "answer-ocr": answerOcr,
  "subject-tracks": subjectTracks,
  "student-cross-subset": studentCrossSubset,
  "saved-sheet-invariants": savedSheetInvariants,
  "frozen-roster-search": frozenRosterSearch,
  "manual-publication": manualPublication,
  "answer-publish-policy": answerPublishPolicy,
  "scan-review-publication": scanReviewPublication,
  "score-progress": scoreProgress,
  "auth-lifecycle": authLifecycle,
  "conflict-prepare": conflictProof,
  "conflict-finish": conflictProof,
  "organization-checks": organizationChecks,
  "feedback-limits": feedbackLimits,
  "analysis-thresholds": analysisThresholds,
  "ladder-sample": prepareLadderSample,
  "ladder-cutoff": ladderCutoff,
  "correction-overlap": correctionOverlap,
  "cache-exam": prepareCacheExam,
  "weekly-demo": weeklyDemo,
  "matrix-exams": prepareMatrixExams,
  background: backgroundSettings,
  "key-lifecycle": scannerKeyLifecycle,
  formula: formulaChecks,
  "multi-arbitration": multiArbitration,
  "pdf-knowledge": pdfKnowledge,
  "review-repeat": reviewRepeat,
  "login-rate": loginRate,
  "ticket-expiry": ticketExpiry,
  "retention-setup": retentionSetup,
  "retention-restore": retentionRestore,
  "roster-decisions": rosterDecisions,
  "review-flow": reviewFlow,
  "student-ai": studentAnalysis,
  "ladder-gate": ladderGate,
  "analysis-reports": analysisReports,
  "backup-formats": backupFormats,
  "student-papers": studentPapers,
  governance: governance,
  "card-matrix": cardMatrix,
  papers: originalPapers,
  scopes: scopes,
  "rank-seed": seedRank,
  rank: rank,
  demo: demo,
  ai: ai,
  "ai-scope": aiScope,
  "ai-class-summaries": aiScope,
  console: consoleBuild,
  organization: organization,
  feedback: feedback,
  revision: paperRevision,
  answers: answerFiles,
};
assert.ok(
  Object.hasOwn(stages, stage),
  "Choose a service stage: " + Object.keys(stages).join(", "),
);
try {
  const seededExam = await call("/api/exams/" + state.examId);
  assert.equal(seededExam.card_id, state.cardId, "The service must contain this run's seeded card");
  assert.equal(seededExam.name, state.cardTitle);
  assert.equal(seededExam.class_id, state.cls.id);
  await stages[stage]();
  console.log("PASS", stage, evidence.length, "observations");
} finally {
  await fs.writeFile(
    path.join(root, "evidence", "service-" + stage + ".json"),
    JSON.stringify(evidence, null, 2),
  );
}
