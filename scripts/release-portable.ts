import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json";

type ReleaseVariant = "student" | "teacher";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const version = packageJson.version;
const arch = "x64";

const variants: Array<{ id: ReleaseVariant; productName: string; uploadName: string }> = [
  { id: "student", productName: "Project-X 学生端", uploadName: `Project-X-学生端-${version}-${arch}.exe` },
  { id: "teacher", productName: "Project-X 教师端", uploadName: `Project-X-教师端-${version}-${arch}.exe` }
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

function findPortableExe(variant: ReleaseVariant): string {
  const releaseDir = path.join(rootDir, "release", variant);
  const expected = `${variants.find((item) => item.id === variant)!.productName}-${version}-${arch}.exe`;
  const direct = path.join(releaseDir, expected);
  if (existsSync(direct)) {
    return direct;
  }

  const matches = readdirSync(releaseDir).filter((name) => name.endsWith(".exe"));
  if (matches.length === 1) {
    return path.join(releaseDir, matches[0]);
  }

  throw new Error(`Portable EXE not found in ${releaseDir}. Expected ${expected}`);
}

function packageVariant(variant: ReleaseVariant): string {
  const npmScript = variant === "student" ? "electron:dist:student" : "electron:dist:teacher";
  console.log(`[Project-X] Building portable EXE for ${variant}...`);
  run(command("npm"), ["run", npmScript]);

  const source = findPortableExe(variant);
  const outputDir = path.join(rootDir, "release", "upload");
  mkdirSync(outputDir, { recursive: true });
  const target = path.join(outputDir, variants.find((item) => item.id === variant)!.uploadName);
  copyFileSync(source, target);
  console.log(`[Project-X] Ready: ${target}`);
  return target;
}

const artifacts = variants.map((variant) => packageVariant(variant.id));
console.log("\n[Project-X] Portable release artifacts:");
for (const artifact of artifacts) {
  console.log(`- ${artifact}`);
}
