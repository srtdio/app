"""PR C before/after composites (avatars, badges, icons, breakpoint, gestures).

For each screen, one JPEG (quality 80): row 1 light, row 2 dark. Phone and
laptop screens have four columns: phone before, phone after, laptop before,
laptop after. The -ipad screens (820x1180, touch) have two: ipad before, ipad
after. Each cell is scaled to fit a common height (phone cells about 323 wide,
ipad cells about 486, laptop cells 1000), a label is stamped top-left, and a
missing PNG renders a placeholder cell labelled "not captured".

Usage (PIL required; run isolated):
  python3 -I e2e/audit/composite-pr-c.py BEFORE_DIR AFTER_DIR OUT_DIR [onboarding]

Inputs are capture-pr-c.spec.ts PNGs: <screen>__<phone|laptop|ipad>__<light|dark>.png.
Writes OUT_DIR/<screen>.jpg and OUT_DIR/index.json (screen -> what it shows:
E3-01 and E5-01 are the 24 Oct consistency audit findings; PRC1 to PRC5 are
PR C's decisions) and prints the total size. With the onboarding argument it
composes the ONBOARDING screens instead (capture-pr-c-onboarding.spec.ts PNGs)
and merges them into the index.json already in OUT_DIR, keeping its entries;
the size check then covers the whole OUT_DIR.
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

# Screen -> what the before/after pair shows.
SCREENS = {
    "chat-list": ["E3-01", "E5-01", "PRC1-avatars"],
    "chat-thread": ["E3-01", "PRC1-avatars"],
    "chat-thread-group": ["E3-01", "PRC1-avatars"],
    "chat-search-empty": ["E3-01"],
    "chat-info-group": ["PRC1-avatars"],
    "members": ["PRC1-avatars"],
    "pipeline": ["E5-01", "PRC2-badges"],
    "notifications": ["E5-01", "PRC1-avatars"],
    "post-more-menu": ["PRC3-icons"],
    "message-action-menu": ["PRC3-icons"],
    "composer-tray": ["PRC3-icons"],
    "post-detail-approver": ["PRC1-avatars"],
    "chat-list-ipad": ["PRC4-breakpoint"],
    "pipeline-ipad": ["PRC4-breakpoint"],
}

# The onboarding screens (capture-pr-c-onboarding.spec.ts) -> what they show:
# ONB-auth the signed-out screens, ONB-preapp OnboardingFlow, ONB-setup the
# creator's setup in the shell under the guide, ONB-tour the approver tour.
# Then what the pair shows: unchanged (no pixel differs), PRC1-avatars,
# guide-dock (the guide bar and cards dock on the shared inset), preview-race
# (the laptop composer preview ends measured or "Measuring the original." run
# to run, a product race the visual lock masks).
ONBOARDING = {
    "onboarding-sign-up": ["ONB-auth", "unchanged"],
    "onboarding-sign-in": ["ONB-auth", "unchanged"],
    "onboarding-invite-accept": ["ONB-auth", "unchanged"],
    "onboarding-welcome": ["ONB-preapp", "unchanged"],
    "onboarding-side": ["ONB-preapp", "PRC1-avatars"],
    "onboarding-name": ["ONB-preapp", "PRC1-avatars"],
    "onboarding-photo-crop": ["ONB-preapp", "PRC1-avatars"],
    "onboarding-role": ["ONB-preapp", "PRC1-avatars"],
    "onboarding-brand": ["ONB-preapp", "PRC1-avatars"],
    "onboarding-waiting": ["ONB-preapp", "unchanged"],
    "onboarding-workspace-slot": ["ONB-setup", "PRC1-avatars"],
    "onboarding-workspace-name": ["ONB-setup", "PRC1-avatars"],
    "onboarding-workspace-confirm": ["ONB-setup", "PRC1-avatars"],
    "onboarding-first-post": ["ONB-setup", "PRC1-avatars", "preview-race"],
    "onboarding-invite-approver": ["ONB-setup", "PRC1-avatars"],
    "onboarding-done": ["ONB-setup", "PRC1-avatars", "guide-dock"],
    "onboarding-tour-intro": ["ONB-tour", "PRC1-avatars", "guide-dock"],
    "onboarding-tour-1": ["ONB-tour", "PRC1-avatars", "guide-dock"],
    "onboarding-tour-2": ["ONB-tour", "PRC1-avatars", "guide-dock"],
    "onboarding-tour-3": ["ONB-tour", "PRC1-avatars", "guide-dock"],
}

# Cell sizes: iPhone 13 is 390x844 CSS px, iPad portrait 820x1180, the laptop 1280x800.
CELL_H = 700
WIDTHS = {
    "phone": round(390 * CELL_H / 844),
    "ipad": round(820 * CELL_H / 1180),
    "laptop": 1000,
}
GAP = 8
QUALITY = 80
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
    width = WIDTHS[device]
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


def columns_for(screen, before, after):
    if screen.endswith("-ipad"):
        return [("ipad", before, "ipad before"), ("ipad", after, "ipad after")]
    return [
        ("phone", before, "phone before"),
        ("phone", after, "phone after"),
        ("laptop", before, "laptop before"),
        ("laptop", after, "laptop after"),
    ]


def composite(before, after, screen):
    columns = columns_for(screen, before, after)
    widths = [WIDTHS[c[0]] for c in columns]
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


def folder_size(directory):
    return sum(
        os.path.getsize(os.path.join(directory, name))
        for name in os.listdir(directory)
        if os.path.isfile(os.path.join(directory, name))
    )


def main(argv):
    if len(argv) not in (4, 5) or (len(argv) == 5 and argv[4] != "onboarding"):
        print(__doc__)
        return 2
    before, after, out = argv[1], argv[2], argv[3]
    onboarding = len(argv) == 5
    screens = ONBOARDING if onboarding else SCREENS
    os.makedirs(out, exist_ok=True)
    total = 0
    for screen in screens:
        path = os.path.join(out, f"{screen}.jpg")
        composite(before, after, screen).save(path, "JPEG", quality=QUALITY, optimize=True)
        total += os.path.getsize(path)
    index = os.path.join(out, "index.json")
    entries = {}
    if onboarding and os.path.isfile(index):
        with open(index, encoding="utf-8") as fh:
            entries = json.load(fh)
    entries.update(screens)
    with open(index, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(entries, indent=2) + "\n")
    total += os.path.getsize(index)
    print(f"{len(screens)} composites, {total / 1_000_000:.2f} MB written in {out}")
    if onboarding:
        total = folder_size(out)
        print(f"{out} holds {total / 1_000_000:.2f} MB")
    return 0 if total < 10_000_000 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
