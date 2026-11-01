import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAnswerCardDataDir } from "../db/paths";
import { requireServiceRecovery } from "./serviceTasks";

export function restoreRecoveryMarkerPath(): string {
  return path.join(path.dirname(resolveAnswerCardDataDir()), "projectx-restore-state.json");
}

/** An interrupted replacement must not reopen the application on a mixed data set. */
export function loadRestoreRecoveryState(): boolean {
  if (!existsSync(restoreRecoveryMarkerPath())) return false;
  requireServiceRecovery();
  return true;
}

export async function writeRestoreRecoveryState(state: Record<string, unknown>): Promise<void> {
  const marker = restoreRecoveryMarkerPath();
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(`${marker}.tmp`, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
  await rename(`${marker}.tmp`, marker);
}

export async function clearRestoreRecoveryState(): Promise<void> {
  await rm(restoreRecoveryMarkerPath(), { force: true });
}
