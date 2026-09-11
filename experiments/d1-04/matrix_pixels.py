"""D1-04B §7/§8：主题矩阵的像素断言。

抓的是"computed style 正确但实际渲染错误"这一类问题，
以及用户点名的那条硬回归：

  Dark + FULL 的 WindowContent 合成像素必须回到 D1-04 baseline 附近 (20,20,20)，
  绝不能接近浅色（R/G/B > 200）。
  Light + FULL 反向：不得变成深色。

采样点与 D1-04 baseline 一致（窗口内容区中心偏下）。

注意：与历史值的**权威对照**在 solid-bar-probe 的 before/tokenfix 两次采样里做
（那一套探测不打开浮层，状态与 D1-04 完全可比）。本脚本负责语义断言：
每一格的合成像素必须属于它自己的主题，且深色格的窗口内容必须落在暗部区间。
"""
import json
import sys
from PIL import Image

ART = "artifacts/d1-04"
# 深色下窗口内容允许的暗部区间（baseline (20,20,20) 及相邻档位）
DARK_WINDOWCONTENT_BAND = {
    "dark-full": (12, 30),
    "dark-reduced": (12, 30),
    "dark-solid": (8, 20),
}
TOL = 6

data = json.load(open(f"{ART}/theme-matrix.json"))

fail = []
rows = []
for key, r in data.items():
    theme, glass = key.split("-")
    img = Image.open(r["png"]).convert("RGB")
    px = {n: img.getpixel(tuple(p)) for n, p in r["pts"].items() if p}
    rows.append((key, px))

    win = px.get("Window")
    wc = px.get("WindowContent")
    tb = px.get("TopBar")
    dk = px.get("Dock")
    menu = px.get("Menu")

    # 断言 A：窗口外壳与窗口内容的合成像素必须属于本主题
    for name, p in (("Window", win), ("WindowContent", wc), ("Menu", menu)):
        if p is None:
            fail.append(f"{key}: 没采到 {name}")
            continue
        if theme == "dark" and min(p) > 200:
            fail.append(f"{key}: {name}={p} 接近浅色 —— 硬回归")
        if theme == "light" and max(p) < 90:
            fail.append(f"{key}: {name}={p} 接近深色 —— 反向回归")

    # 断言 B：深色格窗口内容必须落在暗部区间（抓"深色被算成浅色"）
    if key in DARK_WINDOWCONTENT_BAND and wc is not None:
        lo, hi = DARK_WINDOWCONTENT_BAND[key]
        if not all(lo <= v <= hi for v in wc):
            fail.append(f"{key}: WindowContent={wc} 不在暗部区间 [{lo},{hi}]")

print("=== 主题矩阵 · 合成后像素 ===")
print(
    f"{'格':<14}{'Desktop':<18}{'Window':<18}{'WindowContent':<20}"
    f"{'TitleBar':<18}{'TopBar':<18}{'Dock':<18}{'Menu'}"
)
for key, px in rows:
    f = lambda n: str(px.get(n, "-"))
    print(
        f"{key:<14}{f('Desktop'):<18}{f('Window'):<18}{f('WindowContent'):<20}"
        f"{f('TitleBar'):<18}{f('TopBar'):<18}{f('Dock'):<18}{f('Menu')}"
    )

print("\n=== 像素断言 ===")
print("  深色格窗口内容暗部区间：" + ", ".join(f"{k}→[{v[0]},{v[1]}]" for k, v in DARK_WINDOWCONTENT_BAND.items()))
if fail:
    for x in fail:
        print("  FAIL " + x)
    print(f"  {len(fail)} 条失败")
    sys.exit(1)
print("  全部通过（六格都属于各自主题；深色格窗口内容落在暗部）")
