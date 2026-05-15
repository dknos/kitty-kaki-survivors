#!/usr/bin/env node
// Quick GLB inspector — manual GLB+JSON chunk parse.
// Usage: node tools/glb-inspect.js <file1.glb> [file2.glb ...]
const fs = require('fs');
const path = require('path');

function parseGLB(filePath) {
  const buf = fs.readFileSync(filePath);
  // GLB header: magic(4) version(4) length(4)
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'glTF') throw new Error(`Not a GLB: ${filePath} (magic=${magic})`);
  const version = buf.readUInt32LE(4);
  const totalLen = buf.readUInt32LE(8);
  // First chunk header: length(4) type(4)
  const ch0Len = buf.readUInt32LE(12);
  const ch0Type = buf.toString('ascii', 16, 20);
  if (ch0Type !== 'JSON') throw new Error(`First chunk not JSON: ${ch0Type}`);
  const jsonStr = buf.toString('utf8', 20, 20 + ch0Len);
  // Trim trailing spaces (GLB pads JSON with 0x20).
  const json = JSON.parse(jsonStr.replace(/\0+$/, '').trim());
  return { version, totalLen, json };
}

function countTris(json) {
  // Iterate over meshes -> primitives -> indices accessor count / 3.
  let totalTris = 0;
  let totalPrims = 0;
  if (!json.meshes) return { totalTris, totalPrims };
  for (const mesh of json.meshes) {
    for (const prim of (mesh.primitives || [])) {
      totalPrims++;
      // mode default = 4 (TRIANGLES). 5=TRI_STRIP, 6=TRI_FAN.
      const mode = prim.mode == null ? 4 : prim.mode;
      let count = 0;
      if (prim.indices != null) {
        count = json.accessors[prim.indices].count;
      } else if (prim.attributes && prim.attributes.POSITION != null) {
        count = json.accessors[prim.attributes.POSITION].count;
      }
      let tris = 0;
      if (mode === 4) tris = Math.floor(count / 3);
      else if (mode === 5 || mode === 6) tris = Math.max(0, count - 2);
      totalTris += tris;
    }
  }
  return { totalTris, totalPrims };
}

function inspect(filePath) {
  const { json } = parseGLB(filePath);
  const materialsArr = json.materials || [];
  const meshesArr = json.meshes || [];
  const skinsArr = json.skins || [];
  const { totalTris, totalPrims } = countTris(json);

  // Unique materials referenced by primitives (some files declare extras).
  const usedMatIdx = new Set();
  for (const m of meshesArr) for (const p of (m.primitives || [])) {
    if (p.material != null) usedMatIdx.add(p.material);
  }

  // Bones: sum joints across skins (or first skin's joints).
  let bones = 0;
  for (const s of skinsArr) bones += (s.joints || []).length;

  // Skin-shared? Check which skin index each node with mesh+skin uses.
  const skinSet = new Set();
  if (json.nodes) for (const n of json.nodes) if (n.skin != null) skinSet.add(n.skin);
  const skinShared = skinsArr.length <= 1 || skinSet.size <= 1;

  return {
    file: path.basename(filePath),
    materialsDecl: materialsArr.length,
    materialsUsed: usedMatIdx.size,
    meshes: meshesArr.length,
    primitives: totalPrims,
    tris: totalTris,
    skins: skinsArr.length,
    bones,
    skinShared,
  };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node glb-inspect.js <file.glb> ...');
  process.exit(1);
}
const rows = files.map(f => {
  try { return inspect(f); }
  catch (e) { return { file: path.basename(f), error: e.message }; }
});
console.log(JSON.stringify(rows, null, 2));
