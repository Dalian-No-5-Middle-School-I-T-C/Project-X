"""Prepare the answer images, independent statistics and MariaDB samples for the VM flow."""
import argparse
import json
import os
import statistics
from datetime import date
from pathlib import Path

import pymupdf

BINARY_ANSWERS = ("1111", "1110", "1101", "1100", "0110", "0100", "0010", "0000")


def independent_statistics(manifest):
    rows = []
    for sheet in manifest:
        corrected = sheet["physicalStudent"] == "10008"
        options = "ABCD" if corrected else [sheet["answers"][str(i)] for i in range(1, 5)]
        rows.append([5 * (answer == key) for answer, key in zip(options, "ABCD")] +
                    [25 if corrected else sheet["subjectiveScore"]])
    totals = sorted(sum(row) for row in rows)
    n = len(rows)
    normal = statistics.NormalDist()
    quantiles = [normal.inv_cdf((rank - 0.375) / (n + 0.25)) for rank in range(1, n + 1)]
    item_variances = sum(statistics.variance(column) for column in zip(*rows))
    binary = [list(map(int, row)) for row in BINARY_ANSWERS]
    fractions = [statistics.mean(column) for column in zip(*binary)]
    return {
        "w": statistics.correlation(totals, quantiles) ** 2,
        "alpha": 5 / 4 * (1 - item_variances / statistics.variance(totals)),
        "kr20": 4 / 3 * (1 - sum(p * (1 - p) for p in fractions) /
                          statistics.pvariance(list(map(sum, binary)))),
        "mixedSamples": n, "objectiveSamples": len(binary)
    }


def write_sql(output, year):
    # The scores are inserted only for new fixture exams, in one transaction.
    statements = ["START TRANSACTION;"]

    def exam(name, subject, day, published=False, formula="NULL"):
        statements.extend([
            f"SET @existing=(SELECT id FROM exams WHERE name='{name}');",
            "INSERT INTO exams(name,subject,start_time,status,score_published,assigned_formula) "
            f"SELECT '{name}','{subject}','{day}','closed',{int(published)},{formula} "
            "WHERE @existing IS NULL;",
            "SET @exam=LAST_INSERT_ID();",
        ])

    def score(user_field, user, raw, kind, assigned=None):
        statements.append(f"SET @student=(SELECT id FROM users WHERE {user_field}='{user}');")
        columns = f"exam_id,student_id,total_score,{kind}_score"
        values = f"@exam,@student,{raw},{raw}"
        if assigned is not None:
            columns += ",assigned_score"
            values += f",{assigned}"
        statements.append(f"INSERT INTO student_scores({columns}) SELECT {values} WHERE @existing IS NULL;")

    def question(number, value, maximum, kind):
        statements.append("INSERT INTO question_scores(exam_id,student_id,question_number,score,max_score,score_type) "
                          f"SELECT @exam,@student,{number},{value},{maximum},'{kind}' WHERE @existing IS NULL;")

    exam("纯客观信度验收四题", "数学", f"{year}-11-01")
    for index, answers in enumerate(BINARY_ANSWERS, 10001):
        score("username", f"flow_{index}", answers.count("1"), "objective")
        for number, answer in enumerate(answers, 1):
            question(number, int(answer), 1, "objective")

    for subject, full, first, last in (("百点评估", 100, 80, 85), ("一百五十点评估", 150, 120, 124.5),
                                       ("进步阈值下界", 150, 120, 124)):
        for day, value in ((f"{year}-05-10", first), (f"{year}-10-15", last)):
            exam(f"得分率验收 {subject} {day}", subject, day, published=True)
            score("username", "flow_10040", value, "subjective")
            question(1, value, full, "subjective")

    for subject, scores in (("数学", (70, 70, 80, 85)), ("语文", (75, 75, 95)), ("化学", (80, 79))):
        exam("分科人数复核" + subject, subject, f"{year}-11-10",
             formula="'linear'" if subject == "化学" else "NULL")
        for index, value in enumerate(scores):
            assigned = (85, 95)[index] if subject == "化学" else 1
            score("student_number", str(20016 + index), value, "objective", assigned)
    statements.append("COMMIT;")
    output.write_text("\n".join(statements) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=os.environ.get("PROJECTX_FLOW_ROOT", "ignored/production-flow"))
    parser.add_argument("--year", type=int, default=date.today().year)
    args = parser.parse_args()
    manifest = json.loads((args.root / "manifest.json").read_text(encoding="utf-8"))
    (args.root / "expected-statistics.json").write_text(json.dumps(independent_statistics(manifest)), encoding="utf-8")
    for index, line in enumerate(("1-5 BACDB", "6. A"), 1):
        with pymupdf.open() as doc:
            page = doc.new_page(width=550, height=150)
            page.insert_text((45, 90), line, fontsize=45, fontname="hebo")
            page.get_pixmap(dpi=180).save(args.root / f"答案文字{index}.png")
    write_sql(args.root / "analysis-fixtures.sql", args.year)


if __name__ == "__main__":
    main()
