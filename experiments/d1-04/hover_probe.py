"""D1-04C hover 取证采样。

读 artifacts/d1-04/hover-probe.json + hover-{theme}-{glass}-{rest,over}.png，
在搜索行**右侧留白**取众数色（避开文字与图标），报告：
  - rest / hover 的众数色
  - 每通道差（ΔR,ΔG,ΔB）与感知明度差 ΔL*
  - 两者之间的 WCAG 对比度（比值）
判据：ΔL* ≥ 1.0 视为肉眼可辨；= 0 即 hover 消失（层级回归）。
"""

import json
import os
import sys
from collections import Counter

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ART = os.path.join(ROOT, "artifacts", "d1-04")


def srgb_to_lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def rel_lum(rgb):
    r, g, b = (srgb_to_lin(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = rel_lum(a), rel_lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def lstar(rgb):
    y = rel_lum(rgb)
    return 116 * (y ** (1 / 3)) - 16 if y > 0.008856 else 903.3 * y


def modal_color(img, box):
    x0, y0, x1, y1 = box
    x0, y0 = max(0, int(x0)), max(0, int(y0))
    x1, y1 = min(img.width, int(x1)), min(img.height, int(y1))
    reg = img.crop((x0, y0, x1, y1)).convert("RGB")
    counts = Counter(reg.getdata())
    return counts.most_common(1)[0][0], reg.width * reg.height


def main():
    data = json.load(open(os.path.join(ART, "hover-probe.json")))
    rows = []
    for s in data["samples"]:
        row = s["row"]
        # 右侧留白：行右缘往内 6–26px；垂直方向去掉 6px 上下边
        box = (row["x"] + row["w"] - 26, row["y"] + 6, row["x"] + row["w"] - 6, row["y"] + row["h"] - 6)
        rest = Image.open(os.path.join(ART, s["rest"]))
        over = Image.open(os.path.join(ART, s["over"]))
        cr, _ = modal_color(rest, box)
        co, _ = modal_color(over, box)
        dl = abs(lstar(cr) - lstar(co))
        rows.append((s["theme"], s["glass"], cr, co, dl, contrast(cr, co)))

    hdr = f"{'theme':7}{'tier':9}{'rest':>18}{'hover':>18}{'ΔL*':>8}{'对比度':>9}  判定"
    print(hdr)
    print("-" * len(hdr))
    worst = {}
    for theme, glass, cr, co, dl, ct in rows:
        verdict = "可辨" if dl >= 1.0 else "**不可辨（回归）**"
        print(
            f"{theme:7}{glass:9}{str(cr):>18}{str(co):>18}{dl:>8.2f}{ct:>9.3f}  {verdict}"
        )
        worst[theme] = min(worst.get(theme, 99), dl)
    print()
    print("每主题最小 ΔL*：", {k: round(v, 2) for k, v in worst.items()})
    bad = [r for r in rows if r[4] < 1.0]
    if bad:
        print("失败：", [(r[0], r[1]) for r in bad])
        return 1
    print("全部通过：六格里 hover 都有可测的明度差。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
