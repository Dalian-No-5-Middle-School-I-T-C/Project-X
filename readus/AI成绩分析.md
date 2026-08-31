# AI 成绩分析工具说明

> **适用版本**: v1.4.0 及以上
> **适用对象**: 教师、管理员、开发者 / 运维
> **关联文档**: [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`ADMIN-GUIDE.md`](./ADMIN-GUIDE.md) · [`多端使用说明.md`](./多端使用说明.md)

Project-X v1.2.0 在「分析 → 成绩分析」中新增 AI 成绩分析卡片。v1.4.0 扩展为多服务商架构，支持 GPT、DeepSeek、Gemini 三线路。v1.4.7 修复 Gemini 自定义服务商路由 Bug，Gemini 使用 Google 原生 GenAI SDK（不需 Base URL）。v1.10.0 起 **大考（考试组）详情页也内置 AI 分析**，且成绩工具返回体新增 **难度系数 P** 与 **区分度 D**，供模型判断试卷难易与题目区分能力。

AI 报告只读取当前考试和当前班级筛选范围内的成绩统计数据，不允许模型执行任意 SQL，也不会把学生个人姓名作为分析素材返回给模型。

---

## 1. 使用方式

### A. 内置服务商（llmclient）

先安装依赖并配置密钥（一次性）：

```powershell
py -m pip install -r llmclient/requirements.txt
Copy-Item llmclient/.env.example llmclient/.env   # 然后填写至少一家服务商的 API Key
```

启动 Python 中转服务（v2.2.2 起后端启动时会自动尝试拉起，可省略本步）：

```powershell
py -m uvicorn llmclient.server:app --host 127.0.0.1 --port 8766
```

若出现 `No module named uvicorn`，说明依赖未安装，请先执行上一步 `pip install`。进入「分析 → 成绩分析」，选择「内置 LLM 服务」→ 下拉选择模型 → 点击「生成分析」。**大考（考试组）详情页的「AI 分析」Tab 同样可用**，请求仅携带 `groupId`，由 Python 侧解析成员考试后逐科汇总。

Python 服务未启动、数据库路径不可访问、或当前 provider 没有配置 API Key 时，前端会禁用生成按钮并显示原因。

### B. 自定义服务商（v1.4.0 新增）

无需 llmclient 配置环境变量，直接在账号设置中配置：

1. 进入「账号设置」→「AI 服务商」→「添加」
2. 选择类型：GPT（OpenAI兼容）/ DeepSeek / Gemini
3. 填写 Base URL（GPT/DeepSeek 必填；**Gemini 无需填写 Base URL**，仅需 API Key）
   Gemini 使用 Google 原生 GenAI SDK，可通过 <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a> 免费获取 API Key
4. 进入 AI 分析面板，选择你配置的服务商 → 输入模型名 → 生成分析

服务商配置保存在 `ai_providers` 表中，每个教师可配置多个服务商。

---

## 2. 环境变量（内置服务商）

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

**自定义服务商不使用这些环境变量**，API Key 和 Base URL 由数据库 `ai_providers` 表管理。

---

## 3. 模型与思考模式

### 内置模型

| 模型 | Provider | 默认思考 |
|------|----------|----------|
| `gemini-3.1-flash-lite` | Gemini | 开启，`thinking_level=high` |
| `gemini-3.5-flash` | Gemini | 开启，`thinking_level=high` |
| `deepseek-v4-flash` | DeepSeek | 开启，`reasoning_effort=high` |
| `deepseek-v4-pro` | DeepSeek | 开启，`reasoning_effort=high` |
| `deepseek-v4-flash-vision-exp` | DeepSeek | 开启，`reasoning_effort=high`（支持图像直读，用于原卷扫描件知识点分析） |
| `gpt-5.5` | OpenAI | 开启，`reasoning_effort=high` |
| `gpt-5.4-mini` | OpenAI | 开启，`reasoning_effort=high` |

### 自定义服务商模型

自定义服务商走 OpenAI 兼容接口。在账号设置中配置模型列表（逗号分隔）后，AI 分析面板的模型输入框会提供 datalist 建议。未配置时手动输入模型名即可。

---

## 4. 工具白名单

模型只能调用以下工具读取成绩数据：

| 工具 | 用途 |
|------|------|
| `get_exam_overview` | 读取考试名称、科目、总体统计；**返回难度 P 与区分度 D** |
| `get_score_distribution` | 读取分数段与四分位统计 |
| `get_class_summaries` | 读取各班成绩摘要 |
| `get_question_analysis` | 读取低得分率题目；**每题返回难度 P 与区分度 D** |
| `get_rank_segments` | 读取匿名排名分段统计 |
| `get_review_risks` | 读取错误率或低分率偏高题目，按低 / 中 / 高分档 |

工具层会强制校验 `examId` 和当前班级筛选范围；模型传入多余参数时会被过滤，不会直接进入数据库层。**大考模式**下，Node 仅传 `groupId`，Python 侧 `get_group_exam_ids` 解析出成员考试集合后下传工具层；工具层会强制要求模型传入的 `examId` 属于该大考成员，否则返回错误，确保模型不能越权读取其它考试。P / D 数值属于聚合统计量，仍不携带学生姓名，延续既有白名单。

---

## 5. Node / Electron 集成

Node 后端新增接口：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/analysis/ai/status` | 探测 Python 服务 + 用户自定义服务商 |
| `POST` | `/api/analysis/exams/:examId/ai-analysis` | 转发当前考试，支持 providerId 参数 |
| `POST` | `/api/exam-groups/:groupId/ai-analysis` | 转发大考（仅传 groupId），Python 侧解析成员考试后逐科汇总 |

### 自定义服务商 API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/ai/providers` | 列表当前教师的所有服务商 |
| `POST` | `/api/ai/providers` | 创建服务商 |
| `PUT` | `/api/ai/providers/:id` | 更新服务商 |
| `DELETE` | `/api/ai/providers/:id` | 删除服务商 |

Electron 主进程仍优先尝试 `127.0.0.1:5174` 启动本地 Express。

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
