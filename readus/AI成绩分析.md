# AI 成绩分析工具说明

> **适用版本**: v1.3.0 及以上
> **适用对象**: 教师、管理员、开发者 / 运维
> **关联文档**: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md) · [`多端使用说明.md`](./多端使用说明.md)

Project-X v1.2.0 在「分析 → 成绩分析」中新增 AI 成绩分析卡片，位置在「分数统计分布」之后、「学生排名」之前。首版采用手动点击生成，不缓存、不落库、不做流式输出。

AI 报告只读取当前考试和当前班级筛选范围内的成绩统计数据，不允许模型执行任意 SQL，也不会把学生个人姓名作为分析素材返回给模型。

v1.3.0 的学科模板和题级评分规则会影响落库后的 `question_scores` 明细；AI 工具仍通过同一套成绩聚合接口读取数据，不直接读取答题卡模板或原始识别图片。

---

## 1. 使用方式

1. 先启动 Python 中转服务：

```powershell
py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
```

2. 再启动 Electron 或 Web 开发环境。
3. 进入「分析 → 成绩分析」，选择考试和班级筛选。
4. 在 AI 成绩分析卡片中选择可用模型，点击「生成分析」。

Python 服务未启动、数据库路径不可访问、或当前 provider 没有配置 API Key 时，前端会禁用生成按钮并显示原因。

---

## 2. 环境变量

`llmclient` 会优先读取 `llmclient/.env`，也支持系统环境变量。

| 变量 | 说明 |
|------|------|
| `GEMINI_API_KEY` | Gemini 模型 API Key |
| `DEEPSEEK_API_KEY` | DeepSeek 模型 API Key |
| `OPENAI_API_KEY` | OpenAI 兼容模型 API Key |
| `OPENAI_BASE_URL` | OpenAI 兼容服务的可选 Base URL |
| `PROJECTX_DB_PATH` | Project-X SQLite 数据库路径 |
| `LLMCLIENT_INTERNAL_API_KEY` | Node → Python 内部调用鉴权 Key；为空时本地开发不强制鉴权 |
| `LLMCLIENT_DEFAULT_MODEL` | 默认模型，默认 `gemini-3.1-flash-lite` |

开发环境默认数据库路径是 `data/projectx.db`；Electron 运行时建议指向：

```text
%APPDATA%\answer-card-designer\data\projectx.db
```

---

## 3. 模型与思考模式

当前内置模型：

| 模型 | Provider | 默认思考 |
|------|----------|----------|
| `gemini-3.1-flash-lite` | Gemini | 开启，`thinking_level=high` |
| `gemini-3.5-flash` | Gemini | 开启，`thinking_level=high` |
| `deepseek-v4-flash` | DeepSeek | 开启，`reasoning_effort=high` |
| `deepseek-v4-pro` | DeepSeek | 开启，`reasoning_effort=high` |
| `gpt-5.5` | OpenAI | 开启，`reasoning_effort=high` |
| `gpt-5.4-mini` | OpenAI | 开启，`reasoning_effort=high` |

DeepSeek V4 thinking 模式下，`temperature`、`top_p`、`presence_penalty`、`frequency_penalty` 不传入请求，避免配置项看似生效但实际被服务端忽略。工具调用多轮对话会保留 assistant 消息中的 `reasoning_content`，但不会返回前端展示。

GPT 模型走 OpenAI 兼容接口，使用 `OPENAI_API_KEY`，可通过 `OPENAI_BASE_URL` 指向兼容服务；内置 GPT 模型默认同样传入 `reasoning_effort=high`。

---

## 4. 工具白名单

模型只能调用以下工具读取成绩数据：

| 工具 | 用途 |
|------|------|
| `get_exam_overview` | 读取考试名称、科目、总体统计 |
| `get_score_distribution` | 读取分数段与四分位统计 |
| `get_class_summaries` | 读取各班成绩摘要 |
| `get_question_analysis` | 读取低得分率题目 |
| `get_rank_segments` | 读取匿名排名分段统计 |
| `get_review_risks` | 读取错误率或低分率偏高题目，按低 / 中 / 高分档 |

工具层会强制校验 `examId` 和当前班级筛选范围；模型传入多余参数时会被过滤，不会直接进入数据库层。

---

## 5. Node / Electron 集成

Node 后端新增两个接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/analysis/ai/status` | 探测 Python 服务、数据库路径和可用模型 |
| `POST` | `/api/analysis/exams/:examId/ai-analysis` | 转发当前考试与班级范围，生成结构化 AI 报告 |

Electron 主进程仍优先尝试 `127.0.0.1:5174` 启动本地 Express。若该端口被占用或被系统拒绝绑定（例如 `EADDRINUSE` / `EACCES`），会自动切换到随机端口，并通过 `/api/app/health` 做真实 HTTP 探活；只有本地接口可访问后才加载窗口，避免出现只有前端空壳、接口不可用的状态。

---

## 6. 本地验证

```powershell
py -m compileall llmclient
py llmclient\scripts\tool_smoke.py --exam-id <examId>
py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
npm.cmd run typecheck
npm.cmd run build:server
```

如需验证 Electron 源码启动：

```powershell
node_modules\.bin\electron.cmd .
```

若 `5174` 端口不可用，日志中应出现 fallback 到随机端口的信息，窗口仍应正常打开。
