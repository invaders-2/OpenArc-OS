"""D1-04 十三：对 lightbar-{theme}.png 做逐像素采样。

量的是「合成后」的真实像素，不是 CSS 声明值。
输出每个采样点的 RGB 与相对亮度，以及相邻区域的明度差（灰阶层级是否可辨）。
"""
import json
import sys
from PIL import Image

POINTS = {
    "桌面背景": (1350, 460),
    "顶栏内(空白)": (400, 19),
    "顶栏下方 8px": (400, 46),
    "顶栏下方 24px": (400, 62),
    "窗口标题栏(空白)": (860, 116),
    "窗口内容区": (500, 300),
    "Dock 内(空白)": (487, 822),
    "Dock 外同高": (1150, 840),
}


def lum(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg, bg):
    a, b = lum(fg), lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


out = {}
for theme in ("light", "dark"):
    img = Image.open(f"artifacts/d1-04/lightbar-{theme}.png").convert("RGB")
    rows = {}
    for name, (x, y) in POINTS.items():
        px = img.getpixel((x, y))
        rows[name] = {"rgb": list(px), "L": round(lum(px) * 255, 1)}
    out[theme] = rows
    print(f"=== {theme} ===")
    for name, v in rows.items():
        print(f"  {name:<18} rgb={tuple(v['rgb'])}  L={v['L']}")

    d = lambda a, b: round(abs(rows[a]["L"] - rows[b]["L"]), 1)
    print("  层级差（灰阶可辨阈 ~3）:")
    print(f"    顶栏/桌面            {d('顶栏内(空白)', '桌面背景')}")
    print(f"    标题栏/窗口内容      {d('窗口标题栏(空白)', '窗口内容区')}")
    print(f"    窗口外壳/桌面        {d('窗口内容区', '桌面背景')}")
    print(f"    Dock 内/Dock 外      {d('Dock 内(空白)', 'Dock 外同高')}")
    print(f"    幽灵边(顶栏下8-24px) {d('顶栏下方 8px', '顶栏下方 24px')}")

# 文本对比度：取计算样式里的前景色，配采样到的真实背景
for theme in ("light", "dark"):
    coords = json.load(open(f"artifacts/d1-04/coords-{theme}.json"))
    img = Image.open(f"artifacts/d1-04/lightbar-{theme}.png").convert("RGB")
    print(f"\n=== {theme} 文本对比度（前景=计算样式, 背景=合成像素）===")
    for c in coords:
        fg = tuple(int(v) for v in c["color"].replace("rgb(", "").replace(")", "").split(","))
        bg = img.getpixel(tuple(POINTS["桌面背景"]))
        r = contrast(fg, bg)
        print(f"  {c['label']:<12} {c['color']:<20} vs 桌面 {tuple(bg)}  {r:.2f}:1  {'OK' if r >= 4.5 else 'FAIL'}")

json.dump(out, open("artifacts/d1-04/lightbar-samples.json", "w"), ensure_ascii=False, indent=2)
