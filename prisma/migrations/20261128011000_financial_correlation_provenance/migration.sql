BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "CreatorSale" ADD COLUMN "financialCorrelation" JSONB,
 ADD CONSTRAINT "CreatorSale_correlation208_check" CHECK("financialCorrelation" IS NULL OR
   COALESCE((jsonb_typeof("financialCorrelation")='object' AND "financialCorrelation"->>'version'='1'
    AND "financialCorrelation"->>'kind' IN ('EXACT','NEIGHBORHOOD','LEGACY_NEIGHBORHOOD')
    AND "financialCorrelation"->>'state' IN ('UNIQUE','AMBIGUOUS','EXACT')),false));
ALTER TABLE "CreatorTip" ADD COLUMN "financialCorrelation" JSONB,
 ADD CONSTRAINT "CreatorTip_correlation208_check" CHECK("financialCorrelation" IS NULL OR
   COALESCE((jsonb_typeof("financialCorrelation")='object' AND "financialCorrelation"->>'version'='1'
    AND "financialCorrelation"->>'kind' IN ('EXACT','NEIGHBORHOOD','LEGACY_NEIGHBORHOOD')
    AND "financialCorrelation"->>'state' IN ('UNIQUE','AMBIGUOUS','EXACT')),false));
COMMIT;
