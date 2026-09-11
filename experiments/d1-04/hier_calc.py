"""D1-04：算玻璃层级明度差，并对照 before/after。"""
import json
from PIL import Image


def lum(rgb):
    def ch(c):
        c = c / 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def load(tag):
    data = json.load(open(f"artifacts/d1-04/hier-{tag}.json"))
    res = {}
    for theme, blk in data.items():
        img = Image.open(blk["png"]).convert("RGB")
        res[theme] = {k: img.getpixel(tuple(p)) for k, p in blk["pts"].items()}
    return res


before, after = load("before"), load("after")
PAIRS = [
    ("顶栏 vs 桌面", "顶栏内", "桌面背景"),
    ("标题栏 vs 窗口内容", "标题栏内", "窗口内容"),
    ("窗口内容 vs 桌面", "窗口内容", "桌面背景"),
    ("Dock 内 vs Dock 外", "Dock内", "Dock外同高"),
    ("幽灵边 顶栏下8 vs 下24", "顶栏下8px", "顶栏下24px"),
]

for theme in ("light", "dark"):
    print(f"=== {theme} ===")
    print(f"  {'对比项':<24}{'改前ΔL':>9}{'改后ΔL':>9}   改后 RGB")
    for name, a, b in PAIRS:
        lb = abs(lum(before[theme][a]) - lum(before[theme][b])) * 255
        la = abs(lum(after[theme][a]) - lum(after[theme][b])) * 255
        print(f"  {name:<24}{lb:>9.1f}{la:>9.1f}   {after[theme][a]} / {after[theme][b]}")
    print()
