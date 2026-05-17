export function eventToCanvas(e, canvas) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (canvas.width / r.width);
  const y = (e.clientY - r.top)  * (canvas.height / r.height);
  return [x, y];
}
