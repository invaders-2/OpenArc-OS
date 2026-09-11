"""D1-04B §10：材质切换过渡连拍的闪白/闪黑检查。

判据：一步切换的过渡期，任一帧的目标像素必须落在
"切换前那档"和"切换后那档"的 settled 值之间（含容差）。
超出上界 = 闪白；低于下界 = 闪黑。

参考值必须取自**同一次运行**的 settled 帧，不能跨运行借值——
不同运行的窗口布局与内容不同，跨运行比对会把正常的布局差异误报成闪烁。
"""
import json
import os
from PIL import Image

ART = "artifacts/d1-04"
SEQ = ["reduced", "solid", "full", "reduced", "solid", "full"]
TOL = 4


def pts_from(rects):
    top, dock, wins = rects["topbar"], rects["dock"], rects["rects"]
    p = {
        "顶栏": (round(top[2] * 0.55), round(top[3] / 2)),
        "Dock": (dock[0] + 8, dock[1] + 12),
    }
    if wins:
        w = wins[0]
        p["窗口内容"] = (round(w[0] + w[2] / 2), round(w[1] + w[3] * 0.6))
    return p


settled = {}
for g in ("full", "reduced", "solid"):
    f = f"{ART}/switch-settled-{g}.png"
    if not os.path.exists(f):
        raise SystemExit(f"缺少参考帧 {f}")
    settled[g] = Image.open(f).convert("RGB")

# 参考帧的几何（取任一档即可，前面已验证三档矩形一致）
geo = json.load(open(f"{ART}/glass-switch.json"))["steps"][0]["settled"]
PTS = pts_from(geo)
print("采样点：", PTS)

bad = []
checked = 0
prev = "full"
for step in json.load(open(f"{ART}/glass-switch.json"))["steps"]:
    to = step["target"]
    for name, pt in PTS.items():
        a = settled[prev].getpixel(pt)
        b = settled[to].getpixel(pt)
        lo = tuple(min(a[i], b[i]) for i in range(3))
        hi = tuple(max(a[i], b[i]) for i in range(3))
        for k in range(4):
            f = f"{ART}/switch-t-{to}-{k}.png"
            px = Image.open(f).convert("RGB").getpixel(pt)
            checked += 1
            if any(px[i] > hi[i] + TOL for i in range(3)):
                bad.append((prev, "→", to, k, name, px, f"越上界 {hi}", "闪白"))
            if any(px[i] < lo[i] - TOL for i in range(3)):
                bad.append((prev, "→", to, k, name, px, f"越下界 {lo}", "闪黑"))
    prev = to

print(f"\n检查 {len(SEQ)} 步 × 4 帧 × {len(PTS)} 点 = {checked} 个采样（容差 ±{TOL}）")
if bad:
    print("发现问题：")
    for x in bad:
        print("  ", x)
else:
    print("结论：过渡期无闪白、无闪黑——全部落在切换前后两档的区间内")
