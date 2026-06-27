# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
Project-X (答题卡设计系统 / "Intelligent Exam Paper Management System"): an answer-card designer, OMR grading, and grade-analysis platform. The core, runnable-on-Linux product is a single Node app:
- **Express API backend** (`src/apps/answer-card/server/index.ts`) on port `5174`.
- **Vite + React frontend** on port `5173` (proxies `/api` and `/assets` to `5174`, see `vite.config.ts`).
- **Embedded SQLite** at `data/projectx.db` (auto-created on first run; gitignored via `data/*`), **or remote MariaDB 10.11** when `PROJECTX_MARIADB_HOST` / `config.yml` `database.mode: remote` is set (branch `1.6.0beta_双端数据库`).

### Install note
Use `npm install --ignore-scripts` (avoids Electron download issues), then `npm rebuild better-sqlite3` to compile the native SQLite binding for the current Node.

### MariaDB (dual-database mode, optional)
For testing remote DB on Linux cloud desktop:
```bash
sudo apt install -y mariadb-server mariadb-client
bash scripts/ensure-mariadb.sh
MARIADB_APP_PASSWORD='your_password' sudo -E bash scripts/setup-mariadb.sh
```
Then `set -a && source cloud.env && set +a` (see `cloud.env.example`) before `npm run dev`. Health check reports `db.dialect: "mariadb"`. Backup/restore in MariaDB mode needs `mariadb-client` (`mysqldump`).

### Running (dev)
- `npm run dev` starts backend + frontend together (via `concurrently`). The `predev` hook (`scripts/ensure-native-modules.cjs`) auto-rebuilds `better-sqlite3` if its binary is missing/mismatched, so `npm run dev` self-heals native module issues.
- Open `http://127.0.0.1:5173/`. A default admin is seeded on first DB init: username `admin`, password `admin123`.
- The login API (`POST /api/auth/login`) expects `{ "identifier": ..., "password": ... }` — the field is `identifier` (username/student-no/staff-no), NOT `username`.
- Health check: `GET http://127.0.0.1:5174/api/app/health` → `{"ok":true,...}`.

### Lint / test / build (standard commands live in `package.json`)
- "Lint" = typecheck only (no ESLint configured): `npm run typecheck` (`tsc --noEmit`).
- Tests: `npm run verify:auth` (auth/RBAC suite) and `npx tsx scripts/grading-rules-smoke.ts` (grading smoke).
  - NOTE: `verify:auth` currently has **one pre-existing failing case** (`exam class list includes unknown class`) that is unrelated to environment setup — the rest pass. Treat the harness as working.
- Build: `npm run build` (typecheck + `vite build` → `dist/client` + esbuild bundle → `dist/server`).

### Node version
README states Node 24+ for dev, but the project runs fine on the Node 22 LTS available in this environment (Express 5 / React 19 / Vite 7 / better-sqlite3 12 all work). No need to install Node 24 just to run/test the web product.

### What CANNOT run here (Windows-only / optional)
- **C++ native modules** — `native/AnswerCardRecognizer` (OpenCV OMR) and `native/ScannerBridge` (TWAIN scanner). Their build scripts are Windows `.bat` files with hardcoded paths (VS2022 + OpenCV 4.13) and the scanner needs physical hardware. The app runs without them; OMR scoring / direct-scan features just won't be exercisable on Linux.
- **Electron packaging** (`electron:*` scripts) is Windows-targeted; `npm install --ignore-scripts` skips the Electron binary download, which is fine for web dev.
- **Python LLM service** (`llmclient/`, FastAPI on port `8766`) is optional, only for built-in AI grade analysis, and requires external LLM API keys (`llmclient/.env`). Start with `uvicorn llmclient.server:app --host 127.0.0.1 --port 8766` only if testing AI analysis.
