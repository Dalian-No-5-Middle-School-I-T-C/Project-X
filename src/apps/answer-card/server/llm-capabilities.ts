/**
 * 模型视觉能力判定（纯函数）。
 *
 * 用于「原卷知识点分析」选择直传图片还是先本地提取文字：
 * - gemini / openai 视为多模态（历史行为）；
 * - deepseek 仅模型 ID 含 vision 的型号（如 deepseek-v4-flash-vision-exp）支持图像。
 */
export function isVisionProvider(
  providerType: string | null | undefined,
  model: string | null | undefined
): boolean {
  const p = (providerType ?? "").toLowerCase();
  if (p === "gemini" || p === "openai") return true;
  if (p === "deepseek") {
    return (model ?? "").toLowerCase().includes("vision");
  }
  return false;
}
