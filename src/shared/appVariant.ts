export type ProjectXAppMode = "design" | "grading" | "analysis" | "scores" | "account";

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
    allowedModes: ["scores"],
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
    defaultMode: "design",
    allowedModes: ["design", "grading", "analysis", "account"],
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
    defaultMode: "grading",
    allowedModes: ["design", "grading", "analysis", "account"],
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
