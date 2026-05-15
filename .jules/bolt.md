## 2024-05-15 - Blob Shadow InstancedMesh Distance Culling
**Learning:** Off-screen meshes need explicit culling in the InstancedMesh shadow pass to avoid unnecessary matrix computation and updates. `PERF.md` explicitly noted the O(n) walk of active enemies as a soft spot for `updateBlobShadows`.
**Action:** When updating large arrays of objects for InstancedMesh rendering, use a distance gate (e.g., 24u) relative to the hero to filter out non-visible instances before calculating transformations.
