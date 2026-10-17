/**
 * 相册 · 宫格切片（纯前端、无第三方依赖）。
 *
 * 切片只在渲染层用 <canvas> 完成：原图字节来自 photos/sourceFile，不额外请求任何服务，
 * 也不写入来源目录。导出使用 store 模式的最小 ZIP（PNG 已压缩，再 deflate 没有收益），
 * 这样一次下载就能拿走 2×2 / 3×3 的全部切片，不需要新增依赖。
 *
 * 为什么自己写 ZIP：项目不允许新增依赖，浏览器也没有内建打包 API；
 * store 模式只要求 CRC32 与三段头结构（本地头 / 中心目录 / EOCD）。
 */

export type SliceGrid = 2 | 3;

export type GridTile = {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 按等分边界切片；边界取整后保证覆盖整张图、且各块不重叠。 */
export function gridTiles(width: number, height: number, grid: SliceGrid): GridTile[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  const tiles: GridTile[] = [];
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      const x = Math.floor((col * width) / grid);
      const y = Math.floor((row * height) / grid);
      const right = Math.floor(((col + 1) * width) / grid);
      const bottom = Math.floor(((row + 1) * height) / grid);
      if (right <= x || bottom <= y) continue;
      tiles.push({ row, col, x, y, width: right - x, height: bottom - y });
    }
  }
  return tiles;
}

export function baseStem(name: string): string {
  const stem = String(name || "").replace(/\.[^.]+$/, "").trim();
  return stem || "photo";
}

/** 单张切片的文件名：photo-3x3-r2c3.png（行列从 1 开始，和用户看到的宫格一致）。 */
export function gridTileName(name: string, grid: SliceGrid, row: number, col: number): string {
  return baseStem(name) + "-" + grid + "x" + grid + "-r" + (row + 1) + "c" + (col + 1) + ".png";
}

export function gridArchiveName(name: string, grid: SliceGrid): string {
  return baseStem(name) + "-" + grid + "x" + grid + ".zip";
}

export type ZipEntry = { name: string; bytes: Uint8Array };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const LOC_METHOD_STORE = 0;
const FLAG_UTF8 = 0x0800;
/** 固定 DOS 时间（2026-10-17 12:00:00）：只用于可读性，不参与内容身份。 */
const DOS_TIME = (12 << 11) | (0 << 5) | 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 17;
const VERSION = 20;
const ZIP64_LIMIT = 0xffffffff;

/** store 模式 ZIP（不压缩）。超过 4 GiB / 65535 项会抛出，而不是静默产出坏包。 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  if (!entries.length) throw new Error("没有可打包的切片");
  if (entries.length > 0xffff) throw new Error("切片数量超出 ZIP 上限");
  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    if (!nameBytes.length) throw new Error("切片文件名不能为空");
    if (entry.bytes.length > ZIP64_LIMIT) throw new Error("单个切片超过 4 GiB，无法打包");
    return { nameBytes, bytes: entry.bytes, crc: crc32(entry.bytes) };
  });
  let total = 22;
  for (const item of prepared) total += 30 + item.nameBytes.length + item.bytes.length + 46 + item.nameBytes.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets: number[] = [];
  for (const item of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, FLAG_UTF8, true);
    view.setUint16(offset + 8, LOC_METHOD_STORE, true);
    view.setUint16(offset + 10, DOS_TIME, true);
    view.setUint16(offset + 12, DOS_DATE, true);
    view.setUint32(offset + 14, item.crc, true);
    view.setUint32(offset + 18, item.bytes.length, true);
    view.setUint32(offset + 22, item.bytes.length, true);
    view.setUint16(offset + 26, item.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    offset += 30;
    out.set(item.nameBytes, offset);
    offset += item.nameBytes.length;
    out.set(item.bytes, offset);
    offset += item.bytes.length;
  }
  const cdStart = offset;
  for (let i = 0; i < prepared.length; i += 1) {
    const item = prepared[i];
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, VERSION, true);
    view.setUint16(offset + 8, FLAG_UTF8, true);
    view.setUint16(offset + 10, LOC_METHOD_STORE, true);
    view.setUint16(offset + 12, DOS_TIME, true);
    view.setUint16(offset + 14, DOS_DATE, true);
    view.setUint32(offset + 16, item.crc, true);
    view.setUint32(offset + 20, item.bytes.length, true);
    view.setUint32(offset + 24, item.bytes.length, true);
    view.setUint16(offset + 28, item.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, offsets[i], true);
    offset += 46;
    out.set(item.nameBytes, offset);
    offset += item.nameBytes.length;
  }
  const cdSize = offset - cdStart;
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, cdSize, true);
  view.setUint32(offset + 16, cdStart, true);
  view.setUint16(offset + 20, 0, true);
  return out;
}
