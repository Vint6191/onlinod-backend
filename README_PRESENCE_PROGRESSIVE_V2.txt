# Presence Progressive v2

Backend changes:
- stale/missing snapshots return `users: []` and `freshness.state = stale|missing`; old online lists are not shown as current truth.
- `POST /api/presence/creators/:creatorId/snapshot` now supports progressive refresh:
  - `mode: append`, `done:false` for every API page
  - `mode: complete`, `done:true` when job finishes
- progressive pages update snapshot status to `REFRESHING`, so clients can display fresh partial data immediately.
- complete marks users absent from the new refresh as offline.
