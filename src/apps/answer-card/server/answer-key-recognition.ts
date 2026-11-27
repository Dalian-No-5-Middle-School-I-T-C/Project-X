import { getMysqlDb } from "../../../server/db/mysql";
import { AiQuotaError, reserveAiCall } from "../../../server/services/aiQuota";
import { finalizeAiRun } from "../../../server/services/aiTelemetry";
import { MAX_ANSWER_TEXT_LENGTH, MAX_QUESTION_NUMBER, parseAnswerKeyText } from "./answer-key-ocr";
import { fetchLlmClient } from "./llm-client";
import { getKnowledgePointProvider } from "./paper-ai-provider";
import { PaperInputError } from "./paper-docx";
import { extractOcrInputText, getFileMime, withOcrCapacity, type OcrInput } from "./paper-ocr";

type Draft = { questionNumber: number; answerText: string };
export type AnswerRecognition = {
  recognized: boolean;
  drafts: Draft[];
  engine?: "ai-vision" | "ai-text" | "local-ocr";
  warning?: string;
};

function readAiDrafts(payload: { answers?: unknown }): Draft[] {
  if (!Array.isArray(payload.answers)) throw new Error("答案提取响应缺少 answers 数组");
  const drafts = new Map<number, Draft>();
  for (const item of payload.answers) {
    const { questionNumber, answerText } = item ?? {};
    if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > MAX_QUESTION_NUMBER ||
        typeof answerText !== "string" || drafts.has(questionNumber)) continue;
    const text = answerText.replace(/\s+/g, " ").trim().slice(0, MAX_ANSWER_TEXT_LENGTH);
    if (text) drafts.set(questionNumber, { questionNumber, answerText: text });
  }
  return [...drafts.values()].sort((a, b) => a.questionNumber - b.questionNumber);
}

export async function recognizeAnswerKeyInput(input: OcrInput, userId?: number): Promise<AnswerRecognition> {
  const isPdf = input.extension === ".pdf";
  const isDocument = isPdf || input.extension === ".docx";
  let text: string | null = null;
  if (isDocument) {
    try {
      text = await withOcrCapacity(() => extractOcrInputText(input));
    } catch (error) {
      if (!(isPdf && error instanceof PaperInputError && error.code === "PDF_PAGE_NO_TEXT")) throw error;
    }
  }

  let warning: string | undefined;
  let runId: number | null = null;
  let failureCode: string | undefined;
  if (text || input.extension !== ".docx") {
    try {
      const db = getMysqlDb();
      const provider = await getKnowledgePointProvider(db, userId, { visionOnly: !text });
      if (provider) {
        const mode = text ? "text" : "direct";
        runId = await reserveAiCall(db, userId ?? null, {
          feature: "answer_key_ocr", model: provider.model ?? null, stage: "request",
        });
        const response = await fetchLlmClient("/analysis/answer-key-ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: provider.providerId, model: provider.model, providerOverride: provider.providerOverride,
            ...(text ? { mode, paperText: text } : {
              mode, files: [{ mimeType: getFileMime("answer" + input.extension), base64: input.bytes.toString("base64") }],
            }),
          }),
        }, 180_000, { runId, model: provider.model ?? null, stage: "answer_key_ocr" });
        if (!response.ok) {
          failureCode = `HTTP_${response.status}`;
          throw new Error("答案提取服务调用失败");
        }
        const drafts = readAiDrafts(await response.json());
        if (drafts.length) return { recognized: true, drafts, engine: mode === "text" ? "ai-text" : "ai-vision" };
        warning = "AI 未识别出答案，已改用本地提取。";
      }
    } catch (error) {
      failureCode ??= error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "EXCEPTION";
      warning = error instanceof AiQuotaError ? "AI 配额暂不可用，已改用本地提取。" : "AI 识别不可用，已改用本地提取。";
    } finally {
      await finalizeAiRun(runId, { success: !failureCode, errorCode: failureCode });
    }
  }

  if (isPdf && !text) {
    throw new PaperInputError(
      "PDF_PAGE_NO_TEXT",
      "此 PDF 含无文字层的页面，且视觉 AI 未能识别。请配置可用的视觉模型、将答案页转为图片后识别，或使用原文件直发。",
      422,
    );
  }
  if (!isDocument) text = await withOcrCapacity(() => extractOcrInputText(input));
  const drafts = parseAnswerKeyText(text ?? "").map(({ questionNumber, answerText }) => ({ questionNumber, answerText }));
  return { recognized: Boolean(text), drafts, engine: "local-ocr", ...(warning ? { warning } : {}) };
}
