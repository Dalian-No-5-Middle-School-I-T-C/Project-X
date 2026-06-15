import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProjectXVariantConfig,
  type ProjectXVariant,
  type ProjectXVariantConfig
} from "../src/shared/appVariant";
import packageJson from "../package.json";

type PackageTarget = "dir" | "portable" | "msi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function normalizeVariant(value: string | undefined): ProjectXVariant {
  if (value === "student" || value === "teacher" || value === "teacher-scanner") {
    return value;
  }
  throw new Error("Usage: tsx scripts/package-variant.ts <student|teacher|teacher-scanner> <dir|portable|msi>");
}

function normalizeTarget(value: string | undefined): PackageTarget {
  if (value === "dir" || value === "portable" || value === "msi") {
    return value;
  }
  throw new Error("Usage: tsx scripts/package-variant.ts <student|teacher|teacher-scanner> <dir|portable|msi>");
}

function command(name: string): string {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(name: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(name, args, {
    cwd: rootDir,
    env,
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

function nativeResourcesFor(config: ProjectXVariantConfig): unknown[] {
  if (config.nativeResources === "none") {
    return [];
  }

  const filters =
    config.nativeResources === "scanner"
      ? ["answer-card-recognizer.exe", "opencv_world4130.dll", "scanner-bridge.exe", "TWAINDSM.dll"]
      : ["answer-card-recognizer.exe", "opencv_world4130.dll"];

  return [
    {
      from: "resources/native/win-x64",
      to: "native/win-x64",
      filter: filters
    }
  ];
}

function electronBuilderConfig(config: ProjectXVariantConfig, target: PackageTarget): Record<string, unknown> {
  const targetName = target === "dir" ? "portable" : target;
  return {
    extends: null,
    appId: config.appId,
    productName: config.productName,
    electronDist: "node_modules/electron/dist",
    directories: {
      output: `release/${config.id}`
    },
    files: ["dist/client/**/*", "dist/server/**/*", "electron/**/*", "package.json"],
    extraResources: nativeResourcesFor(config),
    extraMetadata: {
      name: config.packageName,
      productName: config.productName,
      projectxVariant: config.id
    },
    asar: true,
    win: {
      icon: "resources/icon.png",
      executableName: config.productName,
      signAndEditExecutable: false,
      target: [
        {
          target: targetName,
          arch: ["x64"]
        }
      ],
      artifactName: `${config.productName}-${packageJson.version}-\${arch}.\${ext}`
    },
    msi: {
      artifactName: `${config.productName}-${packageJson.version}-\${arch}.\${ext}`,
      shortcutName: config.productName,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      perMachine: false
    }
  };
}

const variant = normalizeVariant(process.argv[2]);
const target = normalizeTarget(process.argv[3]);
const config = getProjectXVariantConfig(variant);
const env = {
  ...process.env,
  PROJECTX_VARIANT: config.id,
  PROJECTX_ENABLE_SCANNER: config.enableScanner ? "1" : "0",
  VITE_PROJECTX_VARIANT: config.id,
  ELECTRON_BUILDER_CACHE: path.join(rootDir, ".electron-builder-cache")
};

console.log(`[Project-X] Packaging ${config.displayName} (${config.id}) as ${target}...`);
run(command("npm"), ["run", "build"], env);
run(command("npm"), ["run", "native:rebuild:electron"], env);

const generatedDir = path.join(rootDir, "dist", "package-variants");
mkdirSync(generatedDir, { recursive: true });
const configPath = path.join(generatedDir, `electron-builder-${config.id}-${target}.json`);
writeFileSync(configPath, JSON.stringify(electronBuilderConfig(config, target), null, 2), "utf8");

const builderBin = path.join(rootDir, "node_modules", ".bin", command("electron-builder"));
const builderArgs = target === "dir"
  ? ["--config", configPath, "--dir"]
  : ["--config", configPath, "--win", target];
run(builderBin, builderArgs, env);
