-- Extend analytics ingest/coverage kinds in a dedicated migration.
-- PostgreSQL enum additions are intentionally committed before later migrations
-- use the new enum values.
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'SALES';
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'PAID_SUBSCRIPTIONS';
