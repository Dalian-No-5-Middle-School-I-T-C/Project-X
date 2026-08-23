/**
 * 实体生命周期事件写入（支撑控制台"历史累计"统计）。
 *
 * entity_lifecycle_events 记录 exam / answer_card / exam_group 的
 * create / archive / delete / restore 动作，供 /api/admin/console/activity 等
 * 聚合端点准确计算"现存/当前"与历史累计（含已删除实体）。
 *
 * 安全约束：
 *   - 仅记录 entity_type / entity_id / action / actor_id（内部账号 id），
 *     不记录名称、内容或任何 PII 文本。
 *   - 写入包 try/catch，失败不影响业务动作。
 */

import { getMysqlDb } from "../db";

export type LifecycleEntityType = "exam" | "answer_card" | "exam_group";
export type LifecycleAction = "create" | "archive" | "delete" | "restore";

export async function recordLifecycleEvent(input: {
  entityType: LifecycleEntityType;
  entityId: number | string;
  action: LifecycleAction;
  actorId?: number | null;
}): Promise<void> {
  try {
    const db = getMysqlDb();
    await db.run(
      "INSERT INTO entity_lifecycle_events (entity_type, entity_id, action, actor_id) VALUES (?, ?, ?, ?)",
      input.entityType,
      String(input.entityId),
      input.action,
      input.actorId ?? null
    );
  } catch (err) {
    console.warn("[lifecycle] recordLifecycleEvent failed:", (err as Error)?.message);
  }
}
