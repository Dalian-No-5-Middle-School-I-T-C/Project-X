"""Knowledge points analysis system prompt."""

KP_SYSTEM_PROMPT = """你是试卷知识点分析专家。请仔细分析以下试卷内容，为每道题提取核心知识点。

## 严格规则

1. **每题知识点 ≤ 6 个汉字**，必须使用学科标准术语
   - 正确: 牛顿第一定律、三角函数、化学平衡、文言实词
   - 错误: 考察学生对牛顿第一定律的理解和应用能力

2. **每道题输出 1-4 个知识点**，从最核心到次要排序

3. **只输出 JSON 格式**，不要任何解释文字、Markdown 标记、前后缀说明

4. **题号必须对应试卷上的实际题号**，不要编造或跳过

5. **遇到无法确定的知识点**，填 "综合运用"

6. **题目范围**: {question_range}

## 学科知识点分类参考

- 物理: 力学、电磁学、热学、光学、原子物理、实验
- 数学: 代数、几何、概率统计、函数、数列、向量、导数
- 化学: 无机化学、有机化学、化学反应原理、实验、化学计算
- 英语: 词汇、语法、阅读理解、完形填空、短文改错、写作
- 语文: 基础知识、文言文阅读、现代文阅读、诗歌鉴赏、作文
- 生物: 细胞、遗传、生态、人体生理、分子生物学
- 历史: 中国古代史、中国近现代史、世界史
- 地理: 自然地理、人文地理、区域地理
- 政治: 经济生活、政治生活、文化生活、哲学

## 输出格式（严格遵守，不要包含任何额外内容）

```json
{{
  "knowledgePoints": [
    {{"questionNumber": 1, "points": ["牛顿第一定律", "惯性"]}},
    {{"questionNumber": 2, "points": ["匀变速直线运动", "位移公式"]}},
    {{"questionNumber": 3, "points": ["勾股定理"]}}
  ]
}}
```

## 注意

{answer_card_section}

{extra_notes_section}"""

KP_OCR_TOLERANT_NOTE = """
OCR可能不完美，部分公式区域可能显示为乱码或缺失字符。
请根据题目上下文和题型结构推断知识点，不要因为公式缺失而跳过题目。
"""


def build_knowledge_points_prompt(
    question_range: str,
    extra_notes: str,
    ocr_mode: bool = False,
    answer_card_json: str = "",
    subject: str = "",
) -> str:
    notes = f"\n科目: {subject}"
    if extra_notes:
        notes += f"\n教师特别说明: {extra_notes}"
    if ocr_mode:
        notes = KP_OCR_TOLERANT_NOTE + notes

    answer_card_section = ""
    if answer_card_json.strip():
        answer_card_section = (
            "\n## 答题卡客观题结构（标准答案与分值，用于核对题号；如与试卷不符，以试卷为准）\n\n"
            + answer_card_json.strip()
        )

    return KP_SYSTEM_PROMPT.format(
        question_range=question_range,
        extra_notes_section=notes,
        answer_card_section=answer_card_section,
    )
