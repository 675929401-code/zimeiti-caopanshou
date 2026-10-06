from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "research-output" / "gaoding-reference" / "gaoding-cover-grid.png"
OUTPUT = ROOT / "research-output" / "gaoding-reference" / "cards"
MANIFEST = ROOT / "research-output" / "gaoding-reference" / "manifest.json"
CONTACT_SHEET = ROOT / "research-output" / "gaoding-reference" / "contact-sheet.jpg"


def runs(mask: np.ndarray, minimum: int) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    start: int | None = None
    for index, enabled in enumerate(mask.tolist()):
        if enabled and start is None:
            start = index
        if start is not None and (not enabled or index == len(mask) - 1):
            end = index if not enabled else index + 1
            if end - start >= minimum:
                result.append((start, end))
            start = None
    return result


def classify_ratio(width: int, height: int) -> str:
    ratio = width / height
    if 0.70 <= ratio <= 0.80:
        return "3:4"
    if 1.25 <= ratio <= 1.42:
        return "4:3"
    if 0.52 <= ratio <= 0.62:
        return "9:16"
    if 1.70 <= ratio <= 1.86:
        return "16:9"
    if 0.94 <= ratio <= 1.06:
        return "1:1"
    return f"{width}:{height}"


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    image = Image.open(SOURCE).convert("RGB")
    pixels = np.asarray(image)
    dark = np.min(pixels, axis=2) < 245

    # The screenshot uses pure-white gutters. Detect them instead of hard-coding columns.
    vertical_density = np.mean(dark, axis=0)
    gutters = runs(vertical_density < 0.035, minimum=8)
    columns: list[tuple[int, int]] = []
    for left_gutter, right_gutter in zip(gutters, gutters[1:]):
        left = left_gutter[1]
        right = right_gutter[0]
        if 180 <= right - left <= 500:
            columns.append((left, right))

    cards: list[dict] = []
    card_images: list[Image.Image] = []
    card_number = 1
    for column_index, (left, right) in enumerate(columns, start=1):
        horizontal_density = np.mean(dark[:, left:right], axis=1)
        raw_gaps = runs(horizontal_density < 0.008, minimum=10)
        boundaries: list[tuple[int, int]] = []
        for gap in raw_gaps:
            if not boundaries or gap[0] - boundaries[-1][1] >= 100:
                boundaries.append(gap)

        intervals: list[tuple[int, int]] = []
        for current, following in zip(boundaries, boundaries[1:]):
            top, bottom = current[1], following[0]
            if bottom - top >= 100:
                intervals.append((top, bottom))
        if boundaries and image.height - boundaries[-1][1] >= 100:
            intervals.append((boundaries[-1][1], image.height))

        for row_index, (top, bottom) in enumerate(intervals, start=1):
            crop = image.crop((left, top, right, bottom))
            width, height = crop.size
            filename = f"card-{card_number:03d}.png"
            crop.save(OUTPUT / filename, optimize=True)
            ratio = classify_ratio(width, height)
            cards.append({
                "id": f"gaoding-reference-{card_number:03d}",
                "file": f"cards/{filename}",
                "column": column_index,
                "row": row_index,
                "referenceWidth": width,
                "referenceHeight": height,
                "referenceRatio": ratio,
                "originalWidth": None,
                "originalHeight": None,
                "originalSizeVerified": False,
                "sourceType": "user-provided-screenshot-reference",
                "editable": False,
                "status": "awaiting-layer-rebuild",
            })
            card_images.append(crop)
            card_number += 1

    manifest = {
        "source": str(SOURCE.relative_to(ROOT)).replace("\\", "/"),
        "sourceWidth": image.width,
        "sourceHeight": image.height,
        "columnCount": len(columns),
        "cardCount": len(cards),
        "notes": [
            "These crops are visual references, not copied editable templates.",
            "originalWidth/originalHeight remain null until verified from a normal source record.",
            "Only rebuilt layer JSON may be imported into the production template library.",
        ],
        "cards": cards,
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    thumb_width, thumb_height = 180, 240
    sheet_columns = 8
    sheet_rows = max(1, (len(card_images) + sheet_columns - 1) // sheet_columns)
    sheet = Image.new("RGB", (sheet_columns * 200, sheet_rows * 270), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.load_default()
    for index, crop in enumerate(card_images):
        preview = crop.copy()
        preview.thumbnail((thumb_width, thumb_height), Image.Resampling.LANCZOS)
        x = (index % sheet_columns) * 200 + (thumb_width - preview.width) // 2 + 10
        y = (index // sheet_columns) * 270 + 8
        sheet.paste(preview, (x, y))
        draw.text((index % sheet_columns * 200 + 10, y + 244), f"#{index + 1:03d} {cards[index]['referenceRatio']}", fill="#202522", font=font)
    sheet.save(CONTACT_SHEET, quality=90, optimize=True)
    print(json.dumps({"ok": True, "columns": len(columns), "cards": len(cards), "manifest": str(MANIFEST)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
