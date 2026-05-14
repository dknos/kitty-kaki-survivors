#!/usr/bin/env bash
# Fetch CC0 GLBs from Poly Pizza CDN for the iter-14 dungeon overhaul.
# Idempotent — re-running skips already-downloaded files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'

resolve_slug() {
  # $1 = slug, prints the GLB UUID URL
  curl -fsSL "https://poly.pizza/m/$1" -A "$UA" \
    | grep -oE 'static\.poly\.pizza/[A-Za-z0-9-]+\.glb' \
    | head -1
}

fetch_one() {
  local slug=$1 outname=$2 outdir=$3
  local out="$outdir/$outname"
  if [[ -s "$out" ]]; then
    printf "  %-32s [skip — already %sB]\n" "$outname" "$(stat -c%s "$out")"
    return 0
  fi
  local cdn
  cdn=$(resolve_slug "$slug")
  if [[ -z "$cdn" ]]; then
    echo "  $outname  [FAIL — no CDN URL for $slug]" >&2
    return 1
  fi
  curl -fsSL "https://$cdn" -A "$UA" -o "$out"
  printf "  %-32s %s  ($(stat -c%s "$out")B)\n" "$outname" "$cdn"
}

echo "[town]"
fetch_one BH2XHWUNmF fantasy_house.glb     assets/kits/town
fetch_one sDQJBImZuw town_house.glb        assets/kits/town
fetch_one x3ZcGn3jr4 fantasy_inn.glb       assets/kits/town
fetch_one xm5cViUjra tower_house.glb       assets/kits/town
fetch_one tKTchdiQzV castle_gate.glb       assets/kits/town
fetch_one wTDbVozPAj fantasy_barracks.glb  assets/kits/town

echo "[dungeon]"
fetch_one uS8wgBVxOL arch.glb              assets/kits/dungeon
fetch_one 1nt8n3rVKU pillar.glb            assets/kits/dungeon
fetch_one p8JPFIGc09 pillar_alt.glb        assets/kits/dungeon
fetch_one 8RXyLygEeF pillar_broken.glb     assets/kits/dungeon
fetch_one ySERERWPgE coffin.glb            assets/kits/dungeon
fetch_one iV5x01FYAl crypt.glb             assets/kits/dungeon
fetch_one gVLnQi8VrX bone1.glb             assets/kits/dungeon
fetch_one gVT6iydSY6 bone2.glb             assets/kits/dungeon
fetch_one 2jLwMoAb2y bone3.glb             assets/kits/dungeon

echo "[ruins]"
fetch_one KWtVNrHXVR damaged_grave.glb     assets/kits/ruins
fetch_one lrEHKjTy29 gravestone.glb        assets/kits/ruins
fetch_one ErfdU1GJSD gravestone_alt.glb    assets/kits/ruins

echo "[torches]"
fetch_one WGsvr4KOZd torch_wall.glb        assets/kits/torches
fetch_one Gq38E7hFZw torch_stand.glb       assets/kits/torches

echo
echo "[summary]"
find assets/kits -name '*.glb' | wc -l | xargs printf "  %s GLBs total\n"
du -sh assets/kits | awk '{print "  total: " $1}'
