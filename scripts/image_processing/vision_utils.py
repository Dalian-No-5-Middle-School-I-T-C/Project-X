from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np

from layout_io import LayoutPage, marker_centers_px


@dataclass(frozen=True)
class MarkerScore:
    role: str
    expected_width_px: float
    expected_height_px: float
    position_cost: float
    size_penalty: float
    shape_penalty: float
    rectangularity_penalty: float
    thin_penalty: float
    total_cost: float
    eligible: bool
    rejection_reasons: tuple[str, ...]

    def to_json(self) -> dict[str, object]:
        return {
            "role": self.role,
            "expectedWidthPx": round(self.expected_width_px, 3),
            "expectedHeightPx": round(self.expected_height_px, 3),
            "positionCost": round(self.position_cost, 6),
            "sizePenalty": round(self.size_penalty, 6),
            "shapePenalty": round(self.shape_penalty, 6),
            "rectangularityPenalty": round(self.rectangularity_penalty, 6),
            "thinPenalty": round(self.thin_penalty, 6),
            "totalCost": round(self.total_cost, 6),
            "eligible": self.eligible,
            "rejectionReasons": list(self.rejection_reasons),
        }


@dataclass
class MarkerCandidate:
    index: int
    center: tuple[float, float]
    bbox: tuple[int, int, int, int]
    area: float
    fill_ratio: float
    aspect_ratio: float
    rectangularity: float
    scores: dict[str, MarkerScore] = field(default_factory=dict)

    def best_score(self) -> MarkerScore | None:
        if not self.scores:
            return None
        return min(self.scores.values(), key=lambda item: item.total_cost)

    def to_json(self) -> dict[str, object]:
        best = self.best_score()
        data: dict[str, object] = {
            "index": self.index,
            "center": [round(self.center[0], 3), round(self.center[1], 3)],
            "bbox": list(self.bbox),
            "area": round(self.area, 3),
            "fillRatio": round(self.fill_ratio, 4),
            "aspectRatio": round(self.aspect_ratio, 4),
            "rectangularity": round(self.rectangularity, 4),
        }
        if best:
            data.update(
                {
                    "bestRole": best.role,
                    "expectedWidthPx": round(best.expected_width_px, 3),
                    "expectedHeightPx": round(best.expected_height_px, 3),
                    "positionCost": round(best.position_cost, 6),
                    "sizePenalty": round(best.size_penalty, 6),
                    "shapePenalty": round(best.shape_penalty, 6),
                    "rectangularityPenalty": round(best.rectangularity_penalty, 6),
                    "thinPenalty": round(best.thin_penalty, 6),
                    "totalCost": round(best.total_cost, 6),
                    "eligible": best.eligible,
                    "rejectionReasons": list(best.rejection_reasons),
                    "scoresByRole": {role: score.to_json() for role, score in sorted(self.scores.items())},
                }
            )
        return data


@dataclass
class MarkerMatch:
    role: str
    candidate: MarkerCandidate
    expected_px: tuple[float, float]
    cost: float
    score: MarkerScore | None = None

    def to_json(self) -> dict[str, object]:
        data: dict[str, object] = {
            "role": self.role,
            "candidateIndex": self.candidate.index,
            "detectedCenter": [round(self.candidate.center[0], 3), round(self.candidate.center[1], 3)],
            "expectedCenter": [round(self.expected_px[0], 3), round(self.expected_px[1], 3)],
            "cost": round(self.cost, 6),
        }
        if self.score:
            data["score"] = self.score.to_json()
        return data


def read_image(path: str | Path) -> np.ndarray:
    image_path = Path(path)
    if not image_path.exists():
        raise FileNotFoundError(f"Image not found: {image_path}")
    data = np.fromfile(str(image_path), dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"Failed to read image: {image_path}")
    return image


def write_image(path: str | Path, image: np.ndarray) -> None:
    image_path = Path(path)
    image_path.parent.mkdir(parents=True, exist_ok=True)
    ext = image_path.suffix or ".png"
    ok, encoded = cv2.imencode(ext, image)
    if not ok:
        raise ValueError(f"Failed to encode image as {ext}: {image_path}")
    encoded.tofile(str(image_path))


def preprocess_for_markers(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=1)
    return cv2.morphologyEx(closed, cv2.MORPH_OPEN, kernel, iterations=1)


def find_marker_candidates(image: np.ndarray) -> tuple[list[MarkerCandidate], np.ndarray]:
    binary = preprocess_for_markers(image)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    image_area = image.shape[0] * image.shape[1]
    min_area = max(25.0, image_area * 0.000015)
    max_area = image_area * 0.002
    candidates: list[MarkerCandidate] = []

    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < min_area or area > max_area:
            continue

        x, y, w, h = cv2.boundingRect(contour)
        if w <= 0 or h <= 0:
            continue

        aspect_ratio = h / w
        if aspect_ratio < 1.45 or aspect_ratio > 4.5:
            continue

        rectangularity = area / float(w * h)
        if rectangularity < 0.45:
            continue

        roi = binary[y : y + h, x : x + w]
        fill_ratio = float(cv2.countNonZero(roi)) / float(w * h)
        if fill_ratio < 0.45:
            continue

        candidates.append(
            MarkerCandidate(
                index=len(candidates),
                center=(x + w / 2, y + h / 2),
                bbox=(x, y, w, h),
                area=area,
                fill_ratio=fill_ratio,
                aspect_ratio=aspect_ratio,
                rectangularity=rectangularity,
            )
        )

    candidates.sort(key=lambda item: (item.center[1], item.center[0]))
    candidates = [
        MarkerCandidate(
            index=index,
            center=candidate.center,
            bbox=candidate.bbox,
            area=candidate.area,
            fill_ratio=candidate.fill_ratio,
            aspect_ratio=candidate.aspect_ratio,
            rectangularity=candidate.rectangularity,
            scores=candidate.scores,
        )
        for index, candidate in enumerate(candidates)
    ]
    return candidates, binary


def _expected_marker_size_px(
    layout_page: LayoutPage,
    role: str,
    image_width: int,
    image_height: int,
) -> tuple[float, float]:
    marker = layout_page.markers[role]
    return (
        marker.rect.width / layout_page.width_mm * image_width,
        marker.rect.height / layout_page.height_mm * image_height,
    )


def _score_candidate_for_role(
    candidate: MarkerCandidate,
    role: str,
    image_width: int,
    image_height: int,
    layout_page: LayoutPage,
) -> MarkerScore:
    marker = layout_page.markers[role]
    x, y, width, height = candidate.bbox
    expected_width, expected_height = _expected_marker_size_px(layout_page, role, image_width, image_height)
    expected_aspect_ratio = expected_height / max(expected_width, 1e-6)
    expected_x = marker.center_mm[0] / layout_page.width_mm
    expected_y = marker.center_mm[1] / layout_page.height_mm
    actual_x = candidate.center[0] / image_width
    actual_y = candidate.center[1] / image_height
    position_cost = abs(actual_y - expected_y) + 0.35 * abs(actual_x - expected_x)
    size_penalty = abs(math.log(max(width, 1) / max(expected_width, 1e-6))) + abs(
        math.log(max(height, 1) / max(expected_height, 1e-6))
    )
    shape_penalty = abs(math.log(max(candidate.aspect_ratio, 1e-6) / max(expected_aspect_ratio, 1e-6)))
    rectangularity_penalty = max(0.0, 0.65 - candidate.rectangularity) * 0.2
    thin_penalty = 0.25 if width < expected_width * 0.55 else 0.0
    rejection_reasons: list[str] = []

    if width < expected_width * 0.35:
        rejection_reasons.append("width_too_small")
    if height < expected_height * 0.35:
        rejection_reasons.append("height_too_small")
    if width > expected_width * 3.0:
        rejection_reasons.append("width_too_large")
    if height > expected_height * 2.2:
        rejection_reasons.append("height_too_large")

    total_cost = position_cost + 0.08 * size_penalty + 0.04 * shape_penalty + rectangularity_penalty + thin_penalty
    return MarkerScore(
        role=role,
        expected_width_px=expected_width,
        expected_height_px=expected_height,
        position_cost=position_cost,
        size_penalty=size_penalty,
        shape_penalty=shape_penalty,
        rectangularity_penalty=rectangularity_penalty,
        thin_penalty=thin_penalty,
        total_cost=total_cost,
        eligible=not rejection_reasons,
        rejection_reasons=tuple(rejection_reasons),
    )


def _score_candidates(
    candidates: list[MarkerCandidate],
    roles: list[str],
    image_width: int,
    image_height: int,
    layout_page: LayoutPage,
) -> None:
    for candidate in candidates:
        candidate.scores = {
            role: _score_candidate_for_role(candidate, role, image_width, image_height, layout_page)
            for role in roles
        }


def _candidate_cost(
    candidate: MarkerCandidate,
    role: str,
    image_width: int,
    image_height: int,
    layout_page: LayoutPage,
) -> float:
    score = candidate.scores.get(role)
    if score:
        return score.total_cost
    return _score_candidate_for_role(candidate, role, image_width, image_height, layout_page).total_cost


def _side_geometry_penalty(
    role_subset: tuple[str, ...],
    candidate_subset: tuple[MarkerCandidate, ...],
    image_width: int,
    layout_page: LayoutPage,
) -> float:
    role_to_candidate = dict(zip(role_subset, candidate_subset))
    role_order = {"top": 0, "middle": 1, "bottom": 2}
    penalty = 0.0

    ordered = sorted(
        role_to_candidate.items(),
        key=lambda item: role_order.get(item[0].split("-")[0], 99),
    )
    ys = [candidate.center[1] for _role, candidate in ordered]
    if any(ys[index] >= ys[index + 1] for index in range(len(ys) - 1)):
        penalty += 5.0

    xs = [candidate.center[0] for _role, candidate in ordered]
    x_spread = (max(xs) - min(xs)) / image_width if len(xs) > 1 else 0.0
    if x_spread > 0.22:
        penalty += (x_spread - 0.22) * 2.0

    top = role_to_candidate.get(next((role for role in role_subset if role.startswith("top-")), ""))
    middle = role_to_candidate.get(next((role for role in role_subset if role.startswith("middle-")), ""))
    bottom = role_to_candidate.get(next((role for role in role_subset if role.startswith("bottom-")), ""))
    if top and middle and bottom and bottom.center[1] > top.center[1]:
        actual_ratio = (middle.center[1] - top.center[1]) / (bottom.center[1] - top.center[1])
        side = "left" if "left" in role_subset[0] else "right"
        expected_top = layout_page.markers[f"top-{side}"].center_mm[1]
        expected_middle = layout_page.markers[f"middle-{side}"].center_mm[1]
        expected_bottom = layout_page.markers[f"bottom-{side}"].center_mm[1]
        expected_ratio = (expected_middle - expected_top) / (expected_bottom - expected_top)
        penalty += abs(actual_ratio - expected_ratio) * 0.25

    return penalty


def _assign_side(
    candidates: list[MarkerCandidate],
    roles: list[str],
    image_width: int,
    image_height: int,
    layout_page: LayoutPage,
    side: str,
) -> list[MarkerMatch]:
    if side == "left":
        side_pool = [item for item in candidates if item.center[0] <= image_width * 0.45]
    else:
        side_pool = [item for item in candidates if item.center[0] >= image_width * 0.55]

    side_pool = [
        item for item in side_pool if any(item.scores.get(role) and item.scores[role].eligible for role in roles)
    ]
    side_pool.sort(
        key=lambda item: min(
            (item.scores[role].total_cost for role in roles if role in item.scores),
            default=float("inf"),
        )
    )
    side_pool = side_pool[:18]
    if not side_pool:
        return []

    full_match_count = min(len(roles), len(side_pool))
    best: tuple[float, tuple[str, ...], tuple[MarkerCandidate, ...]] | None = None

    for role_subset in itertools.combinations(roles, full_match_count):
        for candidate_subset in itertools.permutations(side_pool, full_match_count):
            cost = sum(
                _candidate_cost(candidate, role, image_width, image_height, layout_page)
                for role, candidate in zip(role_subset, candidate_subset)
            )
            cost += _side_geometry_penalty(role_subset, candidate_subset, image_width, layout_page)
            if best is None or cost < best[0]:
                best = (cost, role_subset, candidate_subset)

    if best is None:
        return []

    matches: list[MarkerMatch] = []
    expected_px = marker_centers_px(layout_page, dpi=300)
    for role, candidate in zip(best[1], best[2]):
        score = candidate.scores.get(role)
        cost = score.total_cost if score else _candidate_cost(candidate, role, image_width, image_height, layout_page)
        matches.append(MarkerMatch(role=role, candidate=candidate, expected_px=expected_px[role], cost=cost, score=score))
    return matches


def match_markers(
    candidates: list[MarkerCandidate],
    image_shape: tuple[int, int, int],
    layout_page: LayoutPage,
    output_dpi: int,
) -> list[MarkerMatch]:
    image_height, image_width = image_shape[:2]
    left_roles = ["top-left", "middle-left", "bottom-left"]
    right_roles = ["top-right", "middle-right", "bottom-right"]
    all_roles = [*left_roles, *right_roles]
    _score_candidates(candidates, all_roles, image_width, image_height, layout_page)
    matches = [
        *_assign_side(candidates, left_roles, image_width, image_height, layout_page, "left"),
        *_assign_side(candidates, right_roles, image_width, image_height, layout_page, "right"),
    ]
    expected = marker_centers_px(layout_page, output_dpi)
    return [
        MarkerMatch(role=match.role, candidate=match.candidate, expected_px=expected[match.role], cost=match.cost)
        for match in sorted(matches, key=lambda item: item.role)
    ]


def estimate_homography(matches: Iterable[MarkerMatch]) -> tuple[np.ndarray, list[float], list[int]]:
    match_list = list(matches)
    if len(match_list) < 4:
        raise ValueError(f"Need at least 4 marker matches, got {len(match_list)}")

    src = np.array([match.candidate.center for match in match_list], dtype=np.float32)
    dst = np.array([match.expected_px for match in match_list], dtype=np.float32)
    homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 8.0)
    if homography is None:
        raise ValueError("Failed to estimate homography from marker matches")

    projected = cv2.perspectiveTransform(src.reshape(-1, 1, 2), homography).reshape(-1, 2)
    errors = np.linalg.norm(projected - dst, axis=1)
    inliers = mask.ravel().astype(int).tolist() if mask is not None else [1] * len(match_list)
    return homography, errors.astype(float).tolist(), inliers


def warp_to_layout(image: np.ndarray, homography: np.ndarray, output_size: tuple[int, int]) -> np.ndarray:
    width, height = output_size
    return cv2.warpPerspective(image, homography, (width, height), flags=cv2.INTER_CUBIC)

# test

def draw_debug_markers(
    image: np.ndarray,
    candidates: list[MarkerCandidate],
    matches: list[MarkerMatch],
    missing_roles: list[str],
) -> np.ndarray:
    debug = image.copy()
    for candidate in candidates:
        x, y, w, h = candidate.bbox
        cv2.rectangle(debug, (x, y), (x + w, y + h), (0, 220, 220), 2)
        cv2.putText(
            debug,
            str(candidate.index),
            (x, max(0, y - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 180, 180),
            1,
            cv2.LINE_AA,
        )

    for match in matches:
        cx, cy = (int(round(match.candidate.center[0])), int(round(match.candidate.center[1])))
        x, y, w, h = match.candidate.bbox
        cv2.rectangle(debug, (x, y), (x + w, y + h), (0, 0, 255), 3)
        cv2.circle(debug, (cx, cy), 6, (255, 0, 0), -1)
        cv2.putText(
            debug,
            match.role,
            (x, y + h + 18),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.58,
            (0, 0, 255),
            2,
            cv2.LINE_AA,
        )

    if missing_roles:
        cv2.putText(
            debug,
            "Missing: " + ", ".join(missing_roles),
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.0,
            (0, 0, 255),
            2,
            cv2.LINE_AA,
        )
    return debug

def warp_affine_keep_all(img, M, border_value=255):
    h, w = img.shape[:2]
    corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    ones = np.ones((4, 1), dtype=np.float32)
    corners_h = np.hstack([corners, ones])  # 4x3
    transformed = corners_h @ M.T  # 4x2
    min_x, min_y = transformed.min(axis=0)
    max_x, max_y = transformed.max(axis=0)
    new_w = int(np.ceil(max_x - min_x))
    new_h = int(np.ceil(max_y - min_y))
    T = np.array([
        [1, 0, -min_x],
        [0, 1, -min_y]
    ], dtype=np.float32)
    M_new = M.copy()
    M_new[:, 2] += T[:, 2]
    out = cv2.warpAffine(
        img,
        M_new,
        (new_w, new_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border_value
    )
    return out, M_new

def warp_perspective_keep_all(img, H, border_value=255):
    h, w = img.shape[:2]

    corners = np.array([
        [[0, 0]],
        [[w, 0]],
        [[w, h]],
        [[0, h]]
    ], dtype=np.float32)

    transformed = cv2.perspectiveTransform(corners, H)
    pts = transformed.reshape(-1, 2)

    min_x, min_y = pts.min(axis=0)
    max_x, max_y = pts.max(axis=0)

    new_w = int(np.ceil(max_x - min_x))
    new_h = int(np.ceil(max_y - min_y))

    # 平移矩阵
    T = np.array([
        [1, 0, -min_x],
        [0, 1, -min_y],
        [0, 0, 1]
    ], dtype=np.float32)

    H_new = T @ H

    out = cv2.warpPerspective(
        img,
        H_new,
        (new_w, new_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border_value
    )

    return out, H_new


def generate_test_images(image_path: str | Path, output_dir: str | Path) -> None:
    """
    生成抽象的线性变换，测试鲁棒性
    """
    image = read_image(image_path)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    mats = []

    m1 = np.array([
        [0.996, -0.087, 20],
        [0.087,  0.996, -15]
    ], dtype=np.float32)
    m2 = np.array([
        [0.966, -0.259, 60],
        [0.259,  0.966, -80]
    ], dtype=np.float32)
    m3 = np.array([
        [-1.0, 0.0,  0],
        [0.0, -1.0,  0]
    ], dtype=np.float32)
    m4 = np.array([
        [1.0, 0.0,   0],
        [0.25, 1.0, -60]
    ], dtype=np.float32)

    h1 = np.array([
        [1.0,  0.15, -80],
        [0.08, 1.0,  -40],
        [0.00035, 0.0002, 1.0]
    ], dtype=np.float32)
    m5 = np.array([
        [1.05,  0.28, -90],
        [0.18,  0.92,  30]
    ], dtype=np.float32)


    mats.append(m1)
    mats.append(m2)
    mats.append(m3)
    mats.append(m4)
    mats.append(h1)
    mats.append(m5)

    write_image(Path(output_dir) / "test_transform_0.png", gray)
    for i, mat in enumerate(mats):
        if mat.shape == (2, 3):
            transformed = warp_affine_keep_all(gray, mat)[0]
        else:
            transformed = warp_perspective_keep_all(gray, mat)[0]
        output_path = Path(output_dir) / f"test_transform_{i+1}.png"
        write_image(output_path, transformed)

if __name__ == "__main__":
    ROOT_DIR = Path(__file__).resolve().parents[2]
    IMAGE_PATH = ROOT_DIR / "image" / "image_5.jpg"
    OUTPUT_DIR = ROOT_DIR / "data" / "answer-card" / "processed" / "test_images"
    generate_test_images(IMAGE_PATH, OUTPUT_DIR)
