from __future__ import annotations

import argparse
import json
from pathlib import Path
import time

from answer_recognition import recognize_objective_answers


def main(
    image_path: Path,
    layout_path: Path,
    page_number: int,
    output_dir: Path,
    output_dpi: int,
    ret: bool = False,
) -> dict[str, object] | None:
    result = recognize_objective_answers(
        image_path,
        layout_path,
        page_number=page_number,
        output_dpi=output_dpi,
        debug=True,
        debug_dir=output_dir,
    )
    if ret:
        return result
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return None


def _parse_args() -> argparse.Namespace:
    root_dir = Path(__file__).resolve().parents[2]
    default_image = root_dir / "data" / "answer-card" / "processed" / "test_images" / "test_transform_2.png"
    default_layout = root_dir / "data" / "answer-card" / "layouts" / "40788329.json"
    default_output = root_dir / "data" / "answer-card" / "processed" / "debug"

    parser = argparse.ArgumentParser(description="Write diagnostic artifacts for answer-card recognition.")
    parser.add_argument("--image", type=Path, default=default_image)
    parser.add_argument("--layout", type=Path, default=default_layout)
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--output-dir", type=Path, default=default_output)
    parser.add_argument("--dpi", type=int, default=300)
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    main(args.image, args.layout, args.page, args.output_dir, args.dpi)
