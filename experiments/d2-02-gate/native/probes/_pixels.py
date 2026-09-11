#!/usr/bin/env python3
"""
从 screencapture 产出的 PNG 上按 DIP 坐标采样像素，并做色彩管理。

两个必须处理的坑：
1. **capturePage 不含子视图** —— 层级证据只能来自 screencapture 的真实合成帧。
2. **色彩空间** —— macOS 在广色域屏上把合成帧写成 Display P3。
   纯 sRGB 绿 #00ff00 直接读出来是 rgb(117,251,76)，纯红是 rgb(234,51,35)。
   若不做转换，任何颜色断言都只能放到 ±130 的容差，等于断言失效。
   因此这里按 PNG 内嵌 ICC 转到 sRGB 再比较，同时保留 raw 值供排查。

坐标：screencapture -R 用屏幕点（DIP），输出位图是物理像素（Retina 2x）。
      scale 由 位图宽 / 请求宽 反推，不写死。

用法：
  _pixels.py <png> <json>
  json = {"rectW": 1100, "points": {"name": [x,y], ...}}
输出：
  {"scale":2, "size":[w,h], "colorspace":"sRGB|raw", "points":{name:{"rgb":[r,g,b],"raw":[r,g,b],"px":[x,y]}}}
"""
import json
import sys

from PIL import Image, ImageCms

SRGB = ImageCms.createProfile("sRGB")


def srgb_image(im, icc):
    """按内嵌 ICC 转到 sRGB；失败则原样返回（并在输出中标注）。"""
    if not icc:
        return im, "raw(no-icc)"
    try:
        import io

        src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        out = ImageCms.profileToProfile(im, src, SRGB, outputMode="RGB")
        return out, "sRGB"
    except Exception:
        return im, "raw(icc-failed)"


def main() -> int:
    png, raw_spec = sys.argv[1], sys.argv[2]
    spec = json.loads(raw_spec)
    rect_w = float(spec["rectW"])
    points = spec.get("points", {})

    im = Image.open(png)
    icc = im.info.get("icc_profile")
    rgb_im = im.convert("RGB")
    conv, space = srgb_image(rgb_im, icc)
    conv = conv.convert("RGB")
    w, h = conv.size
    scale = w / rect_w

    out = {"scale": scale, "size": [w, h], "colorspace": space, "points": {}}
    for name, (x, y) in points.items():
        px = min(w - 1, max(0, int(round(x * scale))))
        py = min(h - 1, max(0, int(round(y * scale))))
        r, g, b = conv.getpixel((px, py))
        rr, rg, rb = rgb_im.getpixel((px, py))
        out["points"][name] = {"rgb": [r, g, b], "raw": [rr, rg, rb], "px": [px, py]}
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
