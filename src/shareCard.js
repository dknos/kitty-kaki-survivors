/**
 * Share card — iter 9. 1200×630 Open Graph PNG of a run summary.
 * Pure 2D canvas, no deps. Uses `canvas.toBlob` (async) — never `toDataURL`,
 * which would 200kb+ a main-thread string at this size.
 *
 * Input shape: src/runHistory.js recordRunResult entry.
 * `charSummary` (optional): { icon, name } for emoji + display name.
 */
const W = 1200, H = 630;
const C = {
  amber: '#ffd24a', cyan: '#7fffe4', magenta: '#c87bff',
  text: '#f5efe1', body: 'rgba(245,239,225,0.78)', edge: 'rgba(255,255,255,0.10)',
  bg0: '#0a0e10', bg1: '#14181a',
};

function _fmtTime(s) {
  const t = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

function _fonts() {
  const ok = (q) => typeof document !== 'undefined' && document.fonts && document.fonts.check && document.fonts.check(q);
  return {
    display: ok('700 16px "Cinzel Decorative"') ? '"Cinzel Decorative", Georgia, serif' : 'Georgia, serif',
    body:    ok('400 14px "Inter"')             ? '"Inter", system-ui, sans-serif'      : 'system-ui, sans-serif',
  };
}

export function renderShareCard(runEntry, charSummary) {
  const e = runEntry || {};
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const F = _fonts();

  // Background gradient + corner glow
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, C.bg0); bg.addColorStop(1, C.bg1);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.85, H * 0.15, 20, W * 0.85, H * 0.15, 520);
  glow.addColorStop(0, 'rgba(255,210,74,0.18)'); glow.addColorStop(1, 'rgba(255,210,74,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Title bar
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillStyle = C.amber; ctx.font = `900 38px ${F.display}`;
  ctx.fillText('KITTY KAKI SURVIVORS', 56, 48);
  const isVictory = e.outcome === 'victory';
  ctx.fillStyle = isVictory ? C.amber : '#ff7a7a'; ctx.font = `700 18px ${F.body}`;
  ctx.fillText(isVictory ? '★ VICTORY' : '† DEFEAT', 56, 100);
  ctx.strokeStyle = C.edge; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(56, 138); ctx.lineTo(W - 56, 138); ctx.stroke();

  // Character avatar — top-right
  const icon = (charSummary && charSummary.icon) || '🐾';
  const name = (charSummary && charSummary.name) || e.character || '?';
  ctx.textAlign = 'right';
  ctx.font = `96px ${F.body}`; ctx.fillStyle = C.text; ctx.fillText(icon, W - 56, 32);
  ctx.font = `700 22px ${F.display}`; ctx.fillStyle = C.cyan; ctx.fillText(String(name).toUpperCase(), W - 56, 138);

  // Stat grid 2×2
  ctx.textAlign = 'left';
  const stats = [
    ['KILLS', String(e.kills || 0),                    C.amber],
    ['TIME',  _fmtTime(e.durationSec),                 C.cyan],
    ['LEVEL', String(e.level || 0),                    C.magenta],
    ['DMG',   (e.dmgDealt || 0).toLocaleString(),      C.amber],
  ];
  stats.forEach(([label, value, color], i) => {
    const x = 56 + (i % 2) * 280, y = 180 + Math.floor(i / 2) * 130;
    ctx.fillStyle = C.body; ctx.font = `700 14px ${F.body}`; ctx.fillText(label, x, y);
    ctx.fillStyle = color;  ctx.font = `900 64px ${F.display}`; ctx.fillText(value, x, y + 22);
  });

  // Top 3 weapons w/ mini-bars
  const top3 = (Array.isArray(e.weaponsUsed) ? e.weaponsUsed : [])
    .slice().sort((a, b) => (b.level || 0) - (a.level || 0)).slice(0, 3);
  ctx.fillStyle = C.body; ctx.font = `700 14px ${F.body}`; ctx.fillText('LOADOUT', 640, 176);
  top3.forEach((w, i) => {
    const y = 200 + i * 60;
    const lvl = Math.min(8, w.level || 1), fill = Math.max(0.08, lvl / 8);
    ctx.fillStyle = C.text; ctx.font = `600 16px ${F.body}`;
    ctx.fillText(`${String(w.id || '?').toUpperCase()}${w.evolved ? '  ★' : ''}  ·  Lv ${lvl}`, 640, y);
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(640, y + 20, 480, 24);
    const g = ctx.createLinearGradient(640, 0, 640 + 480 * fill, 0);
    g.addColorStop(0, w.evolved ? C.amber : C.cyan); g.addColorStop(1, w.evolved ? '#ff7a3a' : C.magenta);
    ctx.fillStyle = g; ctx.fillRect(640, y + 20, 480 * fill, 24);
  });
  if (top3.length === 0) {
    ctx.fillStyle = C.body; ctx.font = `italic 16px ${F.body}`;
    ctx.fillText('— no weapons recorded —', 640, 212);
  }

  // Footer — seed (right) + stage/mode tag (left)
  ctx.fillStyle = C.body; ctx.font = `600 16px ${F.body}`;
  ctx.textAlign = 'right'; ctx.fillText(e.seed || '', W - 56, H - 52);
  ctx.textAlign = 'left';  ctx.font = `700 12px ${F.body}`;
  ctx.fillText(`${String(e.stage || 'forest').toUpperCase()}  ·  ${String(e.mode || 'normal').toUpperCase()}`, 56, H - 52);

  return canvas;
}

export function downloadShareCard(runEntry, charSummary) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = renderShareCard(runEntry, charSummary);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('toBlob produced null')); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kk-survivors-${(runEntry && runEntry.seed) || 'run'}-${Date.now()}.png`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        resolve();
      }, 'image/png');
    } catch (err) { reject(err); }
  });
}
