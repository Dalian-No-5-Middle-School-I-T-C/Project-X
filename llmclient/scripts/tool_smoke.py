from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llmclient.tools import grades


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test Project-X grade tools.")
    parser.add_argument("--exam-id", type=int, required=True)
    parser.add_argument("--class-id", type=int)
    args = parser.parse_args()

    payload = {
        "overview": grades.get_exam_overview(args.exam_id, args.class_id),
        "distribution": grades.get_score_distribution(args.exam_id, args.class_id),
        "classes": grades.get_class_summaries(args.exam_id),
        "questions": grades.get_question_analysis(args.exam_id, args.class_id, limit=5),
        "rankSegments": grades.get_rank_segments(args.exam_id, args.class_id),
        "reviewRisks": grades.get_review_risks(args.exam_id, args.class_id, limit=5),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
