import { isDeepStrictEqual } from "node:util";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

export async function verifyPaperUploadPanel(ok: (condition: boolean, label: string) => void): Promise<void> {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://projectx.test" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const window = dom.window as unknown as Record<string, unknown>;
  install("window", dom.window);
  for (const name of ["document", "navigator", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLFormElement",
    "Node", "NodeFilter", "Element", "CustomEvent", "Event", "DocumentFragment", "getComputedStyle", "MutationObserver"]) {
    install(name, window[name]);
  }
  install("IS_REACT_ACT_ENVIRONMENT", true);
  install("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

  let savedInfo = { pages: [{ pageIndex: 1, filename: "original.pdf" }], question_range: "第3至9题", extra_notes: "检查力学题" };
  let savedPoints = [{ question_number: 4.1, points: ["力的平衡"] }];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let analysisInput: Record<string, unknown> | undefined;
  install("fetch", async (url: string, init?: RequestInit) => {
    const pathname = new URL(url, dom.window.location.href).pathname;
    if (pathname === "/api/exams/1/answer-key") {
      return Response.json({ answerKeyMode: "text", showOriginalPaper: 0, paperPages: [], answerPages: [], answers: [] });
    }
    if (pathname === "/api/exams/1/answer-key/pages" && init?.method === "POST") {
      return Response.json({ answerPages: [], ocr: [
        { pageIndex: 1, engine: "local-ocr", recognized: false, drafts: [], warning: "AI 识别不可用，已改用本地提取。" },
        { pageIndex: 2, engine: "ai-vision", recognized: true, drafts: [{ questionNumber: 7, answerText: "AB" }] },
      ] });
    }
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      writes.push({ path: pathname, body });
      if (pathname.endsWith("/paper/info")) {
        savedInfo = { ...savedInfo, question_range: body.questionRange, extra_notes: body.extraNotes };
      } else {
        savedPoints = body.points.map((point: { question_number: number; point_text: string }) => ({
          question_number: point.question_number, points: [point.point_text],
        }));
      }
      return Response.json({ success: true });
    }
    if (pathname.endsWith("/knowledge-points/analyze")) {
      analysisInput = JSON.parse(String(init?.body));
      return Response.json({ knowledgePoints: [
        { questionNumber: 7, points: ["动量守恒"] }, { question_number: 8, points: ["功率"] },
      ] });
    }
    if (pathname.endsWith("/paper/info")) return Response.json(savedInfo);
    if (pathname.endsWith("/knowledge-points")) return Response.json({ points: savedPoints });
    return Response.json({ error: "Unexpected request" }, { status: 500 });
  });

  const { createRoot } = await import("react-dom/client");
  const { PaperUploadPanel } = await import("../src/apps/answer-card/client/components/PaperUploadPanel");
  const document = dom.window.document;
  const root = createRoot(document.getElementById("root")!);
  let closeCount = 0;
  const render = (open: boolean) => root.render(createElement(PaperUploadPanel, {
    cardId: "fixture", open, onClose: () => { closeCount++; },
  }));
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`找不到可用按钮：${label}`);
    await act(async () => button.click());
  };

  try {
    await act(async () => render(true));
    ok(document.querySelector<HTMLInputElement>('input[aria-label="自定义题目范围"]')?.value === "第3至9题" &&
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="特别描述"]')?.value === "检查力学题" &&
      Boolean(document.body.textContent?.includes("第4.1题") && document.body.textContent.includes("力的平衡")),
    "原卷弹窗显示已保存的自定义范围、备注和知识点");

    await click("开始分析");
    const rendered = document.body.textContent ?? "";
    ok(rendered.includes("第7题") && rendered.includes("动量守恒") &&
      rendered.includes("第8题") && rendered.includes("功率") &&
      isDeepStrictEqual(analysisInput, { questionRange: "第3至9题", extraNotes: "检查力学题" }),
    "知识点结果兼容两种题号字段，分析请求带上回显的参数");

    await click("保存全部");
    ok(closeCount === 1 && isDeepStrictEqual(writes, [
      { path: "/api/cards/fixture/paper/info", body: { questionRange: "第3至9题", extraNotes: "检查力学题" } },
      { path: "/api/cards/fixture/knowledge-points", body: {
        points: [{ question_number: 7, point_text: "动量守恒" }, { question_number: 8, point_text: "功率" }],
      } },
    ]), "保存知识点时发送正确题号");

    await act(async () => render(false));
    savedInfo = { ...savedInfo, question_range: "全部", extra_notes: "再次打开时读取新备注" };
    await act(async () => render(true));
    ok(!document.querySelector('input[aria-label="自定义题目范围"]') &&
      document.querySelector<HTMLTextAreaElement>('textarea[aria-label="特别描述"]')?.value === "再次打开时读取新备注" &&
      Boolean(document.body.textContent?.includes("第7题") && document.body.textContent.includes("第8题")),
    "重新打开弹窗后重新读取已保存的设置和知识点");

    const { ExamAnswerKeyPanel } = await import("../src/apps/answer-card/client/components/ExamAnswerKeyPanel");
    const { TooltipProvider } = await import("../src/apps/answer-card/client/components/ui/v2");
    await act(async () => root.render(createElement(TooltipProvider, null, createElement(ExamAnswerKeyPanel, {
      examId: 1, examName: "识别反馈", open: true, onClose() {},
    }))));
    const files = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(files, "files", { value: [new File(["fixture"], "answers.png", { type: "image/png" })] });
    await act(async () => files.dispatchEvent(new dom.window.Event("change", { bubbles: true })));
    const ocrStatus = document.querySelector('[role="status"]')?.textContent ?? "";
    ok(ocrStatus.includes("第 1 页") && ocrStatus.includes("未识别出答案") && ocrStatus.includes("已改用本地提取") &&
      ocrStatus.includes("第 2 页（AI 视觉识别）") &&
      document.querySelector<HTMLInputElement>('input[aria-label="第 7 题的答案"]')?.value === "AB",
    "答案面板显示空草稿、降级原因和视觉引擎，并填入识别结果");
  } finally {
    await act(async () => root.unmount());
    await new Promise(resolve => setTimeout(resolve, 10));
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}
