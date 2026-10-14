/**
 * 像素差异度量（纯函数，浏览器 / Node 共用）。
 *
 * 为什么把度量写成"自包含纯函数"：
 *   - run-all.mjs 里用 Playwright 打开一个本地页面，把基准图与当前图都画进 canvas，
 *     再用 getImageData 取出 RGBA 缓冲区，在浏览器里调用 computeDiffMetrics 算差异；
 *   - 单测（tests/dxos-visual-baseline.test.mjs）在 Node 里直接调用同一个函数，
 *     保证"被测逻辑"与"实跑逻辑"是同一份代码，而不是两份平行实现。
 * 因此这里刻意不引用任何模块级变量：computeDiffMetrics / renderDiffImage 通过
 * Function.prototype.toString() 注入浏览器，任何外部引用都会在浏览器里变成 undefined。
 *
 * 不引入任何第三方图片库：解码/编码全部交给浏览器 canvas，本文件只做数值计算。
 */

/**
 * 由两幅等尺寸 RGBA 像素缓冲区计算差异度量。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgbaA 基准图像素（长度 width*height*4）
 * @param {Uint8ClampedArray|Uint8Array} rgbaB 当前图像素（长度同上）
 * @param {number} width  像素宽
 * @param {number} height 像素高
 * @param {{ pixelTolerance?: number }} [options] pixelTolerance：单像素最大通道差 > 该值才算"变化像素"，默认 0
 * @returns {{ ok: true, width: number, height: number, totalPixels: number, changedPixels: number,
 *            changedRatio: number, maxChannelDiff: number, meanChannelDiff: number,
 *            bbox: { x:number, y:number, width:number, height:number } | null, pixelTolerance: number }
 *          | { ok: false, error: { code: string, message: string } }}
 */
export function computeDiffMetrics(rgbaA, rgbaB, width, height, options) {
  const opts = options || {};
  const tolerance = Number.isFinite(opts.pixelTolerance) ? opts.pixelTolerance : 0;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return { ok: false, error: { code: "IMAGE_SIZE_INVALID", message: "图像尺寸非法：" + width + "×" + height } };
  }
  const expected = width * height * 4;
  if (!rgbaA || !rgbaB) {
    return { ok: false, error: { code: "PIXEL_BUFFER_MISSING", message: "缺少像素缓冲区" } };
  }
  if (rgbaA.length !== expected || rgbaB.length !== expected) {
    return {
      ok: false,
      error: {
        code: "PIXEL_BUFFER_SIZE",
        message: "像素缓冲区长度不符：期望 " + expected + "，实际 " + rgbaA.length + " / " + rgbaB.length,
      },
    };
  }

  let changedPixels = 0;
  let maxChannelDiff = 0;
  let channelSum = 0;
  let minX = -1;
  let minY = -1;
  let maxX = -1;
  let maxY = -1;
  const totalPixels = width * height;

  for (let i = 0; i < expected; i += 4) {
    let pixelDiff = 0;
    for (let k = 0; k < 4; k += 1) {
      const d = Math.abs(rgbaA[i + k] - rgbaB[i + k]);
      channelSum += d;
      if (d > pixelDiff) pixelDiff = d;
    }
    if (pixelDiff > maxChannelDiff) maxChannelDiff = pixelDiff;
    if (pixelDiff > tolerance) {
      changedPixels += 1;
      const p = i / 4;
      const x = p % width;
      const y = (p - x) / width;
      if (minX < 0 || x < minX) minX = x;
      if (maxX < 0 || x > maxX) maxX = x;
      if (minY < 0 || y < minY) minY = y;
      if (maxY < 0 || y > maxY) maxY = y;
    }
  }

  return {
    ok: true,
    width,
    height,
    totalPixels,
    changedPixels,
    changedRatio: changedPixels / totalPixels,
    maxChannelDiff,
    meanChannelDiff: channelSum / (totalPixels * 4),
    bbox: changedPixels > 0 ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    pixelTolerance: tolerance,
  };
}

/**
 * 生成"差异放大图"（浏览器专用：需要 document/canvas）。
 *
 * 取差异包围盒并按 diffScale 倍最近邻放大，避免整屏导出导致文件过大；
 * 背景是当前图的压暗灰度（保留版面上下文），变化像素按通道差强度着色为暖色，
 * 外包一个黄色矩形标出差异包围盒。返回 PNG data URL；无差异返回 null。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgbaA 基准图像素
 * @param {Uint8ClampedArray|Uint8Array} rgbaB 当前图像素
 * @param {number} width
 * @param {number} height
 * @param {ReturnType<typeof computeDiffMetrics>} metrics
 * @param {{ pixelTolerance?: number, diffScale?: number, pad?: number, maxOutput?: number, diffBoost?: number }} [options]
 * @returns {string|null}
 */
export function renderDiffImage(rgbaA, rgbaB, width, height, metrics, options) {
  const opts = options || {};
  if (!metrics || metrics.ok !== true || !metrics.changedPixels) return null;
  const bbox = metrics.bbox;
  if (!bbox) return null;

  const tolerance = Number.isFinite(opts.pixelTolerance) ? opts.pixelTolerance : 0;
  const diffScale = Number.isFinite(opts.diffScale) ? Math.max(1, Math.floor(opts.diffScale)) : 4;
  const pad = Number.isFinite(opts.pad) ? Math.max(0, Math.floor(opts.pad)) : 24;
  const maxOutput = Number.isFinite(opts.maxOutput) ? opts.maxOutput : 4096;
  const boost = Number.isFinite(opts.diffBoost) ? opts.diffBoost : 8;

  const x0 = Math.max(0, bbox.x - pad);
  const y0 = Math.max(0, bbox.y - pad);
  const x1 = Math.min(width, bbox.x + bbox.width + pad);
  const y1 = Math.min(height, bbox.y + bbox.height + pad);
  const regionW = Math.max(1, x1 - x0);
  const regionH = Math.max(1, y1 - y0);

  let scale = diffScale;
  while (scale > 1 && (regionW * scale > maxOutput || regionH * scale > maxOutput)) scale -= 1;
  const outW = regionW * scale;
  const outH = regionH * scale;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(outW, outH);
  const out = image.data;

  for (let oy = 0; oy < outH; oy += 1) {
    const sy = y0 + Math.floor(oy / scale);
    for (let ox = 0; ox < outW; ox += 1) {
      const sx = x0 + Math.floor(ox / scale);
      const si = (sy * width + sx) * 4;
      const di = (oy * outW + ox) * 4;
      let pixelDiff = 0;
      for (let k = 0; k < 4; k += 1) {
        const d = Math.abs(rgbaA[si + k] - rgbaB[si + k]);
        if (d > pixelDiff) pixelDiff = d;
      }
      if (pixelDiff > tolerance) {
        /* 差异放大：暖色，亮度随通道差增强，差异越大越显眼。 */
        out[di] = Math.min(255, 96 + pixelDiff * boost);
        out[di + 1] = Math.min(255, pixelDiff * boost);
        out[di + 2] = Math.min(255, 24 + pixelDiff * boost);
        out[di + 3] = 255;
      } else {
        const gray = Math.round((rgbaB[si] * 0.299 + rgbaB[si + 1] * 0.587 + rgbaB[si + 2] * 0.114) * 0.22);
        out[di] = gray;
        out[di + 1] = gray;
        out[di + 2] = gray;
        out[di + 3] = 255;
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  ctx.strokeStyle = "#ffd400";
  ctx.lineWidth = Math.max(1, scale);
  ctx.strokeRect((bbox.x - x0) * scale + 0.5, (bbox.y - y0) * scale + 0.5, bbox.width * scale - 1, bbox.height * scale - 1);

  return canvas.toDataURL("image/png");
}
