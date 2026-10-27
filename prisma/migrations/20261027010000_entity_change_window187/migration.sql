-- Wake old 30-day delivery windows once. No canonical fact, current entity or
-- journal row is removed by deployment. The runtime drains bounded prefixes.
UPDATE "public"."CreatorEntityChangeHead"
SET "nextRetentionAt" = clock_timestamp()
WHERE "retainedFrom" <= "lastRevision";
