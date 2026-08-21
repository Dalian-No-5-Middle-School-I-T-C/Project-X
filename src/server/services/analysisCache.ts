/**
 * 分析结果内存 LRU 缓存（建议 6）。
 *
 * 单机不引入 Redis：纯内存 Map + 条数上限（ia32 内存有限）。缓存键为
 * `方法名:examId:classId|all`。失效策略为「写入口显式精准失效」：
 *  - 改分（score-editing.ts）→ invalidateExam(examId)
 *  - 扫描入库（scanner persist）→ invalidateExam(examId)
 *  - 阈值更新 → clear()（全局阈值影响所有统计）
 *  - 答案覆盖/知识点标注变更 → invalidateExam(examId)
 *
 * 注意：缓存只包一层「按请求可重放」的汇总数据（如 getExamOverview），
 * 缓存值必须是纯 JSON 可序列化对象，绝不能缓存带可变引用的内容。
 */
export class AnalysisCache {
  private limit: number;
  private map: Map<string, { value: unknown; ts: number }>;

  constructor(limit = 50) {
    this.limit = limit;
    this.map = new Map();
  }

  get<T>(key: string): T | undefined {
    const hit = this.map.get(key);
    if (hit) {
      // LRU：命中即移到队尾
      this.map.delete(key);
      this.map.set(key, hit);
      return hit.value as T;
    }
    return undefined;
  }

  set<T>(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, ts: Date.now() });
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** 精确失效：某场考试相关的所有缓存条目。 */
  invalidateExam(examId: number): void {
    const prefix = `:${examId}:`;
    for (const key of this.map.keys()) {
      if (key.includes(prefix)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** 全局单例（所有仓库/路由共享同一份缓存）。 */
export const analysisCache = new AnalysisCache();
