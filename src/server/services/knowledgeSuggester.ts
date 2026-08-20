/**
 * 知识点半自动标注（建议 8，第一步：静态词典 + 关键词匹配）。
 *
 * 对答题卡上「有题干文本的位置」匹配候选知识点——客观题在数据模型里没有独立题干
 * （仅有题号/分值），实际可匹配的是解答题的 `annotation`（题干注释）与块标题。
 * 匹配结果只做候选提示，由人工确认后批量写入 knowledge_points（下游分析零改动）。
 */
import { CardRepository } from "../repositories/CardRepository";
import type { AnswerCard, KnowledgeSuggestionItem, KnowledgeSuggestResponse } from "../../shared/types";

interface DictRule {
  keywords: string[];
  point: string;
}

const DICTIONARY: Record<string, DictRule[]> = {
  数学: [
    { keywords: ["函数", "定义域", "值域", "奇偶", "单调", "零点", "图像", "对称"], point: "函数性质" },
    { keywords: ["导数", "切线", "极值", "最值", "单调区间", "原函数"], point: "导数" },
    { keywords: ["三角函数", "正弦", "余弦", "正切", "三角恒等", "解三角"], point: "三角函数" },
    { keywords: ["数列", "等差", "等比", "通项", "前n项和", "递推"], point: "数列" },
    { keywords: ["不等式", "均值不等式", "线性规划", "恒成立"], point: "不等式" },
    { keywords: ["立体几何", "三视图", "空间向量", "体积", "表面积", "平行", "垂直", "夹角", "二面角"], point: "立体几何" },
    { keywords: ["解析几何", "椭圆", "双曲线", "抛物线", "直线与圆", "离心率", "焦点", "准线"], point: "解析几何" },
    { keywords: ["概率", "排列", "组合", "二项式", "期望", "方差", "随机变量", "分布列"], point: "概率统计" },
    { keywords: ["向量的坐标", "平面向量", "数量积", "共线", "垂直"], point: "平面向量" },
    { keywords: ["复数", "虚部", "实部", "模"], point: "复数" },
    { keywords: ["集合", "子集", "交集", "并集", "补集"], point: "集合" },
    { keywords: ["充要条件", "命题", "逻辑", "全称", "存在"], point: "常用逻辑" },
  ],
  物理: [
    { keywords: ["加速度", "匀变速", "自由落体", "位移", "速度", "牛顿", "受力分析", "摩擦力"], point: "力学" },
    { keywords: ["运动学", "曲线运动", "平抛", "圆周运动"], point: "运动学" },
    { keywords: ["功", "功率", "动能", "势能", "机械能", "能量守恒"], point: "能量" },
    { keywords: ["动量", "冲量", "碰撞"], point: "动量" },
    { keywords: ["电场", "电势", "场强", "电容", "库仑"], point: "电场" },
    { keywords: ["磁场", "安培力", "洛伦兹", "带电粒子", "回旋加速"], point: "磁场" },
    { keywords: ["电磁感应", "法拉第", "楞次", "感应电动势"], point: "电磁感应" },
    { keywords: ["电路", "欧姆定律", "电功率", "焦耳热", "闭合电路"], point: "电路" },
    { keywords: ["光学", "折射", "反射", "全反射", "干涉", "衍射"], point: "光学" },
    { keywords: ["热学", "气体", "理想气体", "内能", "热力学"], point: "热学" },
  ],
  化学: [
    { keywords: ["氧化还原", "氧化剂", "还原剂", "化合价"], point: "氧化还原" },
    { keywords: ["离子方程", "离子共存", "电荷守恒"], point: "离子反应" },
    { keywords: ["化学平衡", "平衡常数", "勒夏特列", "转化率"], point: "化学平衡" },
    { keywords: ["电离", "电解质", "非电解质", "水解", "pH"], point: "电离与水解" },
    { keywords: ["有机", "烷烃", "烯烃", "苯", "官能团", "同分异构", "反应类型"], point: "有机化学" },
    { keywords: ["元素周期", "原子结构", "化学键", "离子键", "共价键"], point: "物质结构与周期律" },
    { keywords: ["实验", "除杂", "检验", "气体制备", "实验设计"], point: "化学实验" },
  ],
  生物: [
    { keywords: ["细胞结构", "细胞器", "细胞膜", "细胞核", "显微"], point: "细胞结构" },
    { keywords: ["光合作用", "呼吸作用", "酶", "ATP", "细胞代谢"], point: "细胞代谢" },
    { keywords: ["遗传", "基因", "分离定律", "自由组合", "伴性遗传", "DNA", "碱基"], point: "遗传" },
    { keywords: ["变异", "基因突变", "染色体", "杂交育种", "进化", "种群"], point: "变异与进化" },
    { keywords: ["生态", "群落", "种群密度", "食物链", "能量流动", "物质循环"], point: "生态系统" },
    { keywords: ["免疫", "神经调节", "激素", "体液", "细胞免疫"], point: "调节" },
  ],
  地理: [
    { keywords: ["大气", "气候", "洋流", "水循环", "天气"], point: "自然地理" },
    { keywords: ["地形", "地貌", "板块", "内力", "外力"], point: "地貌" },
    { keywords: ["人口", "城市", "农业", "工业", "交通", "区位"], point: "人文地理" },
    { keywords: ["地球运动", "时区", "晨昏线", "太阳直射"], point: "地球运动" },
  ],
  历史: [
    { keywords: ["朝代", "皇帝", "改革", "变法", "战争", "条约", "制度"], point: "中国古代史" },
    { keywords: ["近代", "鸦片战争", "洋务", "戊戌", "辛亥革命", "新文化"], point: "中国近代史" },
    { keywords: ["革命", "建设", "改革开放", "中国特色社会主义"], point: "中国现代史" },
    { keywords: ["文艺复兴", "宗教改革", "启蒙", "工业革命", "两次世界大战"], point: "世界历史" },
  ],
  政治: [
    { keywords: ["价格", "价值规律", "供求", "消费", "生产", "分配"], point: "经济生活" },
    { keywords: ["国家", "政府", "公民", "民主", "人大"], point: "政治生活" },
    { keywords: ["文化", "传承", "创新", "民族", "道德"], point: "文化生活" },
    { keywords: ["哲学", "唯物论", "辩证法", "认识论", "矛盾", "实践"], point: "生活与哲学" },
  ],
};

function subjectKey(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  for (const key of Object.keys(DICTIONARY)) {
    if (s.includes(key)) return key;
  }
  return "";
}

/** 对一段文本匹配候选知识点（按学科词典；不在词典中的学科返回空）。 */
export function suggestKnowledgePoints(subject: string | null | undefined, text: string | null | undefined): string[] {
  if (!text) return [];
  const rules = DICTIONARY[subjectKey(subject)] ?? [];
  const found = new Set<string>();
  for (const rule of rules) {
    if (rule.keywords.some((k) => text.includes(k))) found.add(rule.point);
  }
  return Array.from(found);
}

/** 为某答题卡生成逐题候选标注。 */
export async function suggestForCard(cardId: string, subject?: string | null): Promise<KnowledgeSuggestResponse> {
  const cardRepo = new CardRepository();
  const card: AnswerCard | null = await cardRepo.findById(cardId);
  const suggestions: KnowledgeSuggestionItem[] = [];
  if (!card) return { cardId, subject: subject ?? null, suggestions };

  for (const block of card.bodyBlocks) {
    if (block.type === "objective") {
      // 客观题无独立题干：仅有块标题，匹配结果通常为空（如实反馈，不强标）
      const qns: number[] = block.questions
        ? block.questions.map((q) => q.questionNumber)
        : Array.from({ length: block.questionCount }, (_, i) => block.questionStart + i);
      for (const qn of qns) {
        suggestions.push({ questionNumber: qn, source: block.title, matched: suggestKnowledgePoints(subject, block.title) });
      }
    } else {
      for (const q of block.questions) {
        // 解答题有题干注释 annotation，是知识点匹配的主来源
        const text = [block.title, q.annotation ?? ""].filter(Boolean).join(" | ");
        const qn = Number(q.number);
        suggestions.push({ questionNumber: Number.isFinite(qn) ? qn : q.number as number, source: text, matched: suggestKnowledgePoints(subject, text) });
      }
    }
  }
  return { cardId, subject: subject ?? null, suggestions };
}
