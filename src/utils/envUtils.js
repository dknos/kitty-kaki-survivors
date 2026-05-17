export function wrapAtmosParticles(pos, ix, hx, hz, R2) {
  const dx = pos[ix + 0] - hx;
  const dz = pos[ix + 2] - hz;
  if (dx * dx + dz * dz > R2) {
    pos[ix + 0] = hx - dx;
    pos[ix + 2] = hz - dz;
  }
}
