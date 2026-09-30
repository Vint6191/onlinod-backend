# Historical P17 rollback record — retired operator procedure

The old cleanup SQL has been removed. Do not use TRUNCATE/session flags or old
row counts to approve cleanup. Dialog/Vault ledgers are retained read-only archives.
Use the Phase 7 scoped archive reader. Physical retirement applies only to the
explicit nine-table manifest and requires verified receipts plus the guarded
contract command. See docs/PHASE7_LEGACY_STORAGE_RETIREMENT.txt.

The prior P17 source/runbook remains in the cumulative audit evidence; it is not
an executable recovery or restore procedure for the current schema.
