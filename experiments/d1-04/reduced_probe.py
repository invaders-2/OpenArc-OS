#!/usr/bin/env python3
"""D1-04C：从 reduced-color-probe.mjs 的截图里取"窗口正文实色"该用哪个值。

取众数（出现最多的量化色）而不是单点采样——窗口正文里有文字/图标，
单点会踩到笔画上。只统计窗口正文区域（去掉标题条 44px）。

同时输出层级差：窗口正文 vs 桌面、正文 vs 卡片面、顶栏 vs 桌面。
"""
import json
import pathlib
from collections import Counter

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
ART = ROOT / "artifacts" / "d1-04"
data = json.loads((ART / "reduced-probe.json").read_text())


def mode_color(img, box, step=3):
    px = img.load()
    x0, y0, x1, y1 = box
    c = Counter()
    for y in range(int(y0), int(y1), step):
        for x in range(int(x0), int(x1), step):
            c[px[x, y][:3]] += 1
    return c.most_common(1)[0][0], c.most_common(3)


def lum(rgb):
    return round(sum(rgb) / 3, 1)


print("主题   档位      窗口正文(众数)  桌面      正文−桌面  顶栏      Dock     标题条")
print("-" * 88)

table = {}
for s in data["samples"]:
    img = Image.open(ART / s["shot"]).convert("RGB")
    g = s["geo"]
    w = g["window"]
    # 正文区域：窗口内、跳过标题条；再向内缩 12px 避开圆角与描边
    body_box = (w["x"] + 12, w["y"] + g["title"] + 12, w["x"] + w["w"] - 12, w["y"] + w["h"] - 12)
    body, top3 = mode_color(img, body_box)
    # 标题条：窗口顶部 44px 中间一段
    title_box = (w["x"] + w["w"] * 0.25, w["y"] + 6, w["x"] + w["w"] * 0.75, w["y"] + g["title"] - 6)
    title, _ = mode_color(img, title_box)
    # 桌面：取窗口左侧的空白带（窗口从 x≈90 起，Dock 在底部中央，顶栏在顶部）
    dsk_box = (18, w["y"] + 40, max(24, w["x"] - 24), w["y"] + 320)
    desktop, _ = mode_color(img, dsk_box)
    tb = g["topbar"]
    topbar, _ = mode_color(img, (tb["x"] + 600, tb["y"] + 6, tb["x"] + 900, tb["y"] + tb["h"] - 6))
    dk = g["dock"]
    dock, _ = mode_color(img, (dk["x"] + dk["w"] * 0.4, dk["y"] + 4, dk["x"] + dk["w"] * 0.6, dk["y"] + dk["h"] - 4))
    table[(s["theme"], s["glass"])] = {
        "body": body, "desktop": desktop, "topbar": topbar, "dock": dock, "title": title,
        "bodyTop3": top3,
    }
    print(
        f"{s['theme']:<7}{s['glass']:<10}{str(body):<16}{str(desktop):<10}"
        f"{round(lum(body) - lum(desktop), 1):<11}{str(topbar):<9}{str(dock):<9}{str(title)}"
    )

print()
for theme in ("light", "dark"):
    full = table[(theme, "full")]
    red = table[(theme, "reduced")]
    print(
        f"{theme}: FULL 窗口正文 {full['body']} → REDUCED {red['body']}"
        f"（切档变化 {round(lum(red['body']) - lum(full['body']), 1)} 级）"
    )
    print(
        f"        REDUCED 正文−桌面 {round(lum(red['body']) - lum(red['desktop']), 1)} 级"
        f" / 标题条 {red['title']}（与正文差 {round(lum(red['title']) - lum(red['body']), 1)} 级）"
    )
print()
print("窗口正文实色候选（取 FULL 的合成值，保证切档不改明度）：")
for theme in ("light", "dark"):
    b = table[(theme, "full")]["body"]
    print(f"  {theme}: rgb({b[0]} {b[1]} {b[2]})  ← FULL 窗口正文实测")
