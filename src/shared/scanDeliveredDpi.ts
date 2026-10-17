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
  /** 实际出图密度代表值：以桥接回报的 `dpi_x`/`dpi_y` 为主；两侧都有数据且对不上时给出像素反查值 */
  deliveredDpi?: number;
  /** 横轴（`dpi_x`）中位密度，仅桥接回报时给出；与 deliveredDpiY 不同即为非等比例变形 */
  deliveredDpiX?: number;
  /** 纵轴（`dpi_y`）中位密度，含义同 deliveredDpiX */
  deliveredDpiY?: number;
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

/** 一页的逐轴密度：device 用 (dpi_x, dpi_y)，geometry 用 (短边方向, 长边方向) */
interface AxisPair {
  a: number;
  b: number;
}

/** 某一轴在所有页上的中位密度（四舍五入后用于展示与比较） */
function axisMedian(samples: ReadonlyArray<AxisPair>, axis: keyof AxisPair): number {
  return Math.round(median(samples.map((sample) => sample[axis])));
}

/** 与参考值的偏差是否落在容差内 */
function withinTolerance(actual: number, reference: number): boolean {
  return Math.abs(actual - reference) <= reference * DPI_TOLERANCE;
}

/** 两轴代表值（取整后的平均） */
function representative(pa: number, pb: number): number {
  return Math.round((pa + pb) / 2);
}

/** 两轴彼此相差的比例，用于判断非等比例变形 */
function axisSpread(pa: number, pb: number): number {
  return Math.abs(pa - pb) / Math.max(pa, pb);
}

/**
 * 实际出图密度的判定：桥接回报的 `dpi_x`/`dpi_y`（来自 `TW_IMAGEINFO`，且桥接已强制
 * `ICAP_UNITS=TWUN_INCHES`，所以就是 DPI）与像素尺寸反查**都算一遍**并交叉核对——
 * 回报值更贴近采样档位但没有尺寸不可信，几何只量像素却分不清纸型；随包 exe 未必带回报字段，
 * 所以只有一侧数据时也照常下结论。
 *
 * **逐轴判定，不先平均**：350×250 先平均成 300 会既报「密度等于设定」又把非等比例变形藏起来，
 * 而变形恰恰会打偏识别用的坐标。所以先比两轴彼此是否一致，再逐轴比各自与设定值，几何数据
 * 缺席（长宽比超差被排除）时也不能靠两轴相抵下「已生效」的结论。
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

  const devicePairs: AxisPair[] = [];
  const geometryPairs: AxisPair[] = [];
  let pagesWithDimensions = 0;
  for (const [index, page] of pages.entries()) {
    const pageLabel = pages.length > 1 ? `第 ${index + 1}/${pages.length} 页` : "本页";
    const reportedX = Number(page?.dpi_x), reportedY = Number(page?.dpi_y);
    let devicePair: AxisPair | undefined;
    if (Number.isFinite(reportedX) && Number.isFinite(reportedY)
      && reportedX >= DELIVERED_SANITY_RANGE[0] && reportedX <= DELIVERED_SANITY_RANGE[1]
      && reportedY >= DELIVERED_SANITY_RANGE[0] && reportedY <= DELIVERED_SANITY_RANGE[1]) {
      devicePair = { a: reportedX, b: reportedY };
      devicePairs.push(devicePair);
      const spread = axisSpread(reportedX, reportedY);
      if (spread > DPI_TOLERANCE) {
        return {
          status: "mismatch",
          requestedDpi,
          deliveredDpi: representative(reportedX, reportedY),
          deliveredDpiX: Math.round(reportedX),
          deliveredDpiY: Math.round(reportedY),
          source: "device",
          samplePages: 1,
          message: `${pageLabel}驱动回报横向 ${Math.round(reportedX)} DPI、纵向 ${Math.round(reportedY)} DPI，`
            + `两轴相差 ${Math.round(spread * 100)}%，不能按平均值报为已生效。`
            + "请核对实际进纸、纸型及驱动中的缩放/重采样设置后重扫。"
        };
      }
    }
    // 尺寸反查每页都做一次，不因「驱动已经回报」而跳过：驱动谎报 XResolution 而实际按低档出图，
    // 只有像素能揭穿——那恰好是 issue #331 ① 要治的病。
    const a = Number(page?.width), b = Number(page?.height);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 100 || b < 100) {
      if (devicePair && (!withinTolerance(devicePair.a, requestedDpi) || !withinTolerance(devicePair.b, requestedDpi))) {
        const deviceDpi = representative(devicePair.a, devicePair.b);
        return {
          status: "mismatch",
          requestedDpi,
          deliveredDpi: deviceDpi,
          deliveredDpiX: Math.round(devicePair.a),
          deliveredDpiY: Math.round(devicePair.b),
          source: "device",
          samplePages: 1,
          message: `${pageLabel}驱动回报横向 ${Math.round(devicePair.a)} DPI、纵向 ${Math.round(devicePair.b)} DPI，`
            + `与设定的 ${requestedDpi} DPI 不一致。请把 DPI 改为 ${nearestScanDpiStep(deviceDpi)} 后重扫。`
        };
      }
      continue;
    }
    pagesWithDimensions += 1;
    const shortEdge = Math.min(a, b), longEdge = Math.max(a, b);
    const dpiByShort = shortEdge / paperShort;
    const dpiByLong = longEdge / paperLong;
    if (Math.abs(dpiByShort / dpiByLong - 1) > ASPECT_TOLERANCE) {
      const deviceDpi = devicePair ? representative(devicePair.a, devicePair.b) : undefined;
      return {
        status: "mismatch",
        requestedDpi,
        deliveredDpi: representative(dpiByShort, dpiByLong),
        source: "geometry",
        samplePages: 1,
        message: `${deviceDpi === undefined ? "" : `驱动回报约 ${deviceDpi} DPI，但`}`
          + `${pageLabel}像素尺寸按所选纸型反查为短边方向 ${Math.round(dpiByShort)} DPI、长边方向 ${Math.round(dpiByLong)} DPI，`
          + "出图长宽比与所选纸型对不上。请核对实际进纸纸张、是否裁切或变形，以及驱动中的缩放/重采样设置后重扫。"
      };
    }
    const geometryPair = { a: dpiByShort, b: dpiByLong };
    const geometrySpread = axisSpread(dpiByShort, dpiByLong);
    if (geometrySpread > DPI_TOLERANCE) {
      return {
        status: "mismatch",
        requestedDpi,
        deliveredDpi: representative(dpiByShort, dpiByLong),
        source: "geometry",
        samplePages: 1,
        message: `${pageLabel}出图像素尺寸反查为短边方向 ${Math.round(dpiByShort)} DPI、长边方向 ${Math.round(dpiByLong)} DPI，`
          + `两轴相差 ${Math.round(geometrySpread * 100)}%，平均后不能报为已生效。`
          + "请核对实际进纸纸张、是否裁切或变形，以及驱动中的缩放/重采样设置后重扫。"
      };
    }
    const geometryDpi = representative(dpiByShort, dpiByLong);
    const geometryOffRequest = !withinTolerance(dpiByShort, requestedDpi) || !withinTolerance(dpiByLong, requestedDpi);
    if (devicePair) {
      const deviceDpi = representative(devicePair.a, devicePair.b);
      const deviceOffRequest = !withinTolerance(devicePair.a, requestedDpi) || !withinTolerance(devicePair.b, requestedDpi);
      if (geometryOffRequest || deviceOffRequest || !withinTolerance(geometryDpi, deviceDpi)) {
        const sourcesDiffer = !withinTolerance(geometryDpi, deviceDpi);
        return {
          status: "mismatch",
          requestedDpi,
          deliveredDpi: sourcesDiffer ? geometryDpi : deviceDpi,
          source: sourcesDiffer ? "geometry" : "device",
          samplePages: 1,
          message: `${pageLabel}驱动回报横向 ${Math.round(devicePair.a)} DPI、纵向 ${Math.round(devicePair.b)} DPI，`
            + `出图像素尺寸反查为短边方向 ${Math.round(dpiByShort)} DPI、长边方向 ${Math.round(dpiByLong)} DPI，`
            + (sourcesDiffer ? "两个来源对不上" : `两者都与设定的 ${requestedDpi} DPI 不一致`)
            + "。请核对进纸纸张与纸型；纸型无误就检查驱动中的缩放/重采样设置后重扫。"
        };
      }
    } else if (geometryOffRequest) {
      return {
        status: "mismatch",
        requestedDpi,
        deliveredDpi: geometryDpi,
        source: "geometry",
        samplePages: 1,
        message: `${pageLabel}出图像素尺寸只对应约 ${Math.round(dpiByShort)}×${Math.round(dpiByLong)} DPI，`
          + `与设定的 ${requestedDpi} DPI 不一致。请核对进纸纸张与纸型；纸型无误就检查驱动中的缩放/重采样设置后重扫。`
      };
    }
    geometryPairs.push(geometryPair);
  }

  const hasDeviceReport = devicePairs.length > 0;
  const pairs = hasDeviceReport ? devicePairs : geometryPairs;
  const source: "device" | "geometry" = hasDeviceReport ? "device" : "geometry";
  const axisLabel = hasDeviceReport ? (["横向", "纵向"] as const) : (["短边方向", "长边方向"] as const);
  if (pairs.length === 0) {
    return { status: "unknown", requestedDpi, samplePages: 0 };
  }

  const axisA = axisMedian(pairs, "a");
  const axisB = axisMedian(pairs, "b");
  const deliveredDpi = representative(axisA, axisB);
  if (axisA < DELIVERED_SANITY_RANGE[0] || axisA > DELIVERED_SANITY_RANGE[1]
    || axisB < DELIVERED_SANITY_RANGE[0] || axisB > DELIVERED_SANITY_RANGE[1]) {
    return { status: "unknown", requestedDpi, samplePages: pairs.length };
  }

  const verdictAxes = hasDeviceReport ? { deliveredDpiX: axisA, deliveredDpiY: axisB } : {};

  // 1) 两轴彼此对不上：图像被非等比例拉伸/压扁，或驱动的 X/Y 有一个是抄来的。
  //    这一步必须在与设定值比较之前做——平均后的代表值可能恰好落在设定值上。
  const spread = axisSpread(axisA, axisB);
  if (spread > DPI_TOLERANCE) {
    const geometryNote = !hasDeviceReport ? ""
      : (geometryPairs.length > 0
        ? `，出图像素按所选纸型反查为 ${axisMedian(geometryPairs, "a")}×${axisMedian(geometryPairs, "b")} DPI`
        : (pagesWithDimensions > 0
          ? "，且这批页面的像素长宽比与所选纸型对不上，尺寸侧没能参与核对"
          : "，且桥接未回报出图尺寸，只有回报值一侧可核"));
    return {
      status: "mismatch",
      requestedDpi,
      deliveredDpi,
      ...verdictAxes,
      source,
      samplePages: pairs.length,
      message: `设定 ${requestedDpi} DPI，但${source === "device" ? "驱动回报" : "出图像素尺寸反查"}为`
        + `${axisLabel[0]} ${axisA} DPI、${axisLabel[1]} ${axisB} DPI，两轴相差 ${Math.round(spread * 100)}%${geometryNote}。`
        + `这是非等比例变形或回报自相矛盾，平均成 ${deliveredDpi} DPI 会把异常抵消掉，而识别坐标正是按两轴分别换算的。`
        + `请先核对实际进纸的纸张与所选纸型（A4/A3、A4/A5 这类同比例纸张在尺寸上分不开）；`
        + `纸型无误就按 ${axisA}×${axisB} 两轴分别核对版面，并检查驱动里「适应纸张尺寸 / 重采样」这类缩放选项后重扫。`
    };
  }

  // 2) 两轴一致，但驱动回报与像素尺寸对不上：回报值可能是抄来的档位。
  if (hasDeviceReport && geometryPairs.length > 0) {
    const geometryA = axisMedian(geometryPairs, "a");
    const geometryB = axisMedian(geometryPairs, "b");
    const geometryDpi = representative(geometryA, geometryB);
    const geometrySpread = axisSpread(geometryA, geometryB);
    const geometryInRange = geometryDpi >= DELIVERED_SANITY_RANGE[0] && geometryDpi <= DELIVERED_SANITY_RANGE[1];
    if (geometryInRange && geometrySpread > DPI_TOLERANCE) {
      return {
        status: "mismatch",
        requestedDpi,
        deliveredDpi: geometryDpi,
        source: "geometry",
        samplePages: geometryPairs.length,
        message: `驱动回报约 ${deliveredDpi} DPI，但出图像素尺寸反查为短边方向 ${geometryA} DPI、长边方向 ${geometryB} DPI，`
          + `两轴相差 ${Math.round(geometrySpread * 100)}%，平均成 ${geometryDpi} DPI 会掩盖非等比例变形。`
          + `请先核对实际进纸的纸张与所选纸型（A4/A3、A4/A5 这类同比例纸张在尺寸上分不开）；`
          + `纸型无误就检查驱动里「适应纸张尺寸 / 重采样」这类缩放选项后重扫。`
      };
    }
    if (geometryInRange && !withinTolerance(geometryDpi, deliveredDpi)) {
      // 两个来源对不上时不能报「设定已生效」：像素是识别真正拿到的东西，回报值可能是抄来的档位。
      return {
        status: "mismatch",
        requestedDpi,
        deliveredDpi: geometryDpi,
        source: "geometry",
        samplePages: geometryPairs.length,
        message: `驱动回报约 ${deliveredDpi} DPI，但出图像素尺寸只对应约 ${geometryDpi} DPI，两个来源对不上，`
          + `无法确认设定的 ${requestedDpi} DPI 已生效。请先核对实际进纸的纸张与所选纸型（A4/A3、A4/A5 这类同比例纸张在尺寸上分不开）；`
          + `纸型无误就按 ${geometryDpi} DPI 核对版面，或把 DPI 改为 ${nearestScanDpiStep(geometryDpi)} 后重扫。`
      };
    }
  }

  // 3) 逐轴与设定值比较：任一轴偏离即算未生效，不允许一高一低互相抵消。
  if (!withinTolerance(axisA, requestedDpi) || !withinTolerance(axisB, requestedDpi)) {
    const axisDetail = axisA === axisB
      ? `${deliveredDpi}`
      : `${axisA}~${axisB}`;
    return {
      status: "mismatch",
      requestedDpi,
      deliveredDpi,
      ...verdictAxes,
      source,
      samplePages: pairs.length,
      message: `设定 ${requestedDpi} DPI，但扫描仪实际按约 ${axisDetail} DPI 出图`
        + `（${source === "device" ? "驱动回报的密度" : "由出图像素尺寸反查"}${axisA === axisB ? "" : `，${axisLabel[0]} ${axisA}、${axisLabel[1]} ${axisB}`}）。`
        + (source === "geometry" ? "同比例纸张（A4/A3、A4/A5）在尺寸上分不开，请先核对实际进纸的纸张与所选纸型；" : "")
        + `识别按 ${deliveredDpi} DPI 的分辨率核对版面即可解释偏差；如需与设定一致，请把 DPI 改为 ${nearestScanDpiStep(deliveredDpi)} 后重扫。`
    };
  }
  return {
    status: "match",
    requestedDpi,
    deliveredDpi,
    ...verdictAxes,
    source,
    samplePages: pairs.length
  };
}
