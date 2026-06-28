import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

// ── 类型 ───────────────────────────────────────────────

export interface MariadbRemoteConfig {
  host: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface DatabaseConfig {
  mode: "local" | "remote";
  remote?: MariadbRemoteConfig;
}

export interface AppConfig {
  database?: DatabaseConfig;
}

// ── 路径 ───────────────────────────────────────────────

function configPath(): string {
  return path.join(process.cwd(), "config.yml");
}

// ── 读取 ───────────────────────────────────────────────

/**
 * 读取 config.yml
 * 返回 AppConfig 或 null（文件不存在/格式错误）
 */
export function readConfigFile(): AppConfig | null {
  const filePath = configPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim() || raw.trim() === "{}") return {};
    return parseYaml(raw) as AppConfig;
  } catch (err) {
    console.warn("[Config] Failed to read config.yml:", err);
    return null;
  }
}

/**
 * 写入 config.yml（合并模式）
 * 只更新传入的字段，保留其他字段不变
 */
export function writeConfigFile(partial: Partial<AppConfig>): void {
  const existing = readConfigFile() ?? {};
  const merged = deepMerge(existing, partial);
  const yaml = stringifyYaml(merged);
  writeFileSync(configPath(), yaml, "utf8");
}

/**
 * 读取数据库配置
 */
export function readDbConfig(): DatabaseConfig {
  const config = readConfigFile();
  return config?.database ?? { mode: "local" };
}

/**
 * 写入数据库配置
 */
export function writeDbConfig(db: DatabaseConfig): void {
  writeConfigFile({ database: db });
}

// ── 简易 YAML 解析（免外部依赖）──────────────────────

function parseYaml(raw: string): any {
  const result: any = {};
  const lines = raw.split("\n");
  const stack: Array<{ key: string; obj: any }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const indent = line.search(/\S/);
    const depth = Math.floor(indent / 2);

    // Pop stack to correct depth
    while (stack.length > depth) stack.pop();

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    const parent = stack.length > 0 ? stack[stack.length - 1].obj : result;

    if (value === "" || value === "{}") {
      // Nested object
      const child: any = {};
      parent[key] = child;
      stack.push({ key, obj: child });
    } else {
      // Scalar value
      parent[key] = parseYamlValue(value);
    }
  }

  return result;
}

function parseYamlValue(v: string): any {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (/^\d+\.\d+$/.test(v)) return parseFloat(v);
  // Strip quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function stringifyYaml(obj: any, indent = 0): string {
  if (obj === null || obj === undefined) return "null\n";
  if (typeof obj !== "object") return `${obj}\n`;

  const lines: string[] = [];
  const prefix = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${prefix}${key}: null`);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(stringifyYaml(value, indent + 1).trimEnd());
    } else if (typeof value === "string") {
      // Quote strings that need it
      const needsQuote = /[:#\{\}\[\],&*?!|>'"@`]/.test(value) || value === "" || value.includes("\n");
      lines.push(`${prefix}${key}: ${needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value}`);
    } else {
      lines.push(`${prefix}${key}: ${value}`);
    }
  }

  return lines.join("\n") + "\n";
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
