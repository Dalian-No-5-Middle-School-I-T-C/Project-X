// 预定义科目名称 → 拼音 key 映射
const SUBJECT_KEY_MAP: Record<string, string> = {
  语文: "yuwen",
  数学: "shuxue",
  英语: "yingyu",
  外语: "waiyu",
  物理: "wuli",
  化学: "huaxue",
  生物: "shengwu",
  政治: "zhengzhi",
  历史: "lishi",
  地理: "dili",
  信息技术: "xinxi",
  信息科技: "xinxi",
  科学: "kexue",
  体育: "tiyu",
  音乐: "yinyue",
  美术: "meishu",
  通用技术: "tongyong",
  心理: "xinli",
  综合: "zonghe"
};

// 常用汉字 → 拼音映射（仅用于未命中的自定义科目名）
const PINYIN_MAP: Record<string, string> = {
  // 常用科目字
  语: "yu", 文: "wen", 数: "shu", 学: "xue",
  英: "ying", 外: "wai", 物: "wu", 理: "li",
  化: "hua", 生: "sheng", 政: "zhi", 治: "zhi",
  历: "li", 史: "shi", 地: "di",
  信: "xin", 息: "xi", 科: "ke", 技: "ji",
  体: "ti", 育: "yu", 音: "yin", 乐: "yue",
  美: "mei", 术: "shu", 通: "tong", 用: "yong",
  心: "xin", 综: "zong",
  // 扩展字
  德: "de", 劳: "lao", 马: "ma", 克: "ke", 思: "si",
  道: "dao", 品: "pin", 社: "she", 会: "hui",
  工: "gong", 程: "cheng", 制: "zhi", 造: "zao",
  设: "she", 计: "ji", 编: "bian",
  机: "ji", 器: "qi", 人: "ren",
  合: "he", 实: "shi", 践: "jian",
  阅: "yue", 读: "du", 写: "xie", 作: "zuo",
  书: "shu", 法: "fa", 绘: "hui", 画: "hua",
  手: "shou", 航: "hang", 天: "tian",
  经: "jing", 济: "ji",
  自: "zi", 然: "ran",
};

/**
 * 将中文科目名称转换为拼音 key
 * - 命中预定义科目 → 使用固定 key
 * - 上述9科以外 → 逐字转拼音，去重连接，最多 16 个字符
 */
export function subjectToKey(name: string): string {
  const trimmed = name.trim();
  // 精确命中预定义
  const mapped = SUBJECT_KEY_MAP[trimmed];
  if (mapped) return mapped;

  // 逐字转拼音
  const pinyins: string[] = [];
  const seen = new Set<string>();
  for (const char of trimmed) {
    const py = PINYIN_MAP[char];
    if (py && !seen.has(py)) {
      pinyins.push(py);
      seen.add(py);
    }
  }
  const result = pinyins.join("");
  return result.slice(0, 16) || "zhinan";
}

export const SUBJECT_OPTIONS = [
  { label: "语文", key: "yuwen" },
  { label: "数学", key: "shuxue" },
  { label: "英语", key: "yingyu" },
  { label: "物理", key: "wuli" },
  { label: "化学", key: "huaxue" },
  { label: "生物", key: "shengwu" },
  { label: "政治", key: "zhengzhi" },
  { label: "历史", key: "lishi" },
  { label: "地理", key: "dili" },
  { label: "其他", key: "other" }
] as const;

export function isPredefinedSubject(label: string): boolean {
  return label in SUBJECT_KEY_MAP;
}
