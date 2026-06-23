import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";

type ReleaseVariant = {
  id: "student" | "teacher" | "teacher-scanner";
  archiveName: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const version = packageJson.version;

const variants: ReleaseVariant[] = [
  { id: "student", archiveName: `student${version}.7z` },
  { id: "teacher", archiveName: "teacher.7z" },
  { id: "teacher-scanner", archiveName: `teacher-scanner${version}.7z` }
];

function command(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(name: string, args: string[], cwd = rootDir): void {
  const result = spawnSync(name, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function find7z(): string {
  const candidates = ["7z", "7za"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-h"], { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return candidate;
    }
  }
  throw new Error("7z is required to create release archives. Install p7zip-full or 7-Zip.");
}

function assertWinUnpacked(variant: ReleaseVariant): string {
  const releaseDir = path.join(rootDir, "release", variant.id);
  const winUnpacked = path.join(releaseDir, "win-unpacked");
  if (!existsSync(winUnpacked)) {
    throw new Error(`Missing ${winUnpacked}. Run npm run electron:pack:${variant.id === "teacher-scanner" ? "scanner" : variant.id} first.`);
  }
  const exeName = variant.id === "student"
    ? "Project-X 学生端.exe"
    : variant.id === "teacher"
      ? "Project-X 教师端.exe"
      : "Project-X 教师扫描端.exe";
  const exePath = path.join(winUnpacked, exeName);
  if (!existsSync(exePath)) {
    throw new Error(`Expected executable not found: ${exePath}`);
  }
  return winUnpacked;
}

function createArchive(variant: ReleaseVariant, sevenZip: string): void {
  const winUnpacked = assertWinUnpacked(variant);
  const outputDir = path.join(rootDir, "release", "upload");
  mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, variant.archiveName);
  if (existsSync(archivePath)) {
    rmSync(archivePath);
  }

  console.log(`[Project-X] Creating ${variant.archiveName} from ${winUnpacked}...`);
  run(sevenZip, ["a", "-t7z", "-mx=5", archivePath, "win-unpacked"], path.join(rootDir, "release", variant.id));
}

function listArtifacts(sevenZip: string): void {
  const outputDir = path.join(rootDir, "release", "upload");
  console.log("\n[Project-X] Release artifacts:");
  for (const entry of readdirSync(outputDir)) {
    if (!entry.endsWith(".7z")) continue;
    const archivePath = path.join(outputDir, entry);
    const result = spawnSync(sevenZip, ["l", archivePath], { encoding: "utf8" });
    const exeLine = result.stdout.split("\n").find((line) => line.includes(".exe") && !line.includes("Uninstall"));
    console.log(`- ${entry}${exeLine ? ` (${exeLine.trim()})` : ""}`);
  }
}

const sevenZip = find7z();
for (const variant of variants) {
  createArchive(variant, sevenZip);
}
listArtifacts(sevenZip);
