## 2024-05-17 - Blob Shadow Culling
**Learning:** The blob shadow InstancedMesh `updateBlobShadows` in `src/blobShadows.js` iterated over all active enemies regardless of distance, doing matrix math for off-screen enemies.
**Action:** Always check if `InstancedMesh` updates can be distance-culled. I added a 24u distance threshold (squared distance) to the hero before updating the matrix. Ensure that fallback positions (`e.pos` instead of `e.mesh.position`) are used correctly when testing culling conditions.
