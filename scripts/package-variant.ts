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
type PackageArch = "x64" | "ia32";
type PackageVariant = ProjectXVariant | "all";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const allProjectXVariants: ProjectXVariant[] = ["student", "teacher", "teacher-scanner"];
const allPackageArchs: PackageArch[] = ["x64", "ia32"];

function normalizeVariant(value: string | undefined): PackageVariant {
  if (value === "all" || value === "student" || value === "teacher" || value === "teacher-scanner") {
    return value;
  }
  throw new Error("Usage: tsx scripts/package-variant.ts <all|student|teacher|teacher-scanner> <dir|portable|msi> [x64|ia32]");
}

function normalizeTarget(value: string | undefined): PackageTarget {
  if (value === "dir" || value === "portable" || value === "msi") {
    return value;
  }
  throw new Error("Usage: tsx scripts/package-variant.ts <all|student|teacher|teacher-scanner> <dir|portable|msi> [x64|ia32]");
}

function normalizeArch(value: string | undefined): PackageArch {
  if (!value || value === "x64") {
    return "x64";
  }
  if (value === "ia32") {
    return value;
  }
  throw new Error("Usage: tsx scripts/package-variant.ts <all|student|teacher|teacher-scanner> <dir|portable|msi> [x64|ia32]");
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

function nativeResourceDirFor(arch: PackageArch): string {
  return arch === "ia32" ? "win-ia32" : "win-x64";
}

function nativeResourcesFor(config: ProjectXVariantConfig, arch: PackageArch): unknown[] {
  if (config.nativeResources === "none") {
    return [];
  }

  const filters =
    config.nativeResources === "scanner"
      ? ["answer-card-recognizer.exe", "opencv_world4130.dll", "scanner-bridge.exe", "TWAINDSM.dll"]
      : ["answer-card-recognizer.exe", "opencv_world4130.dll"];

  const resourceDir = nativeResourceDirFor(arch);
  return [
    {
      from: `resources/native/${resourceDir}`,
      to: `native/${resourceDir}`,
      filter: filters
    }
  ];
}

function electronBuilderConfig(config: ProjectXVariantConfig, target: PackageTarget, arch: PackageArch): Record<string, unknown> {
  const targetName = target === "dir" ? "portable" : target;
  const builderConfig: Record<string, unknown> = {
    extends: null,
    appId: config.appId,
    productName: config.productName,
    directories: {
      output: arch === "x64" ? `release/${config.id}` : `release/${config.id}-${arch}`
    },
    files: ["dist/client/**/*", "dist/server/**/*", "electron/**/*", "package.json"],
    extraResources: nativeResourcesFor(config, arch),
    extraMetadata: {
      name: config.packageName,
      productName: config.productName,
      projectxVariant: config.id,
      projectxArch: arch
    },
    asar: true,
    win: {
      icon: "resources/icon.png",
      executableName: config.productName,
      signAndEditExecutable: false,
      target: [
        {
          target: targetName,
          arch: [arch]
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

  if (arch === "x64") {
    builderConfig.electronDist = "node_modules/electron/dist";
  }

  return builderConfig;
}

function packageVariant(config: ProjectXVariantConfig, target: PackageTarget, arch: PackageArch): void {
  const env = {
    ...process.env,
    PROJECTX_VARIANT: config.id,
    PROJECTX_ENABLE_SCANNER: config.enableScanner ? "1" : "0",
    VITE_PROJECTX_VARIANT: config.id,
    ELECTRON_CACHE: path.join(rootDir, ".electron-cache"),
    ELECTRON_BUILDER_CACHE: path.join(rootDir, ".electron-builder-cache")
  };
  mkdirSync(env.ELECTRON_BUILDER_CACHE, { recursive: true });
  writeFileSync(
    path.join(env.ELECTRON_BUILDER_CACHE, "package.json"),
    JSON.stringify({ private: true, type: "commonjs" }, null, 2),
    "utf8"
  );

  console.log(`[Project-X] Packaging ${config.displayName} (${config.id}) as ${target} for ${arch}...`);
  run(command("npm"), ["run", "build"], env);

  const electronRebuildBin = path.join(rootDir, "node_modules", ".bin", command("electron-rebuild"));
  const rebuildArgs = arch === "ia32"
    ? ["-f", "-a", "ia32", "-w", "better-sqlite3"]
    : ["-f", "-w", "better-sqlite3"];

  const generatedDir = path.join(rootDir, "dist", "package-variants");
  mkdirSync(generatedDir, { recursive: true });
  const configPath = path.join(generatedDir, `electron-builder-${config.id}-${target}-${arch}.json`);
  writeFileSync(configPath, JSON.stringify(electronBuilderConfig(config, target, arch), null, 2), "utf8");

  const builderBin = path.join(rootDir, "node_modules", ".bin", command("electron-builder"));
  const builderArgs = target === "dir"
    ? ["--config", configPath, "--dir", `--${arch}`]
    : ["--config", configPath, "--win", target, `--${arch}`];
  try {
    run(electronRebuildBin, rebuildArgs, env);
    run(builderBin, builderArgs, env);
  } finally {
    if (arch === "ia32") {
      run(command("npm"), ["run", "native:rebuild:node"], env);
    }
  }
}

const variant = normalizeVariant(process.argv[2]);
const target = normalizeTarget(process.argv[3]);
const archArg = process.argv[4] ? normalizeArch(process.argv[4]) : undefined;
const variants = variant === "all" ? allProjectXVariants : [variant];
const archs = archArg ? [archArg] : variant === "all" ? allPackageArchs : ["x64"];

for (const selectedArch of archs) {
  for (const selectedVariant of variants) {
    packageVariant(getProjectXVariantConfig(selectedVariant), target, selectedArch);
  }
}
