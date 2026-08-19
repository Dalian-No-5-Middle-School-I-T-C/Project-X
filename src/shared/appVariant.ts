export type ProjectXAppMode = "home" | "design" | "exam-manage" | "analysis" | "scores" | "account" | "account-settings" | "global-settings" | "admin-console" | "sponsor" | "guide" | "permissions";

export type ProjectXVariant = "student" | "teacher" | "teacher-scanner";

export type NativeResourceSet = "none" | "recognizer" | "scanner";

export interface ProjectXVariantConfig {
  id: ProjectXVariant;
  displayName: string;
  productName: string;
  packageName: string;
  appId: string;
  userDataDir: string;
  defaultMode: ProjectXAppMode;
  allowedModes: ProjectXAppMode[];
  enableScanner: boolean;
  nativeResources: NativeResourceSet;
}

export const DEFAULT_PROJECTX_VARIANT: ProjectXVariant = "teacher-scanner";

export const PROJECTX_VARIANTS: Record<ProjectXVariant, ProjectXVariantConfig> = {
  student: {
    id: "student",
    displayName: "学生端",
    productName: "Project-X 学生端",
    packageName: "projectx-student",
    appId: "cn.projectx.student",
    userDataDir: "answer-card-designer",
    defaultMode: "scores",
    allowedModes: ["scores", "account-settings"],
    enableScanner: false,
    nativeResources: "none"
  },
  teacher: {
    id: "teacher",
    displayName: "教师普通端",
    productName: "Project-X 教师端",
    packageName: "projectx-teacher",
    appId: "cn.projectx.teacher",
    userDataDir: "answer-card-designer",
    defaultMode: "home",
    allowedModes: ["home", "design", "exam-manage", "analysis", "account", "account-settings", "global-settings"],
    enableScanner: false,
    nativeResources: "recognizer"
  },
  "teacher-scanner": {
    id: "teacher-scanner",
    displayName: "教师扫描端",
    productName: "Project-X 教师扫描端",
    packageName: "projectx-teacher-scanner",
    appId: "cn.projectx.teacher-scanner",
    userDataDir: "answer-card-designer",
    defaultMode: "home",
    allowedModes: ["home", "design", "exam-manage", "analysis", "account", "account-settings", "global-settings"],
    enableScanner: true,
    nativeResources: "scanner"
  }
};

export function normalizeProjectXVariant(value: unknown): ProjectXVariant {
  return value === "student" || value === "teacher" || value === "teacher-scanner"
    ? value
    : DEFAULT_PROJECTX_VARIANT;
}

export function getProjectXVariantConfig(value: unknown): ProjectXVariantConfig {
  return PROJECTX_VARIANTS[normalizeProjectXVariant(value)];
}
