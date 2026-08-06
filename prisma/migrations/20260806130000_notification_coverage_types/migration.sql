-- Notification subtype coverage values are committed in their own migration.
-- PostgreSQL enum additions must be visible before later migrations use them.

ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_PURCHASES';
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_TIPS';
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_SUBSCRIPTIONS';
