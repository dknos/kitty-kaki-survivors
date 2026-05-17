export function hexLerp(a, b, k) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * k) << 16) |
          (Math.round(ag + (bg - ag) * k) << 8)  |
           Math.round(ab + (bb - ab) * k)) >>> 0;
}
