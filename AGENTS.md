# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
Project-X (答题卡设计阅卷系统): an answer-card designer, OMR grading, and grade-analysis platform.

**v1.6.1: Split into two build targets:**
- **Web build** (`dist/web/`): Teacher + student pages. No scanner code. Deploy to server.
- **Scanner build** (`dist/scanner/`): ScannerPanel only. Packaged into Electron desktop app.
- **Express API backend** (`src/apps/answer-card/server/index.ts`) on port `5174` — shared by both.
- **Vite + React frontend** on port `5173` (proxies `/api` and `/assets` to `5174`, see `vite.config.ts`).
- **Embedded SQLite** at `data/projectx.db` (auto-created on first run; gitignored via `data/*`).

### Running (dev)
- `npm run dev` starts backend + frontend together (via `concurrently`). The `predev` hook (`scripts/ensure-native-modules.cjs`) auto-rebuilds `better-sqlite3` if its binary is missing/mismatched, so `npm run dev` self-heals native module issues.
- Open `http://127.0.0.1:5173/`. First DB initialization creates username `admin` with a random one-time password in `bootstrap-admin.txt` beside the database; login requires an immediate password change.
- The login API (`POST /api/auth/login`) expects `{ "identifier": ..., "password": ... }` — the field is `identifier` (username/student-no/staff-no), NOT `username`.
- Health check: `GET http://127.0.0.1:5174/api/app/health` → `{"ok":true,...}`.

### Lint / test / build (standard commands live in `package.json`)
- "Lint" = typecheck only (no ESLint configured): `npm run typecheck` (`tsc --noEmit`).
- Tests: `npm run verify:auth` (auth/RBAC suite), `npm run verify:security-critical` (critical security/integrity suite), and `npx tsx scripts/grading-rules-smoke.ts` (grading smoke).
  - NOTE: `verify:auth` 全部 54 项通过（含上一场考试对比与未知班级班级列表）。
- Build:
  - `npm run build` → typecheck + `vite build --mode web` → `dist/web/` + esbuild bundle → `dist/server/`
  - `npm run build:scanner:full` → typecheck + `vite build --mode scanner` → `dist/scanner/` + esbuild bundle → `dist/server/`

### Node version
README states Node 24+ for dev, but the project runs fine on the Node 22 LTS available in this environment (Express 5 / React 19 / Vite 7 / better-sqlite3 12 all work). No need to install Node 24 just to run/test the web product.

### What CANNOT run here (Windows-only / optional)
- **C++ native modules** — `native/AnswerCardRecognizer` (OpenCV OMR) and `native/ScannerBridge` (TWAIN scanner). Their build scripts are Windows `.bat` files with hardcoded paths (VS2022 + OpenCV 4.13) and the scanner needs physical hardware. The app runs without them; OMR scoring / direct-scan features just won't be exercisable on Linux.
- **Electron packaging** (`electron:*` scripts) is Windows-targeted; `npm install --ignore-scripts` skips the Electron binary download, which is fine for web dev.
- **Python LLM service** (`llmclient/`, FastAPI on port `8766`) is optional, only for built-in AI grade analysis, and requires external LLM API keys (`llmclient/.env`). Start with `uvicorn llmclient.server:app --host 127.0.0.1 --port 8766` only if testing AI analysis.

### Install note
Use `npm install --ignore-scripts` (avoids Electron download issues), then `npm rebuild better-sqlite3` to compile the native SQLite binding for the current Node.

## Code of Conduct — 八荣八耻

以瞎猜接口为耻，以认真查询为荣。
以模糊执行为耻，以寻求确认为荣。
以臆想业务为耻，以人类确认为荣。
以创造接口为耻，以复用现有为荣。
以跳过验证为耻，以主动测试为荣。
以破坏架构为耻，以遵循规范为荣。
以假装理解为耻，以诚实无知为荣。
以盲目修改为耻，以谨慎重构为荣。
