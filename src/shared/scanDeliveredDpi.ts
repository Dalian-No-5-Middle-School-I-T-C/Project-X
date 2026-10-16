/**
 * 用扫描桥接已经回报的像素尺寸反查「实际出图密度」，用来核对软件里设定的 DPI 是否真的生效。
 *
 * 为什么要在 TS 侧反查：TWAIN 的 MSG_SET 返回成功只代表「请求被接受」，驱动完全可能
 * 按自己的档位替代（甚至因为 ICAP_UNITS 是厘米而把 300 读成 300 点/厘米）。native 侧
 * 已加 MSG_GETCURRENT 回读，但随包 exe 未必重编译，反查这一步对**现网正在用的 exe** 也成立。
 */

export type ScanPaperSizeName = "A4" | "Letter" | "A3";

/** 纸型短边×长边（英寸），与 native 里 ICAP_SUPPORTEDSIZES 选的档位一一对应 */
export const SCAN_PAPER_INCHES: Record<ScanPaperSizeName, readonly [number, number]> = {
  A4: [8.27, 11.69],
  Letter: [8.5, 11.0],
  A3: [11.69, 16.54]
};

/** 扫描端可选的 DPI 档位（ScannerPanel 的取档），用于给出「改成多少重扫」的建议 */
export const SCAN_DPI_STEPS = [150, 200, 300, 400, 600] as const;

/** 长短边两个方向推出的密度彼此相差超过该比例时，说明图像长宽比与所选纸型对不上（进纸裁切、
 *  扫了别的纸型），此页不参与判定——宁可不下结论，也不要把尺寸问题报成 DPI 问题。 */
const ASPECT_TOLERANCE = 0.2;

/** 实际密度与设定值偏差超过该比例才判定「设定未生效」。
 *  驱动常见替代是降到自己的最高档（300→200 差 33%、300→240 差 25%），都能被抓住；
 *  而纸型替代（A4↔Letter 约 2.7%）与出图留边裁剪（通常 <5%）不会误报。 */
const DPI_TOLERANCE = 0.15;

/** 反查结果的合理区间：超出即认为尺寸数据不可用（异常 exe 输出、非常规纸型）。 */
const DELIVERED_SANITY_RANGE: readonly [number, number] = [40, 2400];

export interface DeliveredDpiVerdict {
  status: "match" | "mismatch" | "unknown";
  requestedDpi: number;
  /** 反查出的实际密度（参与判定的各页取中位数）；反查不出时为 undefined */
  deliveredDpi?: number;
  /** 参与反查的有效页数，用于判断结论强度 */
  samplePages: number;
  /** 面向操作者的中文提示，仅 mismatch 时给出 */
  message?: string;
}

export function paperInchesFor(paperSize: string | undefined): readonly [number, number] {
  const normalized = (paperSize || "").trim().toLowerCase();
  if (normalized === "letter" || normalized === "uspaper" || normalized === "usletter") return SCAN_PAPER_INCHES.Letter;
  if (normalized === "a3") return SCAN_PAPER_INCHES.A3;
  return SCAN_PAPER_INCHES.A4;
}

export function nearestScanDpiStep(value: number): number {
  return SCAN_DPI_STEPS.reduce((best, step) =>
    Math.abs(step - value) < Math.abs(best - value) ? step : best, SCAN_DPI_STEPS[0]);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 像素尺寸 → 实际密度反查。
 * 按「短边对短边、长边对长边」匹配，因此横放/竖放、乃至驱动交付 landscape 都不影响结果；
 * 双面时正反两页尺寸相同，重复取样不会改变中位数。
 *
 * 已知局限：几何只能反查密度，分不清「密度被驱动替代」与「实际进了更小的同比例纸张」
 * （例如选 A4 却喂 A5，两方向都会算出同一个偏低密度）。所以提示语只说「约 X DPI」并让
 * 操作者核对版面，不把反查值当作可直接写库的权威值。
 */
export function verifyDeliveredScanDpi(
  pages: ReadonlyArray<{ width?: number; height?: number }>,
  opts: { dpi: number; paperSize: string }
): DeliveredDpiVerdict {
  const requestedDpi = Number(opts.dpi);
  if (!Number.isFinite(requestedDpi) || requestedDpi <= 0) {
    return { status: "unknown", requestedDpi: Number.isFinite(requestedDpi) ? requestedDpi : 0, samplePages: 0 };
  }
  const [paperShort, paperLong] = paperInchesFor(opts.paperSize);

  const estimates: number[] = [];
  for (const page of pages) {
    const a = Number(page?.width), b = Number(page?.height);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 100 || b < 100) continue;
    const shortEdge = Math.min(a, b), longEdge = Math.max(a, b);
    const dpiByShort = shortEdge / paperShort;
    const dpiByLong = longEdge / paperLong;
    if (Math.abs(dpiByShort / dpiByLong - 1) > ASPECT_TOLERANCE) continue;
    estimates.push((dpiByShort + dpiByLong) / 2);
  }
  if (estimates.length === 0) {
    return { status: "unknown", requestedDpi, samplePages: 0 };
  }

  const deliveredDpi = Math.round(median(estimates));
  if (deliveredDpi < DELIVERED_SANITY_RANGE[0] || deliveredDpi > DELIVERED_SANITY_RANGE[1]) {
    return { status: "unknown", requestedDpi, samplePages: estimates.length };
  }
  if (Math.abs(deliveredDpi - requestedDpi) <= requestedDpi * DPI_TOLERANCE) {
    return { status: "match", requestedDpi, deliveredDpi, samplePages: estimates.length };
  }
  return {
    status: "mismatch",
    requestedDpi,
    deliveredDpi,
    samplePages: estimates.length,
    message: `设定 ${requestedDpi} DPI，但扫描仪实际按约 ${deliveredDpi} DPI 出图（该档位未被驱动采用）。` +
      `识别按 ${deliveredDpi} DPI 的分辨率核对版面即可解释偏差；如需与设定一致，请把 DPI 改为 ${nearestScanDpiStep(deliveredDpi)} 后重扫。`
  };
}
