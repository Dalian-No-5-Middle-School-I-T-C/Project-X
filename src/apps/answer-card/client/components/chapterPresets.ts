/**
 * Textbook chapter presets for knowledge point tagging.
 * Structure: subject → textbook → chapter → knowledge points.
 */
export interface ChapterPreset {
  subject: string;
  textbooks: TextbookPreset[];
}

export interface TextbookPreset {
  name: string;       // e.g. "必修一"
  chapters: string[]; // e.g. ["函数", "数列", "三角函数"]
}

export const CHAPTER_PRESETS: ChapterPreset[] = [
  {
    subject: "数学",
    textbooks: [
      { name: "必修一", chapters: ["集合与逻辑", "函数概念与性质", "指数函数与对数函数", "三角函数", "函数应用"] },
      { name: "必修二", chapters: ["平面向量", "复数", "立体几何", "统计", "概率"] },
      { name: "选择性必修一", chapters: ["空间向量", "直线与圆", "圆锥曲线"] },
      { name: "选择性必修二", chapters: ["数列", "导数"] },
      { name: "选择性必修三", chapters: ["计数原理", "概率与统计"] },
    ],
  },
  {
    subject: "语文",
    textbooks: [
      { name: "必修上", chapters: ["现代文阅读", "古诗文阅读", "语言文字运用", "写作"] },
      { name: "必修下", chapters: ["文学阅读", "实用类阅读", "古诗文鉴赏", "议论文写作"] },
    ],
  },
  {
    subject: "英语",
    textbooks: [
      { name: "必修一", chapters: ["词汇与语法", "阅读理解", "完形填空", "写作"] },
      { name: "必修二", chapters: ["词汇拓展", "长难句分析", "七选五", "应用文写作"] },
      { name: "选择性必修", chapters: ["高级语法", "读后续写", "概要写作"] },
    ],
  },
  {
    subject: "物理",
    textbooks: [
      { name: "必修一", chapters: ["运动的描述", "匀变速直线运动", "相互作用", "牛顿运动定律"] },
      { name: "必修二", chapters: ["抛体运动", "圆周运动", "万有引力", "机械能守恒"] },
      { name: "必修三", chapters: ["静电场", "恒定电流", "磁场", "电磁感应", "交变电流"] },
      { name: "选择性必修", chapters: ["动量守恒", "机械振动与波", "光", "原子物理", "热学"] },
    ],
  },
  {
    subject: "化学",
    textbooks: [
      { name: "必修一", chapters: ["物质的量", "离子反应", "氧化还原", "金属及其化合物", "非金属及其化合物"] },
      { name: "必修二", chapters: ["元素周期律", "化学反应与能量", "有机化合物", "化学与可持续发展"] },
      { name: "选择性必修", chapters: ["化学反应原理", "物质结构与性质", "有机化学基础"] },
    ],
  },
  {
    subject: "生物",
    textbooks: [
      { name: "必修一", chapters: ["细胞的分子组成", "细胞的结构", "细胞的代谢", "细胞的生命历程"] },
      { name: "必修二", chapters: ["遗传的基本规律", "基因与染色体", "基因突变与变异", "现代生物进化理论"] },
      { name: "选择性必修", chapters: ["稳态与调节", "生物与环境", "生物技术与工程"] },
    ],
  },
  {
    subject: "政治",
    textbooks: [
      { name: "必修一·中特", chapters: ["社会主义从空想到科学", "中国特色社会主义"] },
      { name: "必修二·经社", chapters: ["基本经济制度", "经济发展与社会进步"] },
      { name: "必修三·政法", chapters: ["党的领导", "人民当家作主", "依法治国"] },
      { name: "必修四·哲学", chapters: ["唯物论", "辩证法", "认识论", "唯物史观", "文化传承与创新"] },
    ],
  },
  {
    subject: "历史",
    textbooks: [
      { name: "必修·中外历史纲要(上)", chapters: ["先秦", "秦汉", "三国至隋唐", "辽宋夏金元", "明清", "晚清", "辛亥革命与民国", "新民主主义革命", "新中国"] },
      { name: "必修·中外历史纲要(下)", chapters: ["古代文明", "中古世界", "全球联系的建立", "工业革命", "马克思主义", "世界大战", "冷战与当代世界"] },
    ],
  },
  {
    subject: "地理",
    textbooks: [
      { name: "必修一", chapters: ["地球与地图", "大气", "水", "地貌", "自然环境的整体性与差异性"] },
      { name: "必修二", chapters: ["人口", "城镇与乡村", "产业与交通", "环境与发展", "区域发展战略"] },
      { name: "选择性必修", chapters: ["区域地理", "资源与国家安全", "环境与国家安全"] },
    ],
  },
];

/**
 * Get chapters for a given subject label (Chinese name).
 */
export function getChaptersForSubject(subjectLabel: string): string[] {
  const preset = CHAPTER_PRESETS.find(
    (p) => p.subject === subjectLabel
  );
  if (!preset) return [];
  const chapters: string[] = [];
  for (const book of preset.textbooks) {
    for (const ch of book.chapters) {
      chapters.push(`${book.name}·${ch}`);
    }
  }
  return chapters;
}
