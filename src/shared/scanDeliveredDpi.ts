/**
 * 核对软件里设定的 DPI 是否真的生效：桥接回报的 `dpi_x`/`dpi_y`（`TW_IMAGEINFO`）与
 * 出图像素尺寸反查两条证据都取，并互相核对；只有一侧有数据时按那一侧下结论。
 *
 * 为什么还要在 TS 侧反查：TWAIN 的 MSG_SET 返回成功只代表「请求被接受」，驱动完全可能
 * 按自己的档位替代（甚至因为 ICAP_UNITS 是厘米而把 300 读成 300 点/厘米），也可能把低档
 * 出图标注成高档位。native 侧已加 MSG_GETCURRENT 回读，但随包 exe 未必重编译，反查这一步
 * 对**现网正在用的 exe** 也成立。
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
  /** 实际出图密度：以桥接回报的 `dpi_x`/`dpi_y` 为主；两侧都有数据且对不上时给出像素反查值 */
  deliveredDpi?: number;
  /** deliveredDpi 的来源：device=驱动自己报的，geometry=由尺寸反查的 */
  source?: "device" | "geometry";
  /** 参与判定的有效页数，用于判断结论强度 */
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
 * 实际出图密度的判定：桥接回报的 `dpi_x`/`dpi_y`（来自 `TW_IMAGEINFO`，且桥接已强制
 * `ICAP_UNITS=TWUN_INCHES`，所以就是 DPI）与像素尺寸反查**都算一遍**并交叉核对——
 * 回报值更贴近采样档位但没有尺寸不可信，几何只量像素却分不清纸型；随包 exe 未必带回报字段，
 * 所以只有一侧数据时也照常下结论。
 *
 * 几何反查按「短边对短边、长边对长边」匹配，因此横放/竖放、乃至驱动交付 landscape 都不影响结果。
 *
 * 已知局限：几何分不清「密度被驱动替代」与「实际进了同比例的不同纸张」
 * （A4 与 A3 长宽比相同；选 A4 却喂 A5 时两个方向都会算出同一个偏低密度）。所以尺寸反查出来的
 * 偏低值必须同时提示「核对进纸纸张与纸型选择」，不能只让操作者去改 DPI 档位。
 */
export function verifyDeliveredScanDpi(
  pages: ReadonlyArray<{ width?: number; height?: number; dpi_x?: number; dpi_y?: number }>,
  opts: { dpi: number; paperSize: string }
): DeliveredDpiVerdict {
  const requestedDpi = Number(opts.dpi);
  if (!Number.isFinite(requestedDpi) || requestedDpi <= 0) {
    return { status: "unknown", requestedDpi: Number.isFinite(requestedDpi) ? requestedDpi : 0, samplePages: 0 };
  }
  const [paperShort, paperLong] = paperInchesFor(opts.paperSize);

  const deviceEstimates: number[] = [];
  const geometryEstimates: number[] = [];
  for (const page of pages) {
    const reportedX = Number(page?.dpi_x), reportedY = Number(page?.dpi_y);
    if (Number.isFinite(reportedX) && Number.isFinite(reportedY)
      && reportedX >= DELIVERED_SANITY_RANGE[0] && reportedX <= DELIVERED_SANITY_RANGE[1]
      && reportedY >= DELIVERED_SANITY_RANGE[0] && reportedY <= DELIVERED_SANITY_RANGE[1]) {
      deviceEstimates.push((reportedX + reportedY) / 2);
    }
    // 尺寸反查每页都做一次，不因「驱动已经回报」而跳过：驱动谎报 XResolution 而实际按低档出图，
    // 只有像素能揭穿——那恰好是 issue #331 ① 要治的病。
    const a = Number(page?.width), b = Number(page?.height);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 100 || b < 100) continue;
    const shortEdge = Math.min(a, b), longEdge = Math.max(a, b);
    const dpiByShort = shortEdge / paperShort;
    const dpiByLong = longEdge / paperLong;
    if (Math.abs(dpiByShort / dpiByLong - 1) > ASPECT_TOLERANCE) continue;
    geometryEstimates.push((dpiByShort + dpiByLong) / 2);
  }
  const hasDeviceReport = deviceEstimates.length > 0;
  const estimates = hasDeviceReport ? deviceEstimates : geometryEstimates;
  const source: "device" | "geometry" = hasDeviceReport ? "device" : "geometry";
  if (estimates.length === 0) {
    return { status: "unknown", requestedDpi, samplePages: 0 };
  }

  const deliveredDpi = Math.round(median(estimates));
  if (deliveredDpi < DELIVERED_SANITY_RANGE[0] || deliveredDpi > DELIVERED_SANITY_RANGE[1]) {
    return { status: "unknown", requestedDpi, samplePages: estimates.length };
  }
  if (hasDeviceReport && geometryEstimates.length > 0) {
    const geometryDpi = Math.round(median(geometryEstimates));
    if (geometryDpi >= DELIVERED_SANITY_RANGE[0] && geometryDpi <= DELIVERED_SANITY_RANGE[1]
      && Math.abs(geometryDpi - deliveredDpi) > deliveredDpi * DPI_TOLERANCE) {
      // 两个来源对不上时不能报「设定已生效」：像素是识别真正拿到的东西，回报值可能是抄来的档位。
      return {
        status: "mismatch",
        requestedDpi,
        deliveredDpi: geometryDpi,
        source: "geometry",
        samplePages: geometryEstimates.length,
        message: `驱动回报约 ${deliveredDpi} DPI，但出图像素尺寸只对应约 ${geometryDpi} DPI，两个来源对不上，`
          + `无法确认设定的 ${requestedDpi} DPI 已生效。请先核对实际进纸的纸张与所选纸型（A4/A3、A4/A5 这类同比例纸张在尺寸上分不开）；`
          + `纸型无误就按 ${geometryDpi} DPI 核对版面，或把 DPI 改为 ${nearestScanDpiStep(geometryDpi)} 后重扫。`
      };
    }
  }
  if (Math.abs(deliveredDpi - requestedDpi) <= requestedDpi * DPI_TOLERANCE) {
    return { status: "match", requestedDpi, deliveredDpi, source, samplePages: estimates.length };
  }
  return {
    status: "mismatch",
    requestedDpi,
    deliveredDpi,
    source,
    samplePages: estimates.length,
    message: `设定 ${requestedDpi} DPI，但扫描仪实际按约 ${deliveredDpi} DPI 出图（${source === "device" ? "驱动回报的密度" : "由出图像素尺寸反查"}）。`
      + (source === "geometry" ? "同比例纸张（A4/A3、A4/A5）在尺寸上分不开，请先核对实际进纸的纸张与所选纸型；" : "")
      + `识别按 ${deliveredDpi} DPI 的分辨率核对版面即可解释偏差；如需与设定一致，请把 DPI 改为 ${nearestScanDpiStep(deliveredDpi)} 后重扫。`
  };
}
