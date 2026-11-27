import type { DbAdapter } from "../../../server/db/mysql";
import { decryptField } from "../../../server/lib/field-crypto";
import { isVisionProvider } from "./llm-capabilities";
import { llmClientHeaders, llmClientUrl } from "./llm-client";

type AiProviderRow = {
  id: number;
  provider_type: string;
  base_url: string;
  api_key: string;
  models: string | null;
};

function configuredModels(models: string | null): string[] {
  try {
    const parsed = JSON.parse(models ?? "[]");
    if (Array.isArray(parsed)) {
      return parsed.flatMap(item => {
        const id = typeof item === "string" ? item : item?.id;
        return typeof id === "string" && id.trim() ? [id.trim()] : [];
      });
    }
  } catch {
    // A saved provider can have an invalid or empty model list.
  }
  return [];
}

export async function getKnowledgePointProvider(
  db: DbAdapter,
  userId?: number,
  { visionOnly = false }: { visionOnly?: boolean } = {},
): Promise<{
  providerId: number;
  providerType: string;
  model?: string;
  providerOverride?: Record<string, string>;
} | null> {
  const providers = await db.all<AiProviderRow>(
    "SELECT id, provider_type, base_url, api_key, models FROM ai_providers WHERE is_active = 1 AND (is_system = 1 OR user_id = ?) ORDER BY is_system DESC, sort_order, id",
    userId ?? null,
  );

  for (const provider of providers) {
    const models = configuredModels(provider.models);
    const model = visionOnly
      ? models.find(id => isVisionProvider(provider.provider_type, id))
      : models[0];
    if (visionOnly && !model && !(models.length === 0 && isVisionProvider(provider.provider_type, undefined))) continue;
    return {
      providerId: provider.id,
      providerType: provider.provider_type,
      model,
      providerOverride: {
        provider_type: provider.provider_type,
        base_url: provider.base_url || "",
        api_key: decryptField(provider.api_key) ?? "",
      },
    };
  }

  let status: {
    internalAuthConfigured?: boolean;
    defaultModel?: string;
    models?: Array<{ id: string; provider: string; available: boolean; vision?: boolean }>;
  };
  try {
    const response = await fetch(llmClientUrl("/health"), {
      headers: llmClientHeaders(),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    status = await response.json();
  } catch {
    return null;
  }
  if (status.internalAuthConfigured === false) return null;
  const available = status.models?.filter(item => item.available &&
    (!visionOnly || (item.vision ?? isVisionProvider(item.provider, item.id))));
  const model = available?.find(item => item.id === status.defaultModel) ?? available?.[0];
  return model ? { providerId: 0, providerType: model.provider, model: model.id } : null;
}
