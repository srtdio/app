"""PR B before/after composites (spec section 8).

For each screen, one JPEG (quality 82): row 1 light, row 2 dark; columns
phone before, phone after, laptop before, laptop after. Each cell is scaled
to a common height per column kind (phone cells about 323 wide, laptop cells
1000 wide), a label is stamped top-left, and a missing PNG renders a
placeholder cell labelled "not captured".

Usage (PIL required; run isolated):
  python3 -I e2e/audit/composite-pr-b.py BEFORE_DIR AFTER_DIR OUT_DIR

Inputs are the capture spec's PNGs: <screen>__<phone|laptop>__<light|dark>.png.
Writes OUT_DIR/<screen>.jpg and prints the total size.
"""

import os
import sys

from PIL import Image, ImageDraw, ImageFont

SCREENS = [
    "pipeline",
    "pipeline-approver",
    "plan-tab",
    "notifications",
    "briefs-approver",
    "briefs-empty",
    "assets",
    "assets-empty",
    "chat-list",
    "post-detail",
    "post-detail-approver",
    "chat-post-sheet",
    "chat-post-sheet-approver",
    "chat-post-sheet-scrolled",
    "brief-detail",
    "post-more-menu",
    "brief-more-menu",
    "asset-more-menu",
    "chat-actions-menu",
    "message-action-menu",
    "create-post-sheet",
    "new-chat-sheet",
    "confirm-dialog-delete",
    "undo-strip-after-delete",
    "approve-confirm-approver",
    "on-behalf-confirm",
    "recently-deleted",
    "recently-deleted-empty",
    "toast-copy-link",
]

# Cell sizes: iPhone 13 is 390x844 CSS px, the laptop 1280x800.
CELL_H = 700
PHONE_W = round(390 * CELL_H / 844)
LAPTOP_W = 1000
GAP = 8
QUALITY = 82
BG = (128, 128, 128)
PLACEHOLDER = (90, 90, 90)


def load_font(size):
    for name in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
        "DejaVuSans-Bold.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


FONT = load_font(16)


def fit(img, width, height):
    """Scale to fit inside width x height (keeping aspect), centred on the cell."""
    img = img.convert("RGB")
    scale = min(width / img.width, height / img.height)
    size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
    img = img.resize(size, Image.LANCZOS)
    cell = Image.new("RGB", (width, height), BG)
    cell.paste(img, ((width - size[0]) // 2, (height - size[1]) // 2))
    return cell


def stamp(cell, text):
    draw = ImageDraw.Draw(cell)
    box = draw.textbbox((0, 0), text, font=FONT)
    w, h = box[2] - box[0], box[3] - box[1]
    draw.rectangle([0, 0, w + 12, h + 10], fill=(0, 0, 0))
    draw.text((6, 4 - box[1]), text, font=FONT, fill=(255, 255, 255))
    return cell


def cell_for(directory, screen, device, scheme, label):
    width = PHONE_W if device == "phone" else LAPTOP_W
    src = os.path.join(directory, f"{screen}__{device}__{scheme}.png")
    if os.path.isfile(src):
        with Image.open(src) as img:
            cell = fit(img, width, CELL_H)
    else:
        cell = Image.new("RGB", (width, CELL_H), PLACEHOLDER)
        draw = ImageDraw.Draw(cell)
        msg = "not captured"
        box = draw.textbbox((0, 0), msg, font=FONT)
        draw.text(
            ((width - (box[2] - box[0])) // 2, (CELL_H - (box[3] - box[1])) // 2),
            msg,
            font=FONT,
            fill=(230, 230, 230),
        )
    return stamp(cell, f"{label} {scheme}")


def composite(before, after, screen):
    columns = [
        ("phone", before, "phone before"),
        ("phone", after, "phone after"),
        ("laptop", before, "laptop before"),
        ("laptop", after, "laptop after"),
    ]
    widths = [PHONE_W if c[0] == "phone" else LAPTOP_W for c in columns]
    total_w = sum(widths) + GAP * (len(columns) + 1)
    total_h = CELL_H * 2 + GAP * 3
    sheet = Image.new("RGB", (total_w, total_h), (255, 255, 255))
    for row, scheme in enumerate(("light", "dark")):
        x = GAP
        for (device, directory, label), width in zip(columns, widths):
            cell = cell_for(directory, screen, device, scheme, label)
            sheet.paste(cell, (x, GAP + row * (CELL_H + GAP)))
            x += width + GAP
    return sheet


def main(argv):
    if len(argv) != 4:
        print(__doc__)
        return 2
    before, after, out = argv[1], argv[2], argv[3]
    os.makedirs(out, exist_ok=True)
    total = 0
    for screen in SCREENS:
        path = os.path.join(out, f"{screen}.jpg")
        composite(before, after, screen).save(path, "JPEG", quality=QUALITY, optimize=True)
        total += os.path.getsize(path)
    print(f"{len(SCREENS)} composites, {total / 1_000_000:.2f} MB in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
