/** Use the model ID when a provider exposes both vision and text models. */
export function isVisionProvider(
  providerType: string | null | undefined,
  model: string | null | undefined
): boolean {
  const id = model?.trim().toLowerCase();
  if (!id) return /^(gemini|openai)$/i.test(providerType ?? "");
  if (/(?:^|[/:])deepseek-(?:chat|reasoner)(?:$|[-:@])/.test(id)) return false;
  return /(?:^|[^a-z0-9])(?:vl\d*|vision|4o|gpt-(?:4o?|5)(?=$|[.\-:/])|gemini|glm-4v|claude-(?:(?:sonnet|opus|haiku)-)?[34])/.test(id)
    || /qwen\d*(?:\.\d+)?vl/.test(id);
}

export function resolveKnowledgePointMode(isMultimodal: boolean): "text" | "direct" {
  return isMultimodal ? "direct" : "text";
}
