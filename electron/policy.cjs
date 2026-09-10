function safeURL(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function safeBounds(b, size) {
  if (!b || !["x", "y", "width", "height"].every((k) => Number.isFinite(b[k])))
    return null;
  const x = Math.max(0, Math.round(b.x)),
    y = Math.max(0, Math.round(b.y));
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(b.width), size[0] - x)),
    height: Math.max(0, Math.min(Math.round(b.height), size[1] - y)),
  };
}
module.exports = { safeURL, safeBounds };
