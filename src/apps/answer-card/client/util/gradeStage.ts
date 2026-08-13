/**
 * 根据入学年份（如 2024级）推算当前高中阶段：高一/高二/高三。
 * 每年 9 月 1 日自动升一级；年级名不含 20xx 时返回 null。
 */
export function currentStage(gradeName: string, now = new Date()): string | null {
  const entry = Number(gradeName.match(/(20\d{2})/)?.[1]);
  if (!entry) return null;
  const schoolYearStart = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  const stage = schoolYearStart - entry + 1;
  return stage >= 1 && stage <= 3 ? ["高一", "高二", "高三"][stage - 1] : null;
}

// demo(): 自检（npm run verify:grade-stage）
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("gradeStage.ts")) {
  const cases: Array<[string, string, string | null]> = [
    ["2024级", "2026-08-13", "高二"],
    ["2024级", "2026-08-31", "高二"],
    ["2024级", "2026-09-01", "高三"],
    ["2025级", "2026-08-13", "高一"],
    ["2025级", "2026-09-01", "高二"],
    ["2026级", "2026-09-01", "高一"],
    ["2027级", "2026-09-01", null],
    ["2022级", "2026-09-01", null],
    ["高一", "2026-08-13", null],
  ];
  for (const [name, date, expected] of cases) {
    const actual = currentStage(name, new Date(date));
    if (actual !== expected) {
      throw new Error(`${name} @ ${date}: expected ${expected}, got ${actual}`);
    }
  }
  console.log(`gradeStage demo ok (${cases.length} cases)`);
}
