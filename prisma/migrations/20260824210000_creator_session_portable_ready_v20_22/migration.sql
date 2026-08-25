-- V20.22: canonical session portability is explicit and fail-closed.
ALTER TABLE "CreatorSessionState" ADD COLUMN "portableReady" BOOLEAN NOT NULL DEFAULT false;
