// v2.5.1 终态取页冒烟：服务端权威扫描记录与本地 SSE 已知页的合并策略。
// 背景：SSE 订阅晚到/重连只补发 done 不回放 page_done，本地可能缺页/为空。
import { mergeAuthoritativePages } from "../src/apps/answer-card/client/lib/scanSessionPages";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

const rec = (id: string, pageNum: number, side = "front") => ({ id, pageNum, side });

// 场景 ①：仅收到 done（本地 0 页）→ 全量采用服务端权威记录
{
  const merged = mergeAuthoritativePages([rec("r1", 1), rec("r2", 2, "back"), rec("r3", 3)], []);
  assert(merged.length === 3, `①: 服务端 3 页应全量采用，实际 ${merged.length}`);
  assert(merged[0].recordId === "r1" && merged[2].pageNum === 3, "①: 内容与顺序正确");
  assert(merged[1].side === "back", "①: side 归一化保留 back");
}

// 场景 ②：本地只收到部分 page_done 且与服务端重叠 → 按 recordId 去重不丢页
{
  const known = [{ recordId: "r1", pageNum: 1, side: "front" as const }];
  const merged = mergeAuthoritativePages([rec("r1", 1), rec("r2", 2), rec("r3", 3)], known);
  assert(merged.length === 3, `②: 重叠去重后应 3 页，实际 ${merged.length}`);
  assert(new Set(merged.map((p) => p.recordId)).size === 3, "②: recordId 无重复");
}

// 场景 ③：服务端返回空（异常会话）→ 回退本地已知页
{
  const known = [{ recordId: "k1", pageNum: 1, side: "front" as const }];
  const merged = mergeAuthoritativePages([], known);
  assert(merged.length === 1 && merged[0].recordId === "k1", "③: 空权威时应回退本地");
}

// 场景 ④：双面扫描同页码双记录均保留
{
  const merged = mergeAuthoritativePages([rec("a", 1, "front"), rec("b", 1, "back")], []);
  assert(merged.length === 2, "④: 同页码正反面两条记录都保留");
  assert(merged.filter((p) => p.side === "back").length === 1, "④: back 页保留");
}

// 场景 ⑤：服务端乱序记录按 pageNum 升序稳定输出
{
  const merged = mergeAuthoritativePages([rec("z", 3), rec("y", 1), rec("x", 2, "back")], []);
  assert(
    merged.map((p) => p.pageNum).join(",") === "1,2,3",
    `⑤: 应按 pageNum 升序，实际 ${merged.map((p) => p.pageNum).join(",")}`,
  );
}

console.log("scan-session-pages-smoke: 全部通过");
