import type { PageRenderBlock, RecognitionBlockCrop } from "./types";

/**
 * 与 native `layout_io.cpp: block_crops_from_page` 同源：只有带题号的大题才会被切块。
 * 没排题的空块本来就不产出切块，把它算进「应有」会让每一页都误报。
 */
function croppableBlocks(blocks: PageRenderBlock[]): Array<{ blockId: string; title: string }> {
  return blocks
    .filter((block) => (block.type === "objective" ? block.items.length > 0 : block.questions.length > 0))
    .map((block) => ({ blockId: block.blockId, title: block.title }));
}

export type BlockCropAudit = {
  /** 扫描记录页号，只用于把结论指回界面上的那一页 */
  pageNum: number;
  /**
   * ok              —— 声明的大题全部切出并落库。
   * partial         —— 识别器有切块能力，但这一页少了几个大题（issue #331 ③ 的「读不到」）。
   * unsupported     —— 这一页压根没有切块字段（blockCrops 为 undefined）：随包 exe 过旧或
   *   `--crops-dir` 降级重来。整会话都是它时，症状同样是「大题划分读不到」，但成因完全不同，
   *   所以必须和 partial 分开统计。
   * not_persisted   —— 识别器报了切块，但一个都没写进 `answer_block_crops`（临时文件丢失或
   *   字段不合契约）。识别层看不出问题，只有网阅队列为空才暴露，所以必须单独成类。
   */
  status: "ok" | "partial" | "unsupported" | "not_persisted";
  expected: number;
  got: number;
  missingBlockIds: string[];
  missingTitles: string[];
};

/** 单页核对：布局声明的大题 vs 识别器产出 vs 真正落库 */
export function auditBlockCrops(
  pageNum: number,
  blocks: PageRenderBlock[],
  crops: RecognitionBlockCrop[] | undefined,
  persistedCount?: number
): BlockCropAudit {
  const declared = croppableBlocks(blocks);
  const produced = new Set((crops ?? []).map((crop) => crop.blockId));
  const absent = declared.filter((block) => !produced.has(block.blockId));
  // 识别器说切好了但落库为 0：对网阅而言同样是「这道大题没有切块」
  const lost = absent.length === 0 && declared.length > 0 && produced.size > 0 && persistedCount === 0;
  const missing = lost ? declared : absent;
  const base = {
    pageNum,
    expected: declared.length,
    got: declared.length - missing.length,
    missingBlockIds: missing.map((block) => block.blockId),
    missingTitles: missing.map((block) => block.title)
  };
  if (declared.length === 0 || missing.length === 0) {
    return { ...base, status: "ok" };
  }
  if (lost) return { ...base, status: "not_persisted" };
  return { ...base, status: crops === undefined ? "unsupported" : "partial" };
}

export type BlockCropSessionSummary = {
  auditedPages: number;
  partialPages: number;
  unsupportedPages: number;
  notPersistedPages: number;
  /** 需要人工介入时的中文说明；全部 ok 时为 undefined */
  message?: string;
};

/** 会话汇总：把逐页核对压成一条可截图、可上报的结论 */
export function summarizeBlockCropAudits(audits: BlockCropAudit[]): BlockCropSessionSummary {
  const byStatus = (status: BlockCropAudit["status"]) => audits.filter((audit) => audit.status === status);
  const partial = byStatus("partial");
  const unsupported = byStatus("unsupported");
  const notPersisted = byStatus("not_persisted");
  const summary: BlockCropSessionSummary = {
    auditedPages: audits.filter((audit) => audit.expected > 0).length,
    partialPages: partial.length,
    unsupportedPages: unsupported.length,
    notPersistedPages: notPersisted.length
  };
  if (!partial.length && !unsupported.length && !notPersisted.length) {
    return summary;
  }
  const pages = (list: BlockCropAudit[]) =>
    list.slice(0, 8).map((audit) => audit.pageNum).join("、") + (list.length > 8 ? "…" : "");
  const parts: string[] = [];
  if (unsupported.length) {
    parts.push(
      `第 ${pages(unsupported)} 页识别器没有返回任何大题切块（随包识别器过旧或不支持 --crops-dir），需要更新扫描端识别组件后重新识别`
    );
  }
  if (partial.length) {
    const titles = [...new Set(partial.flatMap((audit) => audit.missingTitles))].slice(0, 4).join("」「");
    parts.push(
      `第 ${pages(partial)} 页识别完成却缺大题切块（缺「${titles}」），请对这些页重新识别；反复缺失请把 [checkpoint] blocks 日志一并发给开发`
    );
  }
  if (notPersisted.length) {
    parts.push(
      `第 ${pages(notPersisted)} 页识别器报出了切块但一个都没入库（切块图片丢失或字段不合契约），请检查识别临时目录后重新识别`
    );
  }
  return { ...summary, message: `大题切块核对：${parts.join("；")}。` };
}
