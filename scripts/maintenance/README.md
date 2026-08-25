# Backend maintenance scripts

These scripts are **manual operator tools**, not part of normal server startup.
Both default to dry-run and require `--apply` for destructive changes.

Run from the backend repository root:

```bash
node scripts/maintenance/dedupe-deliveries.js
node scripts/maintenance/dedupe-deliveries.js --apply

node scripts/maintenance/purge-stuck-deliveries.js
node scripts/maintenance/purge-stuck-deliveries.js --days=7 --apply
```

`purge-stuck-deliveries.js --all --apply` intentionally ignores the age threshold. Use it only when you have reviewed the dry-run output.
