/* Project-X 离线静态演示 — 纯前端，数据来自 demo-data.json */

let DATA = null;
let currentRole = null;
let currentStudent = null;
let charts = {};

const TEACHER_NAV = [
  { id: "overview", icon: "📊", label: "数据概览" },
  { id: "single", icon: "📝", label: "单科成绩" },
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
  const res = await fetch("./demo-data.json");
  DATA = await res.json();
  bindGate();
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
  Object.values(charts).forEach((c) => c.destroy());
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

function computeRanks(exam, className) {
  let students = DATA.students;
  if (className) students = students.filter((s) => s.className === className);
  const rows = students.map((s) => {
    const score = getScore(exam, s.studentNo);
    return { ...s, score, absent: score === null };
  });
  const present = rows.filter((r) => !r.absent).sort((a, b) => b.score - a.score);
  const rankMap = new Map();
  let i = 0;
  while (i < present.length) {
    const score = present[i].score;
    let j = i;
    while (j < present.length && present[j].score === score) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) rankMap.set(present[k].studentNo, { rank, tieSize: j - i });
    i = j;
  }
  return rows.map((r) => ({
    ...r,
    rank: r.absent ? null : rankMap.get(r.studentNo)?.rank ?? null,
    tieSize: r.absent ? 0 : rankMap.get(r.studentNo)?.tieSize ?? 1
  }));
}

function rankBadge(rank, tieSize) {
  if (rank === null) return '<span class="absent-badge">缺考</span>';
  const cls = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "rank-other";
  const tie = tieSize > 1 ? " rank-tie" : "";
  return `<span class="rank-badge ${cls}${tie}">${rank}</span>`;
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
    <div class="grid md:grid-cols-2 gap-4">
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
    </div>
  </div>`;
  document.getElementById("mainContent").innerHTML = html;
}

function renderSingle() {
  document.getElementById("pageTitle").textContent = "单科成绩";
  const defaultExam = getExamByName("演示-数学");
  const options = DATA.exams
    .map((e) => `<option value="${e.cardId}" ${e.cardId === defaultExam.cardId ? "selected" : ""}>${e.name}</option>`)
    .join("");
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <div class="flex flex-wrap gap-3 items-center">
      <label class="text-sm font-medium">选择考试</label>
      <select id="examSelect" class="px-3 py-2 rounded-lg border border-slate-300">${options}</select>
    </div>
    <div id="singleTable"></div>
  </div>`;
  const sel = document.getElementById("examSelect");
  const render = () => renderSingleTable(sel.value);
  sel.addEventListener("change", render);
  render();
}

function renderSingleTable(cardId) {
  const exam = getExam(cardId);
  const rows = computeRanks(exam);
  const avg =
    rows.filter((r) => !r.absent).reduce((a, r) => a + r.score, 0) /
    Math.max(1, rows.filter((r) => !r.absent).length);
  const tieNote =
    exam.name === "演示-数学"
      ? '<p class="text-sm text-amber-700 bg-amber-50 rounded-lg p-3 mb-3">测试点：李华、王芳、吴敏、郑涛 四人 128 分并列，年排均为 <strong>第 6 名</strong>（橙框为并列）。</p>'
      : "";
  document.getElementById("singleTable").innerHTML = `${tieNote}
    <p class="text-sm text-slate-500 mb-3">平均分 ${avg.toFixed(1)} · 参考 ${rows.filter((r) => !r.absent).length} 人 · 缺考 ${rows.filter((r) => r.absent).length} 人</p>
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
      <table class="data-table">
        <thead><tr><th>年排</th><th>姓名</th><th>学号</th><th>班级</th><th>分数</th></tr></thead>
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
                  <td>${r.name}</td><td>${r.studentNo}</td><td>${r.className}</td>
                  <td>${r.absent ? '<span class="text-red-500">缺考</span>' : r.score}</td>
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
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
  const ranked = [...totals].sort((a, b) => b.total - a.total);
  const rankMap = new Map();
  let i = 0;
  while (i < ranked.length) {
    const t = ranked[i].total;
    let j = i;
    while (j < ranked.length && ranked[j].total === t) j++;
    const rank = i + 1;
    for (let k = i; k < j; k++) rankMap.set(ranked[k].studentNo, rank);
    i = j;
  }
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
          ${totals
            .sort((a, b) => b.total - a.total)
            .map(
              (r) =>
                `<tr>
                  <td>${rankBadge(rankMap.get(r.studentNo), 1)}</td>
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
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-6">
    <div class="bg-gradient-to-r from-violet-600 to-purple-600 rounded-xl p-6 text-white">
      <h3 class="text-xl font-bold">${DATA.crossExamGroup.name}</h3>
      <p class="text-violet-100 text-sm mt-1">按周打包 ${DATA.crossExamGroup.startDate} ~ ${DATA.crossExamGroup.endDate}</p>
    </div>
    ${statCards([
      { label: "周内考试", value: `${exams.length} 场` },
      { label: "注册学生", value: `${DATA.students.length} 人` },
      { label: "全勤参考", value: `${fullCount} 人`, hint: "化学缺周杰、生物缺沈婷" },
      { label: "缺考记录", value: "2 人次" }
    ])}
    <div class="bg-white rounded-xl p-5 border border-slate-100">
      <h4 class="font-bold mb-3">全勤学生总分（仅统计 6 科全考）</h4>
      <table class="data-table">
        <thead><tr><th>姓名</th><th>班级</th><th>6 科总分</th><th>状态</th></tr></thead>
        <tbody>
          ${fullRows
            .sort((a, b) => (b.full ? b.total : -1) - (a.full ? a.total : -1))
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
  const qs = exam.questionScores || {};
  document.getElementById("mainContent").innerHTML = `<div class="fade-in space-y-4">
    <p class="text-sm text-slate-600 bg-blue-50 rounded-lg p-3">${exam.name}：每位学生 Q1~Q5 客观题小分（每题满分 30），可用于导出测试。</p>
    <div class="bg-white rounded-xl shadow-sm border border-slate-100 overflow-x-auto">
      <table class="data-table">
        <thead>
          <tr><th>姓名</th><th>学号</th><th>总分</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>Q5</th></tr>
        </thead>
        <tbody>
          ${DATA.students
            .map((s) => {
              const total = getScore(exam, s.studentNo);
              const parts = qs[s.studentNo] || [];
              return `<tr>
                <td>${s.name}</td><td>${s.studentNo}</td><td>${total}</td>
                ${parts.map((p) => `<td>${p.score}/${p.max}</td>`).join("")}
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
    <p class="text-sm text-slate-500">以下场景与 <code>testdata/demo-exams/manifest.json</code> 一致，均可在本页离线验证。</p>
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
  document.getElementById("pageTitle").textContent = "名次变化";
  const prior = getExamByName("演示-数学月考");
  const current = getExamByName("演示-数学");
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
    <p class="text-sm text-slate-600">对比 <strong>演示-数学月考</strong> 与 <strong>演示-数学</strong> 的年级排名变化。</p>
    <div class="grid md:grid-cols-3 gap-4">
      <div class="bg-white rounded-xl p-5 border border-slate-100 text-center">
        <div class="text-sm text-slate-500">月考排名</div>
        <div class="text-3xl font-bold mt-2">${priorRank?.rank ?? "—"}</div>
        <div class="text-sm text-slate-400 mt-1">${priorScore} 分</div>
      </div>
      <div class="bg-white rounded-xl p-5 border border-slate-100 text-center">
        <div class="text-sm text-slate-500">本次排名</div>
        <div class="text-3xl font-bold mt-2">${currRank?.rank ?? "—"}</div>
        <div class="text-sm text-slate-400 mt-1">${currScore} 分</div>
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
  if (ctx) {
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
