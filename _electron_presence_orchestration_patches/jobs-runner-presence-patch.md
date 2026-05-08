
# Electron jobs-runner patch for backend presence orchestration

Add a new job handler to `electron/main/jobs-runner.js` inside `executeJob(job, deps)` before the final `Unknown jobKey` branch:

```js
if (job.jobKey === "refresh_online_presence") {
  if (!job.creatorId) return { ok: false, error: "refresh_online_presence requires creatorId" };

  const account = readAccountManifest(job.creatorId);
  if (!account?.id) return { ok: false, error: "Account manifest not found" };

  const getOnlineUsersSnapshotPayload = deps.getOnlineUsersSnapshotPayload;
  if (typeof getOnlineUsersSnapshotPayload !== "function") {
    return { ok: false, error: "getOnlineUsersSnapshotPayload dependency is missing" };
  }

  const payload = await getOnlineUsersSnapshotPayload(account, {
    reason: job.params?.reason || "scheduled_presence_refresh",
    jobId: job.id,
  });

  if (!payload?.ok) return { ok: false, error: payload?.error || payload?.code || "online users refresh failed" };

  return {
    ok: true,
    summary: {
      users: Array.isArray(payload.users) ? payload.users : [],
      capturedAt: payload.capturedAt || new Date().toISOString(),
      pages: payload.pages || 0,
      reason: job.params?.reason || "scheduled_presence_refresh",
      onlineCount: Array.isArray(payload.users) ? payload.users.length : 0,
    },
  };
}
```

Then pass `getOnlineUsersSnapshotPayload` when calling `startJobsRunner(...)`.

That function should use the existing BrowserApiRunner and the same endpoint:

`ENDPOINTS.subscribers.online({ limit, offset, format:"infinite", type:"active", more:true })`

Return shape:

```js
{ ok: true, users, pages, capturedAt }
```

The backend will receive this through `/api/jobs/:id/report` and persist it as the centralized presence snapshot.
```
