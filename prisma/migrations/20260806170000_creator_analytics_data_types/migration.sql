-- Creator Analytics relational data-type expansion.
-- Kept in its own migration so PostgreSQL commits enum values before later
-- migrations use them in constraints and rows.
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_LIKES';
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_COMMENTS';
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'CAMPAIGNS';
ALTER TYPE "AnalyticsDataType" ADD VALUE IF NOT EXISTS 'MESSAGES_DAILY';
