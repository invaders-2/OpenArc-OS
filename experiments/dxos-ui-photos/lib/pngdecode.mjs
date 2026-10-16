/**
 * 最小 PNG 解码器（零依赖）—— 只服务动效帧序列的逐帧像素差分析。
 *
 * 为什么需要：run-all 用 CDP screencast 落盘的是一批 PNG 帧，要计算「哪几帧真的变了、
 * 变化比例多大、多久收敛」，必须能读像素。工程里没有第三方图片库，这里用 node:zlib
 * 实现 8bit 灰度/RGB/RGBA 的非隔行 PNG 解码（screencast 只会产出这几种）。
 *
 * 不支持的形态显式抛错（调色板 / 16bit / 隔行），绝不静默返回假像素。
 */
import zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("不是 PNG（签名不符）");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buffer.length) throw new Error("PNG chunk 越界");
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === "IDAT") {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height) throw new Error("PNG 缺少 IHDR");
  if (bitDepth !== 8) throw new Error("只支持 8bit PNG，实际 " + bitDepth);
  if (interlace !== 0) throw new Error("不支持隔行 PNG");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error("不支持的 PNG colorType " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const outLine = out.subarray(y * stride, (y + 1) * stride);
    const prevLine = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const x = line[i];
      const a = i >= channels ? outLine[i - channels] : 0;
      const b = prevLine ? prevLine[i] : 0;
      const c = prevLine && i >= channels ? prevLine[i - channels] : 0;
      let value;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        value = x + pred;
      } else throw new Error("未知 PNG 过滤器 " + filter);
      outLine[i] = value & 0xff;
    }
  }
  return { width: width, height: height, channels: channels, data: out };
}

/**
 * 两帧像素差：返回变化像素比例与最大通道差。
 * channels 必须一致；不同尺寸直接判定为“整帧变化”。
 */
export function diffPixels(a, b, tolerance) {
  const tol = Number.isFinite(tolerance) ? tolerance : 2;
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    return { changedPixels: a.width * a.height, totalPixels: a.width * a.height, changedRatio: 1, maxChannelDiff: 255, sizeMismatch: true };
  }
  const total = a.width * a.height;
  let changed = 0;
  let maxDiff = 0;
  const n = a.data.length;
  for (let i = 0; i < n; i += a.channels) {
    let pixelDiff = 0;
    for (let k = 0; k < a.channels; k += 1) {
      const d = Math.abs(a.data[i + k] - b.data[i + k]);
      if (d > pixelDiff) pixelDiff = d;
    }
    if (pixelDiff > maxDiff) maxDiff = pixelDiff;
    if (pixelDiff > tol) changed += 1;
  }
  return { changedPixels: changed, totalPixels: total, changedRatio: total ? changed / total : 0, maxChannelDiff: maxDiff, sizeMismatch: false };
}
