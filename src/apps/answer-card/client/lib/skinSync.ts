import { useRef } from "react";
import { fetchJson } from "../auth/api";
import { ACCOUNT_SETTINGS_PATH, createSkinPreferenceWriter } from "./skinPreferenceWriter";

export type { SkinWriteOutcome } from "./skinPreferenceWriter";
export { ACCOUNT_SETTINGS_PATH, createSkinPreferenceWriter } from "./skinPreferenceWriter";

/**
 * 组件侧入口：持有一个稳定的写入器实例（并发计数器跨渲染不重置，
 * 这是 R49「旧响应不得覆盖最新选择」成立的前提）。
 */
export function useSkinPreferenceWriter() {
  const writerRef = useRef<ReturnType<typeof createSkinPreferenceWriter> | null>(null);
  if (!writerRef.current) {
    writerRef.current = createSkinPreferenceWriter((skin) =>
      fetchJson(ACCOUNT_SETTINGS_PATH, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeSkin: skin }),
      })
    );
  }
  return writerRef.current;
}
