from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from layout_io import REQUIRED_MARKER_ROLES, ObjectiveOption, Rect, StudentDigit, a4_pixel_size, load_layout_page
from vision_utils import (
    draw_debug_markers,
    estimate_homography,
    find_marker_candidates,
    match_markers,
    read_image,
    warp_to_layout,
    write_image,
)


MIN_SELECTED_FILL_RATIO = 0.32
MIN_SELECTED_OVER_BACKGROUND = 0.10
MAX_DYNAMIC_SELECTION_THRESHOLD = 0.75
MIN_LEAD_GAP = 0.06
OPTION_INNER_MARGIN_RATIO = 0.18


def _rect_to_json(rect: Rect) -> dict[str, float]:
    return {
        "x": round(rect.x, 3),
        "y": round(rect.y, 3),
        "width": round(rect.width, 3),
        "height": round(rect.height, 3),
    }


def _rect_to_bounds(
    rect: Rect,
    dpi: int,
    image_width: int,
    image_height: int,
    margin_ratio: float = 0.0,
) -> tuple[int, int, int, int]:
    scale = dpi / 25.4
    x1 = rect.x * scale
    y1 = rect.y * scale
    x2 = (rect.x + rect.width) * scale
    y2 = (rect.y + rect.height) * scale

    inset_x = max(1.0, (x2 - x1) * margin_ratio)
    inset_y = max(1.0, (y2 - y1) * margin_ratio)
    x1 += inset_x
    y1 += inset_y
    x2 -= inset_x
    y2 -= inset_y

    left = max(0, min(image_width - 1, int(round(x1))))
    top = max(0, min(image_height - 1, int(round(y1))))
    right = max(left + 1, min(image_width, int(round(x2))))
    bottom = max(top + 1, min(image_height, int(round(y2))))
    return left, top, right, bottom


def _sample_rect(warped: np.ndarray, rect: Rect, dpi: int, margin_ratio: float) -> dict[str, object]:
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if warped.ndim == 3 else warped
    image_height, image_width = gray.shape[:2]
    left, top, right, bottom = _rect_to_bounds(
        rect,
        dpi,
        image_width,
        image_height,
        margin_ratio,
    )
    roi = gray[top:bottom, left:right]
    if roi.size == 0:
        fill_ratio = 0.0
        dark_ratio = 0.0
        mean_gray = 255.0
        threshold = 180.0
    else:
        mean_gray = float(np.mean(roi))
        std_gray = float(np.std(roi))
        threshold = 180.0
        if std_gray >= 4.0:
            otsu_threshold, _binary = cv2.threshold(roi, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
            threshold = min(190.0, max(95.0, float(otsu_threshold)))
        fill_ratio = float(np.count_nonzero(roi < threshold)) / float(roi.size)
        dark_ratio = float(np.count_nonzero(roi < 180)) / float(roi.size)

    return {
        "fillRatio": round(fill_ratio, 4),
        "darkRatio": round(dark_ratio, 4),
        "meanGray": round(mean_gray, 2),
        "threshold": round(threshold, 2),
        "rect": _rect_to_json(rect),
        "sampleBounds": {"left": left, "top": top, "right": right, "bottom": bottom},
    }


def _sample_option(warped: np.ndarray, option: ObjectiveOption, dpi: int) -> dict[str, object]:
    result = _sample_rect(warped, option.rect, dpi, OPTION_INNER_MARGIN_RATIO)
    result["label"] = option.label
    return result


def _sample_student_digit(warped: np.ndarray, digit: StudentDigit, dpi: int) -> dict[str, object]:
    result = _sample_rect(warped, digit.rect, dpi, OPTION_INNER_MARGIN_RATIO)
    result["digit"] = digit.digit
    return result


def _selected_options(options: list[dict[str, object]]) -> tuple[list[str], float, dict[str, float]]:
    if not options:
        return [], 0.0, {}

    scores = {str(option["label"]): float(option["fillRatio"]) for option in options}
    ordered = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    _top_label, top_score = ordered[0]
    second_score = ordered[1][1] if len(ordered) > 1 else 0.0
    low_scores = sorted(scores.values())[: max(1, len(scores) // 2)]
    background = float(np.mean(low_scores))
    threshold = max(
        MIN_SELECTED_FILL_RATIO,
        min(background + MIN_SELECTED_OVER_BACKGROUND, MAX_DYNAMIC_SELECTION_THRESHOLD),
    )

    selected = [label for label, score in sorted(scores.items()) if score >= threshold]
    if top_score < threshold or (len(selected) <= 1 and top_score - second_score < MIN_LEAD_GAP):
        selected = []
    selected_scores = [scores[label] for label in selected]
    rejected_scores = [score for label, score in scores.items() if label not in selected]
    separation = min(selected_scores) - max(rejected_scores or [background]) if selected_scores else 0.0
    confidence = max(0.0, min(1.0, separation))
    if not selected:
        confidence = 0.0

    return selected, round(confidence, 4), {label: round(score, 4) for label, score in sorted(scores.items())}


def _build_questions(option_results: list[tuple[ObjectiveOption, dict[str, object]]]) -> list[dict[str, object]]:
    by_question: dict[int, list[dict[str, object]]] = defaultdict(list)
    for option, result in option_results:
        by_question[option.question_number].append(result)

    questions: list[dict[str, object]] = []
    for question_number in sorted(by_question):
        options = sorted(by_question[question_number], key=lambda item: str(item["label"]))
        selected, confidence, option_scores = _selected_options(options)
        questions.append(
            {
                "questionNumber": question_number,
                "selectedOptions": selected,
                "confidence": confidence,
                "optionScores": option_scores,
            }
        )
    return questions


def _selected_digit(samples: list[dict[str, object]]) -> tuple[int | None, list[str], dict[str, float]]:
    scores = {str(sample["digit"]): float(sample["fillRatio"]) for sample in samples}
    if len(scores) != 10:
        return None, [f"expected_10_candidates_got_{len(scores)}"], {
            digit: round(score, 4) for digit, score in sorted(scores.items(), key=lambda item: int(item[0]))
        }

    selected = [digit for digit, score in scores.items() if score >= MIN_SELECTED_FILL_RATIO]
    score_payload = {digit: round(score, 4) for digit, score in sorted(scores.items(), key=lambda item: int(item[0]))}
    if len(selected) != 1:
        reason = "no_digit_selected" if not selected else "multiple_digits_selected"
        return None, [reason], score_payload
    return int(selected[0]), [], score_payload


def _build_student_id(digit_results: list[tuple[StudentDigit, dict[str, object]]]) -> dict[str, object]:
    by_index: dict[int, list[dict[str, object]]] = defaultdict(list)
    for digit, result in digit_results:
        by_index[digit.digit_index].append(result)

    digits: list[dict[str, object]] = []
    failures: list[dict[str, object]] = []
    for digit_index in sorted(by_index):
        selected_digit, reasons, digit_scores = _selected_digit(by_index[digit_index])
        digit_result: dict[str, object] = {
            "digitIndex": digit_index,
            "selectedDigit": selected_digit,
            "digitScores": digit_scores,
        }
        if reasons:
            digit_result["reasons"] = reasons
            failures.append(digit_result)
        digits.append(digit_result)

    missing_indices = [] if by_index else ["all"]
    if missing_indices:
        failures.append({"digitIndex": None, "selectedDigit": None, "reasons": ["no_student_digit_candidates"]})

    value = "".join(str(item["selectedDigit"]) for item in digits if item["selectedDigit"] is not None)
    return {
        "status": "ok" if not failures else "failed",
        "value": value if not failures else None,
        "digits": digits,
        "failures": failures,
    }


def _quality_payload(
    candidates: list[Any],
    matches: list[Any],
    missing_roles: list[str],
    reprojection_errors: list[float],
    inliers: list[int],
) -> dict[str, object]:
    mean_error = float(sum(reprojection_errors) / len(reprojection_errors)) if reprojection_errors else None
    return {
        "candidateCount": len(candidates),
        "matchCount": len(matches),
        "missingRoles": missing_roles,
        "reprojectionErrorsPx": [round(float(value), 4) for value in reprojection_errors],
        "meanReprojectionErrorPx": round(mean_error, 4) if mean_error is not None else None,
        "inliers": inliers,
    }


def _failed_result(
    message: str,
    *,
    image_path: str | Path,
    layout_path: str | Path,
    page_number: int,
    quality: dict[str, object] | None = None,
) -> dict[str, object]:
    return {
        "status": "failed",
        "imagePath": str(image_path),
        "layoutPath": str(layout_path),
        "pageNumber": page_number,
        "message": message,
        "quality": quality or {},
        "questions": [],
    }


def _write_debug_artifacts(
    debug_dir: str | Path,
    *,
    result: dict[str, object],
    warped: np.ndarray | None,
    source_image: np.ndarray | None,
    candidates: list[Any],
    matches: list[Any],
    missing_roles: list[str],
) -> None:
    output_dir = Path(debug_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    if warped is not None:
        write_image(output_dir / "warped.png", warped)
    if source_image is not None:
        write_image(output_dir / "debug_markers.png", draw_debug_markers(source_image, candidates, matches, missing_roles))
    with (output_dir / "debug.json").open("w", encoding="utf-8") as file:
        json.dump(result, file, ensure_ascii=False, indent=2)


def recognize_objective_answers(
    image_path: str | Path,
    layout_path: str | Path,
    page_number: int = 1,
    output_dpi: int = 300,
    debug: bool = False,
    debug_dir: str | Path | None = None,
) -> dict[str, object]:
    try:
        layout_page = load_layout_page(layout_path, page_number)
        if not layout_page.objective_options:
            return _failed_result(
                "Layout page has no objective options.",
                image_path=image_path,
                layout_path=layout_path,
                page_number=page_number,
            )

        image = read_image(image_path)
        candidates, _binary = find_marker_candidates(image)
        matches = match_markers(candidates, image.shape, layout_page, output_dpi)
        matched_roles = {match.role for match in matches}
        missing_roles = [role for role in REQUIRED_MARKER_ROLES if role not in matched_roles]
        homography, reprojection_errors, inliers = estimate_homography(matches)
        quality = _quality_payload(candidates, matches, missing_roles, reprojection_errors, inliers)

        output_size = a4_pixel_size(layout_page.width_mm, layout_page.height_mm, output_dpi)
        warped = warp_to_layout(image, homography, output_size)
        option_results = [
            (option, _sample_option(warped, option, output_dpi))
            for option in layout_page.objective_options
        ]
        student_digit_results = [
            (digit, _sample_student_digit(warped, digit, output_dpi))
            for digit in layout_page.student_digits
        ]
        student_id = _build_student_id(student_digit_results)
        status = "ok" if not missing_roles else "partial"
        message = None
        if student_id["status"] != "ok":
            status = "failed"
            message = "Student ID recognition failed."
        result = {
            "status": status,
            "imagePath": str(image_path),
            "layoutPath": str(layout_path),
            "cardId": layout_page.card_id,
            "pageNumber": layout_page.page_number,
            "output": {
                "dpi": output_dpi,
                "widthPx": output_size[0],
                "heightPx": output_size[1],
            },
            "quality": quality,
            "studentId": student_id,
            "questions": _build_questions(option_results),
        }
        if message:
            result["message"] = message

        if debug:
            _write_debug_artifacts(
                debug_dir or Path(image_path).with_name("recognition_debug"),
                result=result,
                warped=warped,
                source_image=image,
                candidates=candidates,
                matches=matches,
                missing_roles=missing_roles,
            )
        return result
    except (FileNotFoundError, ValueError) as error:
        result = _failed_result(
            str(error),
            image_path=image_path,
            layout_path=layout_path,
            page_number=page_number,
        )
        if debug and debug_dir is not None:
            _write_debug_artifacts(
                debug_dir,
                result=result,
                warped=None,
                source_image=None,
                candidates=[],
                matches=[],
                missing_roles=[],
            )
        return result
