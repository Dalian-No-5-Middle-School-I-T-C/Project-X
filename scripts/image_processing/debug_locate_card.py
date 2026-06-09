from __future__ import annotations

import json
from pathlib import Path

from layout_io import REQUIRED_MARKER_ROLES, a4_pixel_size, load_layout_page
from vision_utils import (
    draw_debug_markers,
    estimate_homography,
    find_marker_candidates,
    match_markers,
    read_image,
    warp_to_layout,
    write_image,
)

import time


ROOT_DIR = Path(__file__).resolve().parents[2]

# Replace this with a scan/photo generated from the same answer card layout.
IMAGE_PATH = ROOT_DIR / "data" / "answer-card" / "processed" / "test_images" / "test_transform_1.png"
LAYOUT_PATH = ROOT_DIR / "data" / "answer-card" / "layouts" / "63589964.json"
PAGE_NUMBER = 1
OUTPUT_DIR = ROOT_DIR / "data" / "answer-card" / "processed" / "debug"
OUTPUT_DPI = 300


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    status = "ok"
    debug: dict[str, object] = {}

    layout_page = load_layout_page(LAYOUT_PATH, PAGE_NUMBER)
    image = read_image(IMAGE_PATH)
    candidates, _binary = find_marker_candidates(image)
    matches = match_markers(candidates, image.shape, layout_page, OUTPUT_DPI)
    matched_roles = {match.role for match in matches}
    missing_roles = [role for role in REQUIRED_MARKER_ROLES if role not in matched_roles]

    try:
        homography, reprojection_errors, inliers = estimate_homography(matches)
    except ValueError as error:
        status = "failed"
        message = str(error)
        reason = "Failed to find enough marker points."
        homography = None
        reprojection_errors = []
        inliers = []
        debug = {
            "status": status,
            "imagePath": str(IMAGE_PATH),
            "layoutPath": str(LAYOUT_PATH),
            "message": message,
            "reason": reason,
            "detectedCandidates": [candidate.to_json() for candidate in candidates],
            "matches": [match.to_json() for match in matches],
            "missingRoles": missing_roles,
        }
        print(f"Error: {message} Reason: {reason}")

    if status == "ok":
        output_size = a4_pixel_size(layout_page.width_mm, layout_page.height_mm, OUTPUT_DPI)
        warped = warp_to_layout(image, homography, output_size)
        debug_markers = draw_debug_markers(image, candidates, matches, missing_roles)

        write_image(OUTPUT_DIR / "warped.png", warped)
        write_image(OUTPUT_DIR / "debug_markers.png", debug_markers)

        debug = {
            "status": "ok" if len(matches) == len(REQUIRED_MARKER_ROLES) else "partial",
            "imagePath": str(IMAGE_PATH),
            "layoutPath": str(LAYOUT_PATH),
            "cardId": layout_page.card_id,
            "pageNumber": layout_page.page_number,
            "inputImageSize": {"width": int(image.shape[1]), "height": int(image.shape[0])},
            "output": {
                "dpi": OUTPUT_DPI,
                "widthPx": output_size[0],
                "heightPx": output_size[1],
                "warpedPath": str(OUTPUT_DIR / "warped.png"),
                "debugMarkersPath": str(OUTPUT_DIR / "debug_markers.png"),
            },
            "layoutMarkers": {
                role: {
                    "centerMm": [round(value, 3) for value in marker.center_mm],
                    "rectMm": {
                        "x": marker.rect.x,
                        "y": marker.rect.y,
                        "width": marker.rect.width,
                        "height": marker.rect.height,
                    },
                }
                for role, marker in layout_page.markers.items()
            },
            "detectedCandidates": [candidate.to_json() for candidate in candidates],
            "matches": [match.to_json() for match in matches],
            "missingRoles": missing_roles,
            "homography": [[round(float(value), 8) for value in row] for row in homography.tolist()],
            "quality": {
                "matchCount": len(matches),
                "candidateCount": len(candidates),
                "reprojectionErrorsPx": [round(float(value), 4) for value in reprojection_errors],
                "meanReprojectionErrorPx": round(float(sum(reprojection_errors) / len(reprojection_errors)), 4),
                "inliers": inliers,
            },
        }

    with (OUTPUT_DIR / "debug.json").open("w", encoding="utf-8") as file:
        json.dump(debug, file, ensure_ascii=False, indent=2)

    print(f"Detected {len(candidates)} marker candidates.")
    print(f"Matched {len(matches)} markers: {', '.join(sorted(matched_roles))}")
    if missing_roles:
        print(f"Missing marker roles: {', '.join(missing_roles)}")
    print(f"Warped image: {OUTPUT_DIR / 'warped.png'}")
    print(f"Debug JSON: {OUTPUT_DIR / 'debug.json'}")


if __name__ == "__main__":
    main()
