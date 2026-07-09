/* Project-X 离线静态演示 — 纯前端，数据来自 demo-data.json
 * 对齐主站 v1.9 跨班深度对比（PR #163）与排名/百分位公式 A。
 */

let DATA = null;
let currentRole = null;
let currentStudent = null;
let charts = {};

const TEACHER_NAV = [
  { id: "overview", icon: "📊", label: "数据概览" },
  { id: "single", icon: "📝", label: "单科成绩" },
  { id: "classCompare", icon: "🏫", label: "跨班对比" },
  { id: "examGroup", icon: "📚", label: "大考合集" },
  { id: "crossExam", icon: "📅", label: "跨考分析" },
  { id: "questions", icon: "🔢", label: "客观题小分" },
  { id: "scenarios", icon: "✅", label: "测试场景" }
];

const STUDENT_NAV = [
  { id: "myScores", icon: "📉", label: "我的成绩" },
  { id: "rankChange", icon: "📈", label: "名次变化" },
  { id: "trend", icon: "💡", label: "成绩趋势" }
];

async function boot() {
  try {
    const res = await fetch("./demo-data.json");
    if (!res.ok) throw new Error(`加载 demo-data.json 失败 (${res.status})`);
    DATA = await res.json();
    bindGate();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#b91c1c">
      <h1>离线演示加载失败</h1>
      <p>${err instanceof Error ? err.message : String(err)}</p>
      <p><a href="/">返回主站</a></p>
    </div>`;
  }
}

function bindGate() {
  const btnTeacher = document.getElementById("btnTeacher");
  const btnStudent = document.getElementById("btnStudent");
  const enterBtn = document.getElementById("enterBtn");
  const studentPicker = document.getElementById("studentPicker");
  const studentSelect = document.getElementById("studentSelect");

  studentSelect.innerHTML = DATA.students
    .map((s) => `<option value="${s.id}">${s.name}（${s.studentNo} · ${s.className}）</option>`)
    .join("");

  function selectRole(role) {
    currentRole = role;
    [btnTeacher, btnStudent].forEach((btn) => {
      btn.classList.remove("border-blue-500", "bg-blue-50");
      btn.classList.add("border-slate-200");
    });
    (role === "teacher" ? btnTeacher : btnStudent).classList.add("border-blue-500", "bg-blue-50");
    studentPicker.classList.toggle("hidden", role !== "student");
    enterBtn.disabled = false;
  }

  btnTeacher.addEventListener("click", () => selectRole("teacher"));
  btnStudent.addEventListener("click", () => selectRole("student"));
  enterBtn.addEventListener("click", enterApp);
  document.getElementById("logoutBtn").addEventListener("click", () => location.reload());
}

function enterApp() {
  if (currentRole === "student") {
    const id = document.getElementById("studentSelect").value;
    currentStudent = DATA.students.find((s) => s.id === id);
    if (!currentStudent) {
      alert("请选择演示学生");
      return;
    }
  }
  document.getElementById("gatePage").classList.add("hidden");
  document.getElementById("appPage").classList.remove("hidden");
  document.getElementById("userRoleLabel").textContent = currentRole === "teacher" ? "教师端演示" : "学生端演示";
  document.getElementById("userName").textContent =
    currentRole === "teacher" ? DATA.accounts.teacher.name : currentStudent.name;
  initNav();
  const first = (currentRole === "teacher" ? TEACHER_NAV : STUDENT_NAV)[0].id;
  showSection(first);
}

function initNav() {
  const items = currentRole === "teacher" ? TEACHER_NAV : STUDENT_NAV;
  const nav = document.getElementById("sidebarNav");
  nav.innerHTML = items
    .map(
      (it) =>
        `<div class="sidebar-item px-6 py-3 flex items-center gap-3 text-sm font-medium text-slate-600" data-section="${it.id}">
          <span>${it.icon}</span><span>${it.label}</span>
        </div>`
    )
    .join("");
  nav.querySelectorAll(".sidebar-item").forEach((el) => {
    el.addEventListener("click", () => showSection(el.dataset.section));
  });

  const bar = document.getElementById("mobileTabBar");
  bar.innerHTML = items
    .map(
      (it) =>
        `<div class="tab-item" data-section="${it.id}">
          <span class="tab-icon">${it.icon}</span><span>${it.label}</span>
        </div>`
    )
    .join("");
  bar.querySelectorAll(".tab-item").forEach((el) => {
    el.addEventListener("click", () => showSection(el.dataset.section));
  });
}

function showSection(id) {
  document.querySelectorAll(".sidebar-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.section === id);
  });
  document.querySelectorAll("#mobileTabBar .tab-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.section === id);
  });
  destroyCharts();
  const renderers = {
    overview: renderOverview,
    single: renderSingle,
    classCompare: renderClassCompare,
    examGroup: renderExamGroup,
    crossExam: renderCrossExam,
    questions: renderQuestions,
    scenarios: renderScenarios,
    myScores: renderMyScores,
    rankChange: renderRankChange,
    trend: renderTrend
  };
  const fn = renderers[id];
  if (fn) fn();
}

function destroyCharts() {
  Object.values(charts).forEach((c) => {
    try {
      c.destroy();
    } catch {
      /* ignore */
    }
  });
  charts = {};
}

function getExam(cardId) {
  return DATA.exams.find((e) => e.cardId === cardId);
}

function getExamByName(name) {
  return DATA.exams.find((e) => e.name === name);
}

function getScore(exam, studentNo) {
  if (!exam || !exam.scores) return null;
  const v = exam.scores[studentNo];
  return v === undefined ? null : v;
}

/** 与 src/server/services/rankingUpdate.ts 公式 A 一致 */
function rankPercentile(rank, total) {
  if (total <= 1) return 100;
  const raw = ((total - rank) / (total - 1)) * 100;
  return Math.max(0, Math.round(raw * 10) / 10);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** competition ranking：同分并列，下一名跳号（1,2,2,4） */
function assignCompetitionRanks(sortedRows, scoreKey) {
  const rankMap = new Map();
  const tieSizeMap = new Map();
  let i = 0;
  while (i < sortedRows.length) {
    const score = sortedRows[i][scoreKey];
    let j = i;
    while (j < sortedRows.length && sortedRows[j][scoreKey] === score) j++;
    const rank = i + 1;
    const tieSize = j - i;
    for (let k = i; k < j; k++) {
      rankMap.set(sortedRows[k].studentNo, rank);
      tieSizeMap.set(sortedRows[k].studentNo, tieSize);
    }
    i = j;
  }
  return { rankMap, tieSizeMap };
}

function computeRanks(exam, className) {
  let students = DATA.students;
  if (className) students = students.filter((s) => s.className === className);
  const rows = students.map((s) => {
    const score = getScore(exam, s.studentNo);
    return { ...s, score, absent: score === null };
  });
  const present = rows.filter((r) => !r.absent).sort((a, b) => b.score - a.score);
  const { rankMap, tieSizeMap } = assignCompetitionRanks(present, "score");
  const presentCount = present.length;
  return rows.map((r) => {
    const rank = r.absent ? null : rankMap.get(r.studentNo) ?? null;
    return {
      ...r,
      rank,
      tieSize: r.absent ? 0 : tieSizeMap.get(r.studentNo) ?? 1,
      percentile: rank === null ? null : rankPercentile(rank, presentCount)
    };
  });
}

function rankBadge(rank, tieSize) {
  if (rank === null || rank === undefined) return '<span class="absent-badge">缺考</span>';
  const cls = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "rank-other";
  const tie = tieSize > 1 ? " rank-tie" : "";
  return `<span class="rank-badge ${cls}${tie}">${rank}</span>`;
}

function rateColor(rate) {
  if (rate == null || !Number.isFinite(rate)) return "#64748b";
  if (rate >= 80) return "#3B6D11";
  if (rate >= 60) return "#0f172a";
  if (rate >= 40) return "#B45309";
  return "#A32D2D";
}

function rateBg(rate) {
  if (rate == null || !Number.isFinite(rate)) return "transparent";
  if (rate >= 80) return "rgba(59, 109, 17, 0.10)";
  if (rate >= 60) return "transparent";
  if (rate >= 40) return "rgba(180, 83, 9, 0.10)";
  return "rgba(163, 45, 45, 0.12)";
}

function formatDelta(value) {
  if (value == null || value === 0) return { text: "—", color: "#64748b" };
  if (value > 0) return { text: `↑+${value}`, color: "#3B6D11" };
  return { text: `↓${value}`, color: "#A32D2D" };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function scoreSummary(scores) {
  if (!scores.length) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: round1(sorted[0]),
    q1: round1(percentile(sorted, 0.25)),
    median: round1(percentile(sorted, 0.5)),
    q3: round1(percentile(sorted, 0.75)),
    max: round1(sorted[sorted.length - 1]),
    avg: round1(sum / sorted.length),
    count: sorted.length
  };
}

function classStatsForExam(exam, className) {
  const students = DATA.students.filter((s) => s.className === className);
  const scores = students
    .map((s) => getScore(exam, s.studentNo))
    .filter((v) => v !== null);
  const summary = scoreSummary(scores);
  const full = exam.fullScore || 100;
  const passLine = full * 0.6;
  const excellentLine = full * 0.9;
  const passCount = scores.filter((s) => s >= passLine).length;
  const excellentCount = scores.filter((s) => s >= excellentLine).length;
  const avg = summary?.avg ?? 0;
  const variance =
    scores.length > 0 ? scores.reduce((a, s) => a + (s - avg) ** 2, 0) / scores.length : 0;
  return {
    className,
    gradedCount: scores.length,
    avgScore: avg,
    maxScore: summary?.max ?? 0,
    minScore: summary?.min ?? 0,
    median: summary?.median ?? 0,
    stdDev: round1(Math.sqrt(variance)),
    passRate: scores.length ? Math.round((passCount / scores.length) * 100) : 0,
    excellentRate: scores.length ? Math.round((excellentCount / scores.length) * 100) : 0,
    scoreSummary: summary
  };
}

function questionRatesByClass(exam, className) {
  const qs = exam.questionScores || {};
  const students = DATA.students.filter((s) => s.className === className);
  const byQ = new Map();
  for (const s of students) {
    const parts = qs[s.studentNo];
    if (!parts) continue;
    for (const p of parts) {
      if (!byQ.has(p.q)) byQ.set(p.q, { scores: [], max: p.max });
      byQ.get(p.q).scores.push(p.score);
    }
  }
  return Array.from(byQ.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([q, info]) => {
      const avg = info.scores.reduce((a, b) => a + b, 0) / Math.max(1, info.scores.length);
      const scoreRate = info.max > 0 ? Math.round((avg / info.max) * 100) : 0;
      return {
        questionNumber: String(q),
        maxScore: info.max,
        avgScore: round1(avg),
        scoreRate,
        totalCount: info.scores.length
      };
    });
}

function knowledgeRatesByClass(exam, className) {
  const points = (DATA.knowledgePoints && DATA.knowledgePoints[exam.cardId]) || [];
  const qRates = questionRatesByClass(exam, className);
  const qMap = new Map(qRates.map((q) => [q.questionNumber, q]));
  return points.map((kp) => {
    const rates = kp.questionNumbers
      .map((n) => qMap.get(String(n)))
      .filter(Boolean);
    const avgRate =
      rates.length > 0
        ? round1(rates.reduce((a, r) => a + r.scoreRate, 0) / rates.length)
        : null;
    return {
      pointText: kp.pointText,
      questionNumbers: kp.questionNumbers.join(","),
      avgRate,
      studentCount: rates[0]?.totalCount ?? 0
    };
  });
}

function statCards(items) {
  return `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">${items
    .map(
      (it) =>
        `<div class="bg-white rounded-xl p-5 shadow-sm border border-slate-100 card-hover">
          <div class="text-slate-500 text-sm">${it.label}</div>
          <div class="text-2xl font-bold text-slate-800 mt-1">${it.value}</div>
          ${it.hint ? `<div class="text-xs text-slate-400 mt-1">${it.hint}</div>` : ""}
        </div>`
    )
    .join("")}</div>`;
}

function renderOverview() {
  document.getElementById("pageTitle").textContent = "数据概览";
  const weekExams = DATA.exams.filter((e) => DATA.crossExamGroup.examCardIds.includes(e.cardId));
  const math = getExamByName("演示-数学");
  const tie128 = math ? Object.entries(math.scores).filter(([, v]) => v === 128).length : 0;
  const html = `<div class="fade-in space-y-6">
    ${statCards([
      { label: "年级", value: DATA.grade },
      { label: "班级 / 学生", value: `${DATA.classes.length} 班 · ${DATA.students.length} 人` },
      { label: "演示考试", value: `${DATA.exams.length} 场` },
      { label: "数学 128 并列", value: `${tie128} 人`, hint: "年排均为第 6 名" }
    ])}
    <div class="bg-white rounded-xl p-6 shadow-sm border border-slate-100">
      <h3 class="font-bold mb-4">考试列表</h3>
      <div class="overflow-x-auto">
        <table class="data-table">
          <thead><tr><th>考试</th><th>科目</th><th>日期</th><th>满分</th><th>参考人数</th></tr></thead>
          <tbody>
            ${DATA.exams
              .map((e) => {
                const count = Object.keys(e.scores).length;
                return `<tr><td>${e.name}</td><td>${e.subject}</td><td>${e.examDate}</td><td>${e.fullScore}</td><td>${count}</td></tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </div>
    </div>
    <div class="grid md:grid-cols-3 gap-4">
      <div class="bg-white rounded-xl p-5 border border-slate-100">
        <h4 class="font-bold text-blue-700 mb-2">大考合集</h4>
        <p class="text-sm text-slate-600">${DATA.examGroup.name}</p>
        <p class="text-xs text-slate-400 mt-1">${DATA.examGroup.description}</p>
      </div>
      <div class="bg-white rounded-xl p-5 border border-slate-100">
        <h4 class="font-bold text-indigo-700 mb-2">跨考已存组</h4>
        <p class="text-sm text-slate-600">${DATA.crossExamGroup.name}</p>
        <p class="text-xs text-slate-400 mt-1">${DATA.crossExamGroup.startDate} ~ ${DATA.crossExamGroup.endDate} · ${weekExams.length} 场</p>
      </div>
      <div class="bg-white rounded-xl p-5 border border-slate-100">
        <h4 class="font-bold text-emerald-700 mb-2">跨班深度对比</h4>
        <p class="text-sm text-slate-600">对齐主站 class-compare API</p>
        <p class="text-xs text-slate-400 mt-1">均分 / 题目矩阵 / 知识点弱项</p>
      </div>
    </div>
  </div>`;
  document.getElementById("mainContent").innerHTML = html;
}

function renderSingle() {
  document.getElementById("pageTitle").textContent = "单科成绩";
  const defaultExam = getExamByName("演示-数学") || DATA.exams[0];
  if (!defaultExam) {
    document.getElementById("mainContent").innerHTML = `<p class="text-slate-500">暂无考试数据</p>`;
    return;
  }
  const options = DATA.exams
    .map((e) => `<option value="${e.cardId}" ${e.cardId === defaultExam.cardId ? "selected" : ""}>${e.name}</option>`)
    .join("");
  const classOptions = [
    `<option value="">全部班级</option>`,
    ...DATA.classes.map((c) => `<option value="${c}">${c}</option>`)
  ].join("");
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <div class="flex flex-wrap gap-3 items-center">
      <label class="text-sm font-medium">选择考试</label>
      <select id="examSelect" class="px-3 py-2 rounded-lg border border-slate-300">${options}</select>
      <label class="text-sm font-medium">班级</label>
      <select id="classSelect" class="px-3 py-2 rounded-lg border border-slate-300">${classOptions}</select>
    </div>
    <div id="singleTable"></div>
  </div>`;
  const sel = document.getElementById("examSelect");
  const classSel = document.getElementById("classSelect");
  const render = () => renderSingleTable(sel.value, classSel.value || null);
  sel.addEventListener("change", render);
  classSel.addEventListener("change", render);
  render();
}

function renderSingleTable(cardId, className) {
  const exam = getExam(cardId);
  if (!exam) {
    document.getElementById("singleTable").innerHTML = `<p class="text-red-600 text-sm">未找到考试</p>`;
    return;
  }
  const rows = computeRanks(exam, className);
  const present = rows.filter((r) => !r.absent);
  const avg = present.reduce((a, r) => a + r.score, 0) / Math.max(1, present.length);
  const scope = className ? `${className} · ` : "年级 · ";
  const tieNote =
    exam.name === "演示-数学" && !className
      ? '<p class="text-sm text-amber-700 bg-amber-50 rounded-lg p-3 mb-3">测试点：李华、王芳、吴敏、郑涛 四人 128 分并列，年排均为 <strong>第 6 名</strong>（橙框为并列）；百分位按公式 A 与主站一致。</p>'
      : "";
  document.getElementById("singleTable").innerHTML = `${tieNote}
    <p class="text-sm text-slate-500 mb-3">${scope}平均分 ${avg.toFixed(1)} · 参考 ${present.length} 人 · 缺考 ${rows.filter((r) => r.absent).length} 人</p>
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
      <table class="data-table">
        <thead><tr><th>年排</th><th>百分位</th><th>姓名</th><th>学号</th><th>班级</th><th>分数</th></tr></thead>
        <tbody>
          ${rows
            .sort((a, b) => {
              if (a.absent !== b.absent) return a.absent ? 1 : -1;
              return (a.rank ?? 99) - (b.rank ?? 99);
            })
            .map(
              (r) =>
                `<tr>
                  <td>${rankBadge(r.rank, r.tieSize)}</td>
                  <td>${r.percentile === null ? "—" : `${r.percentile}%`}</td>
                  <td>${r.name}</td><td>${r.studentNo}</td><td>${r.className}</td>
                  <td>${r.absent ? '<span class="text-red-500">缺考</span>' : r.score}</td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

/** 跨班深度对比 — 对齐主站 AnalysisClassCompare / class-compare API */
function renderClassCompare() {
  document.getElementById("pageTitle").textContent = "跨班深度对比";
  const defaultExam = getExamByName("演示-数学") || DATA.exams.find((e) => e.questionScores) || DATA.exams[0];
  if (!defaultExam) {
    document.getElementById("mainContent").innerHTML = `<p class="text-slate-500">暂无考试数据</p>`;
    return;
  }
  const examOptions = DATA.exams
    .map((e) => `<option value="${e.cardId}" ${e.cardId === defaultExam.cardId ? "selected" : ""}>${e.name}</option>`)
    .join("");
  const baselineOptions = [
    `<option value="">不设基准</option>`,
    ...DATA.classes.map((c) => `<option value="${c}">${c}</option>`)
  ].join("");

  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <p class="text-sm text-slate-600 bg-emerald-50 border border-emerald-100 rounded-lg p-3">
      对齐主站 <code>GET /api/analysis/exams/:id/class-compare</code>：班级概况、题目得分率矩阵、知识点弱项对比（离线静态计算）。
    </p>
    <div class="flex flex-wrap gap-3 items-center">
      <label class="text-sm font-medium">考试</label>
      <select id="ccExamSelect" class="px-3 py-2 rounded-lg border border-slate-300">${examOptions}</select>
      <label class="text-sm font-medium">基准班级</label>
      <select id="ccBaseline" class="px-3 py-2 rounded-lg border border-slate-300">${baselineOptions}</select>
    </div>
    <div id="ccBody"></div>
  </div>`;

  const examSel = document.getElementById("ccExamSelect");
  const baseSel = document.getElementById("ccBaseline");
  const render = () => renderClassCompareBody(examSel.value, baseSel.value || null);
  examSel.addEventListener("change", render);
  baseSel.addEventListener("change", render);
  render();
}

function renderClassCompareBody(cardId, baselineClassName) {
  const exam = getExam(cardId);
  const body = document.getElementById("ccBody");
  if (!exam) {
    body.innerHTML = `<p class="text-red-600 text-sm">未找到考试</p>`;
    return;
  }

  const classStats = DATA.classes.map((c) => classStatsForExam(exam, c));
  const baseline = baselineClassName
    ? classStats.find((c) => c.className === baselineClassName) || null
    : null;

  const questionMatrix = (() => {
    const allQ = new Set();
    const byClass = {};
    for (const c of DATA.classes) {
      const rates = questionRatesByClass(exam, c);
      byClass[c] = new Map(rates.map((r) => [r.questionNumber, r]));
      rates.forEach((r) => allQ.add(r.questionNumber));
    }
    return Array.from(allQ)
      .sort((a, b) => Number(a) - Number(b))
      .map((qn) => {
        const sample = DATA.classes.map((c) => byClass[c].get(qn)).find(Boolean);
        const byClassCells = {};
        for (const c of DATA.classes) {
          const cell = byClass[c].get(qn);
          if (cell) byClassCells[c] = cell;
        }
        const rates = Object.values(byClassCells).map((c) => c.scoreRate);
        const spread =
          rates.length >= 2 ? round1(Math.max(...rates) - Math.min(...rates)) : null;
        return {
          questionNumber: qn,
          maxScore: sample?.maxScore ?? 0,
          byClass: byClassCells,
          spread
        };
      });
  })();

  const knowledgeMatrix = (() => {
    const points = (DATA.knowledgePoints && DATA.knowledgePoints[exam.cardId]) || [];
    return points.map((kp) => {
      const byClass = {};
      for (const c of DATA.classes) {
        const row = knowledgeRatesByClass(exam, c).find((k) => k.pointText === kp.pointText);
        if (row) byClass[c] = row;
      }
      return {
        pointText: kp.pointText,
        questionNumbers: kp.questionNumbers.join(","),
        byClass
      };
    });
  })();

  const hasQuestions = questionMatrix.length > 0;
  const hasKnowledge = knowledgeMatrix.length > 0;

  body.innerHTML = `
    <div class="bg-white rounded-xl p-5 shadow-sm border border-slate-100 mb-4">
      <div class="text-sm font-semibold text-slate-600 mb-3">均分 / 及格率 / 优秀率</div>
      <canvas id="ccChart" height="100"></canvas>
    </div>

    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-x-auto mb-4">
      <table class="data-table">
        <thead>
          <tr>
            <th>班级</th><th>人数</th><th>均分</th>
            ${baseline ? `<th>vs ${baseline.className}</th>` : ""}
            <th>最高</th><th>最低</th><th>中位</th><th>标准差</th><th>及格率</th><th>优秀率</th>
          </tr>
        </thead>
        <tbody>
          ${classStats
            .map((cs) => {
              const isBase = baseline && cs.className === baseline.className;
              const avgDiff = baseline ? round1(cs.avgScore - baseline.avgScore) : null;
              const delta = formatDelta(isBase ? null : avgDiff);
              return `<tr style="${isBase ? "background:#eff6ff" : ""}">
                <td class="font-medium">${cs.className}${isBase ? " ·基准" : ""}</td>
                <td>${cs.gradedCount}</td>
                <td>${cs.avgScore}</td>
                ${baseline ? `<td style="color:${delta.color};font-weight:500">${delta.text}</td>` : ""}
                <td>${cs.maxScore}</td>
                <td>${cs.minScore}</td>
                <td>${cs.median}</td>
                <td>${cs.stdDev}</td>
                <td style="color:${rateColor(cs.passRate)}">${cs.passRate}%</td>
                <td style="color:${rateColor(cs.excellentRate)}">${cs.excellentRate}%</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="mb-4">
      <div class="text-sm font-semibold text-slate-600 mb-2">题目得分率矩阵</div>
      ${
        !hasQuestions
          ? `<div class="text-sm text-slate-500 bg-slate-50 border border-dashed border-slate-200 rounded-lg p-4">本场考试无客观题小分数据 — 请选择「演示-数学」查看 Q1~Q5 矩阵</div>`
          : `<div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-x-auto">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>题号</th><th>满分</th>
                    ${DATA.classes.map((c) => `<th>${c}</th>`).join("")}
                    ${DATA.classes.length >= 2 ? "<th>班间落差</th>" : ""}
                  </tr>
                </thead>
                <tbody>
                  ${questionMatrix
                    .map((row) => {
                      return `<tr>
                        <td class="font-semibold">Q${row.questionNumber}</td>
                        <td>${row.maxScore}</td>
                        ${DATA.classes
                          .map((c) => {
                            const cell = row.byClass[c];
                            const rate = cell?.scoreRate;
                            return `<td style="text-align:center;font-weight:500;color:${rateColor(rate)};background:${rateBg(rate)}" title="${cell ? `均分 ${cell.avgScore}` : ""}">${rate != null ? `${rate}%` : "—"}</td>`;
                          })
                          .join("")}
                        ${
                          DATA.classes.length >= 2
                            ? `<td style="color:${row.spread != null && row.spread >= 20 ? "#A32D2D" : "#64748b"};font-weight:${row.spread != null && row.spread >= 20 ? 600 : 400}">${row.spread != null ? `${row.spread}pp` : "—"}</td>`
                            : ""
                        }
                      </tr>`;
                    })
                    .join("")}
                </tbody>
              </table>
            </div>`
      }
    </div>

    <div>
      <div class="text-sm font-semibold text-slate-600 mb-2">知识点得分率对比</div>
      ${
        !hasKnowledge
          ? `<div class="text-sm text-slate-500 bg-slate-50 border border-dashed border-slate-200 rounded-lg p-4">本场考试尚未标注知识点 — 「演示-数学」含函数与导数 / 立体几何 / 概率统计</div>`
          : `<div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-x-auto">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>知识点</th><th>题号</th>
                    ${DATA.classes.map((c) => `<th>${c}</th>`).join("")}
                  </tr>
                </thead>
                <tbody>
                  ${knowledgeMatrix
                    .map(
                      (row) => `<tr>
                        <td class="font-medium">${row.pointText}</td>
                        <td class="text-slate-500">${row.questionNumbers}</td>
                        ${DATA.classes
                          .map((c) => {
                            const cell = row.byClass[c];
                            const rate = cell?.avgRate;
                            return `<td style="text-align:center;font-weight:500;color:${rateColor(rate)};background:${rateBg(rate)}">${rate != null ? `${rate}%` : "—"}</td>`;
                          })
                          .join("")}
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
      }
    </div>
  `;

  const ctx = document.getElementById("ccChart");
  if (ctx && typeof Chart !== "undefined") {
    charts.cc = new Chart(ctx, {
      type: "bar",
      data: {
        labels: classStats.map((c) => c.className),
        datasets: [
          { label: "均分", data: classStats.map((c) => c.avgScore), backgroundColor: "#C00F28", borderRadius: 6 },
          { label: "及格率%", data: classStats.map((c) => c.passRate), backgroundColor: "#3B82F6", borderRadius: 6 },
          { label: "优秀率%", data: classStats.map((c) => c.excellentRate), backgroundColor: "#10B981", borderRadius: 6 }
        ]
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, grid: { color: "rgba(0,0,0,0.04)" } }, x: { grid: { display: false } } },
        plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } }
      }
    });
  }
}

function renderExamGroup() {
  document.getElementById("pageTitle").textContent = "大考合集";
  const exams = DATA.examGroup.examCardIds.map(getExam).filter(Boolean);
  const subjects = exams.map((e) => e.subject);
  const totals = DATA.students.map((s) => {
    let total = 0;
    let missing = 0;
    const sub = {};
    for (const e of exams) {
      const sc = getScore(e, s.studentNo);
      sub[e.subject] = sc;
      if (sc === null) missing++;
      else total += sc;
    }
    return { ...s, total, missing, sub };
  });
  const ranked = [...totals].sort((a, b) => b.total - a.total || a.studentNo.localeCompare(b.studentNo));
  const { rankMap, tieSizeMap } = assignCompetitionRanks(ranked, "total");
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-6">
    <div class="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl p-6 text-white">
      <h3 class="text-xl font-bold">${DATA.examGroup.name}</h3>
      <p class="text-blue-100 text-sm mt-1">${DATA.examGroup.description}</p>
    </div>
    ${statCards([
      { label: "包含科目", value: subjects.join("、") },
      { label: "考试场次", value: `${exams.length} 科` },
      { label: "总分模式", value: "原始分累加" }
    ])}
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr><th>总排</th><th>姓名</th><th>班级</th>${subjects.map((s) => `<th>${s}</th>`).join("")}<th>总分</th></tr>
        </thead>
        <tbody>
          ${ranked
            .map(
              (r) =>
                `<tr>
                  <td>${rankBadge(rankMap.get(r.studentNo), tieSizeMap.get(r.studentNo) ?? 1)}</td>
                  <td>${r.name}</td><td>${r.className}</td>
                  ${subjects
                    .map((sub) => {
                      const v = r.sub[sub];
                      return `<td>${v === null ? '<span class="text-red-400">—</span>' : v}</td>`;
                    })
                    .join("")}
                  <td class="font-semibold">${r.total}</td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderCrossExam() {
  document.getElementById("pageTitle").textContent = "跨考分析";
  const exams = DATA.crossExamGroup.examCardIds.map(getExam).filter(Boolean);
  const fullRows = DATA.students.map((s) => {
    const scores = exams.map((e) => getScore(e, s.studentNo));
    const full = scores.every((v) => v !== null);
    const total = scores.reduce((a, v) => a + (v ?? 0), 0);
    return { ...s, scores, full, total };
  });
  const fullCount = fullRows.filter((r) => r.full).length;
  const absentCount = DATA.students.length * exams.length - fullRows.reduce((a, r) => a + r.scores.filter((v) => v !== null).length, 0);
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-6">
    <div class="bg-gradient-to-r from-violet-600 to-purple-600 rounded-xl p-6 text-white">
      <h3 class="text-xl font-bold">${DATA.crossExamGroup.name}</h3>
      <p class="text-violet-100 text-sm mt-1">按周打包 ${DATA.crossExamGroup.startDate} ~ ${DATA.crossExamGroup.endDate}</p>
    </div>
    ${statCards([
      { label: "周内考试", value: `${exams.length} 场` },
      { label: "注册学生", value: `${DATA.students.length} 人` },
      { label: "全勤参考", value: `${fullCount} 人`, hint: "化学缺周杰、生物缺沈婷" },
      { label: "缺考记录", value: `${absentCount} 人次` }
    ])}
    <div class="bg-white rounded-xl p-5 border border-slate-100">
      <h4 class="font-bold mb-3">全勤学生总分（仅统计 6 科全考）</h4>
      <table class="data-table">
        <thead><tr><th>姓名</th><th>班级</th><th>6 科总分</th><th>状态</th></tr></thead>
        <tbody>
          ${fullRows
            .sort((a, b) => {
              if (a.full !== b.full) return a.full ? -1 : 1;
              return b.total - a.total;
            })
            .map(
              (r) =>
                `<tr>
                  <td>${r.name}</td><td>${r.className}</td>
                  <td>${r.full ? r.total : "—"}</td>
                  <td>${r.full ? '<span class="text-emerald-600 text-sm">全勤</span>' : '<span class="absent-badge">非全勤</span>'}</td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderQuestions() {
  document.getElementById("pageTitle").textContent = "客观题小分";
  const exam = getExamByName("演示-数学");
  if (!exam) {
    document.getElementById("mainContent").innerHTML = `<p class="text-slate-500">未找到演示-数学</p>`;
    return;
  }
  const qs = exam.questionScores || {};
  const qHeaders = [1, 2, 3, 4, 5];
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <p class="text-sm text-slate-600 bg-blue-50 rounded-lg p-3">${exam.name}：每位学生 Q1~Q5 客观题小分（每题满分 30），可用于导出测试与跨班题目矩阵。</p>
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr><th>姓名</th><th>学号</th><th>班级</th><th>总分</th>${qHeaders.map((q) => `<th>Q${q}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${DATA.students
            .map((s) => {
              const total = getScore(exam, s.studentNo);
              const parts = qs[s.studentNo] || [];
              const byQ = new Map(parts.map((p) => [p.q, p]));
              return `<tr>
                <td>${s.name}</td><td>${s.studentNo}</td><td>${s.className}</td><td>${total ?? "—"}</td>
                ${qHeaders
                  .map((q) => {
                    const p = byQ.get(q);
                    return `<td>${p ? `${p.score}/${p.max}` : "—"}</td>`;
                  })
                  .join("")}
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderScenarios() {
  document.getElementById("pageTitle").textContent = "测试场景";
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <p class="text-sm text-slate-500">以下场景与 <code>testdata/demo-exams</code> 一致，均可在本页离线验证（含跨班深度对比）。</p>
    ${DATA.testScenarios
      .map(
        (s) =>
          `<div class="scenario-card bg-white rounded-xl p-5 shadow-sm border border-slate-100">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">${s.feature}</span>
              <span class="text-xs text-slate-400">${s.id}</span>
            </div>
            ${s.steps ? `<p class="text-sm text-slate-600 mb-1">路径：${s.steps}</p>` : ""}
            <p class="text-sm text-slate-800">预期：${s.expect}</p>
          </div>`
      )
      .join("")}
  </div>`;
}

function renderMyScores() {
  const stu = currentStudent;
  if (!stu) return;
  document.getElementById("pageTitle").textContent = "我的成绩";
  const rows = DATA.exams
    .map((e) => ({ exam: e, score: getScore(e, stu.studentNo) }))
    .filter((r) => r.score !== null || ["演示-化学", "演示-生物"].includes(r.exam.name));
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <div class="bg-white rounded-xl p-5 border border-slate-100">
      <h3 class="font-bold">${stu.name}</h3>
      <p class="text-sm text-slate-500">${stu.className} · ${stu.studentNo}</p>
    </div>
    <table class="data-table bg-white rounded-xl shadow-sm border border-slate-100">
      <thead><tr><th>考试</th><th>科目</th><th>日期</th><th>分数</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r) =>
              `<tr>
                <td>${r.exam.name}</td><td>${r.exam.subject}</td><td>${r.exam.examDate}</td>
                <td>${r.score === null ? '<span class="absent-badge">缺考</span>' : r.score}</td>
              </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function renderRankChange() {
  const stu = currentStudent;
  if (!stu) return;
  document.getElementById("pageTitle").textContent = "名次变化";
  const prior = getExamByName("演示-数学月考");
  const current = getExamByName("演示-数学");
  if (!prior || !current) {
    document.getElementById("mainContent").innerHTML = `<p class="text-slate-500">缺少月考或本次数学考试数据</p>`;
    return;
  }
  const priorRank = computeRanks(prior).find((r) => r.studentNo === stu.studentNo);
  const currRank = computeRanks(current).find((r) => r.studentNo === stu.studentNo);
  const priorScore = getScore(prior, stu.studentNo);
  const currScore = getScore(current, stu.studentNo);
  const delta =
    priorRank?.rank != null && currRank?.rank != null ? priorRank.rank - currRank.rank : null;
  let deltaText = "—";
  let deltaClass = "text-slate-600";
  if (delta !== null) {
    if (delta > 0) {
      deltaText = `↑ ${delta} 名`;
      deltaClass = "text-emerald-600";
    } else if (delta < 0) {
      deltaText = `↓ ${Math.abs(delta)} 名`;
      deltaClass = "text-red-600";
    } else {
      deltaText = "持平";
      deltaClass = "text-slate-600";
    }
  }
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-6">
    <p class="text-sm text-slate-600">对比 <strong>演示-数学月考</strong> 与 <strong>演示-数学</strong> 的年级排名变化（百分位公式 A）。</p>
    <div class="grid md:grid-cols-3 gap-4">
      <div class="bg-white rounded-xl p-5 border border-slate-100 text-center">
        <div class="text-sm text-slate-500">月考排名</div>
        <div class="text-3xl font-bold mt-2">${priorRank?.rank ?? "—"}</div>
        <div class="text-sm text-slate-400 mt-1">${priorScore} 分 · 百分位 ${priorRank?.percentile ?? "—"}${priorRank?.percentile != null ? "%" : ""}</div>
      </div>
      <div class="bg-white rounded-xl p-5 border border-slate-100 text-center">
        <div class="text-sm text-slate-500">本次排名</div>
        <div class="text-3xl font-bold mt-2">${currRank?.rank ?? "—"}</div>
        <div class="text-sm text-slate-400 mt-1">${currScore} 分 · 百分位 ${currRank?.percentile ?? "—"}${currRank?.percentile != null ? "%" : ""}</div>
      </div>
      <div class="bg-white rounded-xl p-5 border border-slate-100 text-center">
        <div class="text-sm text-slate-500">名次变化</div>
        <div class="text-3xl font-bold mt-2 ${deltaClass}">${deltaText}</div>
      </div>
    </div>
  </div>`;
}

function renderTrend() {
  const stu = currentStudent;
  if (!stu) return;
  document.getElementById("pageTitle").textContent = "成绩趋势";
  const weekExams = DATA.exams.filter((e) => DATA.crossExamGroup.examCardIds.includes(e.cardId));
  const labels = weekExams.map((e) => e.subject);
  const scores = weekExams.map((e) => getScore(e, stu.studentNo));
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-6">
    <div class="bg-white rounded-xl p-6 shadow-sm border border-slate-100">
      <h3 class="font-bold mb-4">${stu.name} · 第 25 周各科成绩</h3>
      <canvas id="trendChart" height="120"></canvas>
    </div>
    <table class="data-table bg-white rounded-xl shadow-sm border border-slate-100">
      <thead><tr><th>科目</th><th>考试</th><th>分数</th><th>满分</th></tr></thead>
      <tbody>
        ${weekExams
          .map((e) => {
            const sc = getScore(e, stu.studentNo);
            return `<tr><td>${e.subject}</td><td>${e.name}</td><td>${sc === null ? "缺考" : sc}</td><td>${e.fullScore}</td></tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </div>`;
  const ctx = document.getElementById("trendChart");
  if (ctx && typeof Chart !== "undefined") {
    charts.trend = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "得分",
            data: scores.map((v) => (v === null ? null : v)),
            borderColor: "#2563eb",
            backgroundColor: "rgba(37,99,235,0.1)",
            fill: true,
            tension: 0.35,
            spanGaps: true
          }
        ]
      },
      options: { responsive: true, scales: { y: { beginAtZero: false } } }
    });
  }
}

boot();
