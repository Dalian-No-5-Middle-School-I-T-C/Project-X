from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REQUIRED_MARKER_ROLES = (
    "top-left",
    "top-right",
    "middle-left",
    "middle-right",
    "bottom-left",
    "bottom-right",
)


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.width / 2, self.y + self.height / 2)


@dataclass(frozen=True)
class LayoutMarker:
    role: str
    rect: Rect

    @property
    def center_mm(self) -> tuple[float, float]:
        return self.rect.center


@dataclass(frozen=True)
class ObjectiveOption:
    block_id: str
    question_number: int
    label: str
    rect: Rect


@dataclass(frozen=True)
class LayoutPage:
    card_id: str
    page_number: int
    width_mm: float
    height_mm: float
    markers: dict[str, LayoutMarker]
    objective_options: tuple[ObjectiveOption, ...] = ()


def _rect_from_json(value: dict[str, Any]) -> Rect:
    try:
        return Rect(
            x=float(value["x"]),
            y=float(value["y"]),
            width=float(value["width"]),
            height=float(value["height"]),
        )
    except KeyError as error:
        raise ValueError(f"Rect missing field: {error}") from error


def _objective_options_from_page(page_data: dict[str, Any]) -> tuple[ObjectiveOption, ...]:
    options: list[ObjectiveOption] = []

    for block in page_data.get("blocks", []):
        if not isinstance(block, dict) or block.get("type") != "objective":
            continue

        block_id = str(block.get("blockId") or "")
        for item in block.get("items", []):
            if not isinstance(item, dict):
                continue
            question_number = int(item.get("questionNumber", 0))
            if question_number <= 0:
                continue
            for option in item.get("options", []):
                if not isinstance(option, dict):
                    continue
                label = str(option.get("label") or "")
                rect_data = option.get("rect")
                if not label or not isinstance(rect_data, dict):
                    continue
                options.append(
                    ObjectiveOption(
                        block_id=block_id,
                        question_number=question_number,
                        label=label,
                        rect=_rect_from_json(rect_data),
                    )
                )

    if options:
        return tuple(sorted(options, key=lambda item: (item.question_number, item.label)))

    for element in page_data.get("elements", []):
        if not isinstance(element, dict) or element.get("type") != "objective_option":
            continue
        label = str(element.get("option") or "")
        rect_data = element.get("rect")
        question_number = int(element.get("questionNumber", 0))
        if not label or question_number <= 0 or not isinstance(rect_data, dict):
            continue
        options.append(
            ObjectiveOption(
                block_id=str(element.get("blockId") or ""),
                question_number=question_number,
                label=label,
                rect=_rect_from_json(rect_data),
            )
        )

    return tuple(sorted(options, key=lambda item: (item.question_number, item.label)))


def load_layout_page(layout_path: str | Path, page_number: int) -> LayoutPage:
    path = Path(layout_path)
    if not path.exists():
        raise FileNotFoundError(f"Layout JSON not found: {path}")

    with path.open("r", encoding="utf-8") as file:
        layout = json.load(file)

    card_id = str(layout.get("cardId") or "")
    if not card_id:
        raise ValueError(f"Layout JSON has no cardId: {path}")

    pages = layout.get("pages")
    if not isinstance(pages, list):
        raise ValueError(f"Layout JSON pages must be a list: {path}")

    page_data = next((page for page in pages if int(page.get("pageNumber", -1)) == page_number), None)
    if page_data is None:
        raise ValueError(f"Page {page_number} not found in layout JSON: {path}")

    marker_items = page_data.get("markers")
    if not isinstance(marker_items, list):
        raise ValueError(f"Page {page_number} has no marker list: {path}")

    markers: dict[str, LayoutMarker] = {}
    for marker in marker_items:
        role = str(marker.get("role") or "")
        if not role:
            continue
        markers[role] = LayoutMarker(role=role, rect=_rect_from_json(marker["rect"]))

    missing = [role for role in REQUIRED_MARKER_ROLES if role not in markers]
    if missing:
        raise ValueError(f"Page {page_number} is missing markers: {', '.join(missing)}")

    return LayoutPage(
        card_id=card_id,
        page_number=page_number,
        width_mm=float(page_data.get("width") or layout.get("width") or 210),
        height_mm=float(page_data.get("height") or layout.get("height") or 297),
        markers={role: markers[role] for role in REQUIRED_MARKER_ROLES},
        objective_options=_objective_options_from_page(page_data),
    )


def a4_pixel_size(width_mm: float, height_mm: float, dpi: int) -> tuple[int, int]:
    if dpi <= 0:
        raise ValueError("DPI must be positive")
    return (round(width_mm / 25.4 * dpi), round(height_mm / 25.4 * dpi))


def marker_centers_px(page: LayoutPage, dpi: int) -> dict[str, tuple[float, float]]:
    scale = dpi / 25.4
    return {
        role: (marker.center_mm[0] * scale, marker.center_mm[1] * scale)
        for role, marker in page.markers.items()
    }
