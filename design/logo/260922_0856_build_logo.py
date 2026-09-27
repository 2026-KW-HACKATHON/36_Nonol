#!/usr/bin/env python3
"""노놀 로고 패키지 생성기.

svg/ 의 마스터 벡터에서 png/, favicon/, sns/, print/ 를 전부 다시 만든다.
생성물은 손으로 고치지 않는다. 로고를 바꾸려면 svg/ 를 고치고 이 스크립트를 다시 돌린다.

    python3 260922_0856_build_logo.py

필요한 것: 구글 크롬 (SVG 를 픽셀로 그리는 데 쓴다), Pillow (favicon.ico 와 SNS 합성).
Pillow 가 없으면 `pip install pillow`.
"""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
W, H = 318, 247  # 마스터 SVG 의 viewBox 비율
RATIO = H / W

# 어떤 SVG 를 어떤 너비로 뽑을지. 파일명은 <svg 이름>_<너비>.png
PNG_PLAN = {
    "nonol_logo_color": [256, 512, 1024, 2048, 4096],
    "nonol_logo_black": [1024, 2048],
    "nonol_logo_white": [1024, 2048],
    "nonol_logo_blue": [1024, 2048],
    "nonol_symbol_color": [256, 512, 1024, 2048],
    "nonol_symbol_black": [1024],
    "nonol_symbol_white": [1024],
}
FAVICON_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512]


def render_svg(svg: Path, width: int, out: Path, height: int | None = None, background: str = "00000000"):
    """크롬 헤드리스로 SVG 를 정확한 픽셀 크기의 PNG 로 그린다. 기본 배경은 투명."""
    height = height or round(width * RATIO)
    html = f'<!doctype html><html><body style="margin:0;background:transparent"><img src="{svg.as_uri()}" style="width:{width}px;height:{height}px;display:block"></body></html>'
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as t:
        t.write(html)
        tmp = t.name
    try:
        subprocess.run([
            CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
            f"--default-background-color={background}", f"--window-size={width},{height}",
            f"--screenshot={out}", Path(tmp).as_uri(),
        ], check=True, capture_output=True, timeout=60)
    finally:
        os.unlink(tmp)


def main():
    if not Path(CHROME).exists():
        sys.exit(f"크롬이 없습니다: {CHROME}")
    from PIL import Image

    svg_dir, png_dir, fav_dir, sns_dir, print_dir = (HERE / d for d in ("svg", "png", "favicon", "sns", "print"))
    for d in (png_dir, fav_dir, sns_dir, print_dir):
        d.mkdir(exist_ok=True)

    # 1. 일반 PNG (투명 배경)
    n = 0
    for name, widths in PNG_PLAN.items():
        for w in widths:
            render_svg(svg_dir / f"{name}.svg", w, png_dir / f"{name}_{w}.png")
            n += 1
    print(f"png/ {n}장")

    # 2. 파비콘과 앱 아이콘: 정사각형 안에 로고를 넣는다 (가로 92%, 위아래 여백)
    master = svg_dir / "nonol_logo_color.svg"
    big = png_dir / "nonol_logo_color_4096.png"
    src = Image.open(big).convert("RGBA")
    for s in FAVICON_SIZES:
        canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        lw = round(s * 0.92)
        lh = round(lw * RATIO)
        logo = src.resize((lw, lh), Image.LANCZOS)
        canvas.alpha_composite(logo, ((s - lw) // 2, (s - lh) // 2))
        canvas.save(fav_dir / f"icon_{s}.png")
    (fav_dir / "apple-touch-icon.png").write_bytes((fav_dir / "icon_180.png").read_bytes())
    # 마스커블 아이콘 (안드로이드): 안전 영역이 중앙 80% 이므로 로고를 66% 로 줄이고 흰 배경
    m = Image.new("RGBA", (512, 512), (255, 255, 255, 255))
    lw = round(512 * 0.66); lh = round(lw * RATIO)
    m.alpha_composite(src.resize((lw, lh), Image.LANCZOS), ((512 - lw) // 2, (512 - lh) // 2))
    m.save(fav_dir / "icon_maskable_512.png")
    icons = [Image.open(fav_dir / f"icon_{s}.png") for s in (16, 32, 48, 64, 128, 256)]
    icons[0].save(fav_dir / "favicon.ico", format="ICO", sizes=[(i.width, i.height) for i in icons], append_images=icons[1:])
    print(f"favicon/ {len(FAVICON_SIZES) + 3}개")

    # 3. SNS 프로필과 커버: 정사각형 흰 배경과 파랑 배경, 가로형 커버
    def square(size, bg, logo_png, scale=0.72, name=""):
        c = Image.new("RGBA", (size, size), bg)
        lw = round(size * scale); lh = round(lw * RATIO)
        c.alpha_composite(Image.open(logo_png).convert("RGBA").resize((lw, lh), Image.LANCZOS), ((size - lw) // 2, (size - lh) // 2))
        c.convert("RGB").save(sns_dir / name, quality=95)
    square(1080, (255, 255, 255, 255), big, name="profile_1080_white.png")
    square(1080, (61, 98, 173, 255), png_dir / "nonol_logo_white_2048.png", name="profile_1080_blue.png")
    square(400, (255, 255, 255, 255), big, name="profile_400_white.png")
    cover = Image.new("RGBA", (1500, 500), (255, 255, 255, 255))
    lw = 420; lh = round(lw * RATIO)
    cover.alpha_composite(src.resize((lw, lh), Image.LANCZOS), ((1500 - lw) // 2, (500 - lh) // 2))
    cover.convert("RGB").save(sns_dir / "cover_1500x500_white.png", quality=95)
    print("sns/ 4장")

    # 4. 인쇄용 PDF (벡터 그대로). 크롬 print-to-pdf 로 로고 크기의 쪽을 만든다
    for name in ("nonol_logo_color", "nonol_logo_black", "nonol_symbol_color"):
        html = f'<!doctype html><html><head><style>@page{{size:{W}px {H}px;margin:0}}html,body{{margin:0}}img{{width:{W}px;height:{H}px;display:block}}</style></head><body><img src="{(svg_dir / (name + ".svg")).as_uri()}"></body></html>'
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as t:
            t.write(html); tmp = t.name
        subprocess.run([CHROME, "--headless=new", "--no-pdf-header-footer", f"--print-to-pdf={print_dir / (name + '.pdf')}", Path(tmp).as_uri()], check=True, capture_output=True, timeout=60)
        os.unlink(tmp)
    print("print/ 3개")


if __name__ == "__main__":
    main()
