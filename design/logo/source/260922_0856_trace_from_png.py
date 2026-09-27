#!/usr/bin/env python3
"""원본 PNG (318x247) 에서 마스터 SVG 를 만든 과정의 기록. 다시 돌릴 일은 거의 없다.

2026-09-22 Claude 가 실행한 절차:
1. 원본 PNG 의 글자 "NoNol" 은 흰색이 아니라 투명한 구멍이었다. 실루엣(구멍을 메운 모양)과
   글자(구멍)를 나눠서 처리했다.
2. 구름 실루엣은 벡터 추적 대신 타원 5개(좌우 2, 위 1, 아래 1, 가운데 1)의 합집합으로
   맞췄다 (좌우 대칭, Nelder-Mead 로 픽셀 불일치 0.54% 까지). 결과는 cloud_shape_params.npy.
   순서: [lx, ly, lrx, lry, ty, trx, try, by, brx, bry, ery], 중심 x 는 159.
3. 글자는 16배 확대 후 가우시안 블러(반경 12)로 계단을 지우고 vtracer(spline 모드,
   corner 130, length 14, splice 75) 로 추적했다. 결과 path 는 letters_path.txt.
4. 파랑과 초록의 경계는 y = 123.81 (원본 8배 기준 990.5 / 8) 수평선이다.

필요한 것: pip install vtracer pillow numpy scipy
"""
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage
from scipy.optimize import minimize

HERE = Path(__file__).resolve().parent
SRC = HERE / "original_logo_318x247.png"
CX = 159


def fit_cloud(alpha):
    K = 4
    big = Image.fromarray(alpha).resize((alpha.shape[1] * K, alpha.shape[0] * K), Image.LANCZOS)
    mask = ndimage.binary_fill_holes(np.array(big) > 127)
    H, W = mask.shape
    yy, xx = np.mgrid[0:H, 0:W]
    xx = (xx + 0.5) / K
    yy = (yy + 0.5) / K

    def render(p):
        lx, ly, lrx, lry, ty, trx, try_, by, brx, bry, ery = p
        m = (((xx - (CX - lx)) / lrx) ** 2 + ((yy - ly) / lry) ** 2 < 1) | (((xx - (CX + lx)) / lrx) ** 2 + ((yy - ly) / lry) ** 2 < 1)
        m |= (((xx - CX) / trx) ** 2 + ((yy - ty) / try_) ** 2 < 1) | (((xx - CX) / brx) ** 2 + ((yy - by) / bry) ** 2 < 1)
        m |= ((xx - CX) / (lx + lrx * 0.98)) ** 2 + ((yy - ly) / ery) ** 2 < 1
        return m

    loss = lambda p: (render(p) ^ mask).sum() / mask.sum()
    p = [89, 123.7, 68, 68, 74.7, 75, 75, 172.4, 75.3, 75.3, 60]
    for _ in range(2):
        p = minimize(loss, p, method="Nelder-Mead", options={"maxiter": 4000, "xatol": 0.02, "fatol": 1e-6}).x
    print("구름 불일치 비율 %.4f" % loss(p))
    return p


def trace_letters(alpha):
    import vtracer

    filled = ndimage.binary_fill_holes(alpha > 127)
    inv = Image.fromarray(((255 - alpha) * filled).astype(np.uint8))
    K = 16
    big = inv.resize((alpha.shape[1] * K, alpha.shape[0] * K), Image.BICUBIC).filter(ImageFilter.GaussianBlur(12))
    m = np.array(big) > 127
    img = np.full(m.shape + (3,), 255, np.uint8)
    img[m] = 0
    tmp_png, tmp_svg = HERE / "_letters_mask.png", HERE / "_letters_traced.svg"
    Image.fromarray(img).save(tmp_png)
    vtracer.convert_image_to_svg_py(str(tmp_png), str(tmp_svg), colormode="binary", hierarchical="stacked", mode="spline",
                                    filter_speckle=128, corner_threshold=130, length_threshold=14.0, max_iterations=20,
                                    splice_threshold=75, path_precision=2)
    fmt = lambda v: ("%.2f" % v).rstrip("0").rstrip(".")
    parts = []
    # vtracer 는 path 마다 transform="translate(tx,ty)" 를 붙이므로 좌표에 합치고 1/K 로 줄인다
    for mm in re.finditer(r'<path d="([^"]+)"[^>]*?transform="translate\(([-\d.]+),([-\d.]+)\)"', tmp_svg.read_text()):
        d, tx, ty = mm.group(1), float(mm.group(2)), float(mm.group(3))
        out, xy = [], 0
        for t in re.findall(r"[MLCZ]|-?\d+(?:\.\d+)?", d):
            if t in "MLCZ":
                out.append(t); xy = 0
            else:
                v = (float(t) + (tx if xy == 0 else ty)) / K
                xy ^= 1
                out.append(fmt(v))
        parts.append(" ".join(out))
    tmp_png.unlink(); tmp_svg.unlink()
    print("글자 path", len(parts), "개")
    return " ".join(parts)


if __name__ == "__main__":
    alpha = np.array(Image.open(SRC).convert("RGBA"))[:, :, 3]
    p = fit_cloud(alpha)
    np.save(HERE / "cloud_shape_params.npy", p)
    (HERE / "letters_path.txt").write_text(trace_letters(alpha))
    print("cloud_shape_params.npy 와 letters_path.txt 를 갱신했다. svg/ 는 260922_0856_build_logo.py 가 아니라 이 값을 넣어 다시 써야 한다.", file=sys.stderr)
