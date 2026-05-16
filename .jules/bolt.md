## 2024-05-13 - Fast SpatialHash Keys
**Learning:** In highly queried code paths (like spatial hash key generation called multiple times per enemy frame), string concatenation `cx + '_' + cz` can lead to GC pauses and slower Map lookups than using integers. Packing grid coordinates into integers avoids these issues entirely.
**Action:** For 2D grid lookups, pack coordinates using bitwise operations (e.g. `((cx & 0xFFFF) << 16) | (cz & 0xFFFF)`) instead of strings whenever possible to improve hot-loop performance and prevent allocation in game loops.
