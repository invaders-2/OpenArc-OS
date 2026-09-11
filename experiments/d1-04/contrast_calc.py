"""D1-04：按 WCAG 2.1 算字心真实背景下的对比度，并对照 before/after。"""
import json
from PIL import Image


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


def parse(c):
    return tuple(int(v) for v in c.replace("rgba(", "").replace("rgb(", "").replace(")", "").split(",")[:3])


def run(tag):
    data = json.load(open(f"artifacts/d1-04/contrast-{tag}.json"))
    rows = {}
    for theme, blk in data.items():
        img = Image.open(blk["png"]).convert("RGB")
        for it in blk["items"]:
            fg = parse(it["color"])
            bg = img.getpixel(tuple(it["pt"]))
            large = it["fontSize"] >= 18 or (it["fontSize"] >= 14 and int(it["fontWeight"]) >= 700)
            need = 3.0 if large else 4.5
            r = contrast(fg, bg)
            rows[(theme, it["label"])] = {
                "ratio": round(r, 2), "need": need, "ok": r >= need,
                "fg": fg, "bg": bg, "size": it["fontSize"],
            }
    return rows


before, after = run("before"), run("after")
print(f"{'主题':<6}{'元素':<14}{'字号':>5}{'改前':>8}{'改后':>8}{'要求':>6}  判定")
worst = {"light": 99, "dark": 99}
for k in before:
    b, a = before[k], after[k]
    ok = "OK" if a["ok"] else "FAIL"
    print(f"{k[0]:<6}{k[1]:<14}{a['size']:>5.0f}{b['ratio']:>8.2f}{a['ratio']:>8.2f}{a['need']:>6.1f}  {ok}"
          f"   bg={a['bg']}")
    worst[k[0]] = min(worst[k[0]], a["ratio"])
print()
for t in ("light", "dark"):
    print(f"{t} 最低对比度（改后）：{worst[t]:.2f}:1  {'PASS' if worst[t] >= 4.5 else 'FAIL'}")
