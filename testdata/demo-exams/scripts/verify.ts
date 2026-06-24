/**
 * 演示数据导入后校验
 *
 * 用法: npx tsx testdata/demo-exams/scripts/verify.ts
 * 需已启动服务: npm run dev
 */

const BASE = process.env.PROJECTX_API_BASE ?? "http://127.0.0.1:5174";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

async function login(identifier: string, password: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password })
  });
  const d = await r.json();
  if (!d.token) throw new Error(`登录失败: ${identifier}`);
  return d.token;
}

async function main(): Promise<void> {
  console.log("演示数据校验\n");

  const health = await fetch(`${BASE}/api/app/health`).then((r) => r.json());
  ok(health.ok === true, "服务健康");

  const token = await login("admin", "admin123");
  const headers = { Authorization: `Bearer ${token}` };

  const grades = await fetch(`${BASE}/api/classes/grades`, { headers }).then((r) => r.json());
  const grade = grades.find((g: { name: string }) => g.name.includes("演示"));
  ok(Boolean(grade), `年级: ${grade?.name}`);

  const exams = await fetch(`${BASE}/api/exams?selection=1&grade_id=${grade.id}`, { headers }).then((r) => r.json());
  ok(exams.length >= 7, `考试 >= 7 (实际 ${exams.length})`);

  const week = exams.filter((e: { exam_date?: string }) => e.exam_date && e.exam_date >= "2026-06-16" && e.exam_date <= "2026-06-22");
  ok(week.length === 6, `周内考试 6 场 (实际 ${week.length})`);

  const cross = await fetch(`${BASE}/api/analysis/cross-exam/total`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "week", startDate: "2026-06-16", endDate: "2026-06-22", gradeId: grade.id })
  }).then((r) => r.json());
  ok(cross.summary?.examCount === 6, `跨考按周 6 场`);
  ok(cross.summary?.studentCount === 16, `跨考 16 人`);

  const math = exams.find((e: { subject: string }) => e.subject === "数学" && e.name.includes("数学月考") === false);
  if (math) {
    const table = await fetch(`${BASE}/api/analysis/exams/${math.id}/score-table`, { headers }).then((r) => r.json());
    const t128 = table.rows.filter((r: { totalScore: number }) => r.totalScore === 128);
    ok(t128.length >= 4, `数学 128 分 ${t128.length} 人`);
    const ranks = [...new Set(t128.map((r: { gradeRank: number }) => r.gradeRank))];
    if (ranks.length === 1) {
      ok(true, `并列排名: 年排均为 ${ranks[0]} (v1.5.0+)`);
    } else {
      console.log(`  ⚠ 顺序排名 ${ranks.join(",")} (v1.4.8 main；v1.5.0 应为同排)`);
    }
  }

  const groups = await fetch(`${BASE}/api/exam-groups`, { headers }).then((r) => r.json());
  const big = groups.find((g: { name: string }) => g.name.includes("摸底"));
  ok(Boolean(big), "大考合集存在");

  const crossGroups = await fetch(`${BASE}/api/analysis/cross-exam/groups`, { headers }).then((r) => r.json());
  const saved = crossGroups.find((g: { name: string }) => g.name.includes("第25周"));
  ok(Boolean(saved), "跨考已存组存在");
  ok((saved?.examIds?.length ?? 0) === 6, `已存组含 6 场 (实际 ${saved?.examIds?.length ?? 0})`);

  const stuToken = await login("20260102", "20260102");
  const scores = await fetch(`${BASE}/api/scores/me`, { headers: { Authorization: `Bearer ${stuToken}` } }).then((r) => r.json());
  ok(scores.scores?.length >= 7, `学生成绩 >= 7 科`);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
