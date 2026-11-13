-- Additive: the previous release ignores user_device_connections.relay (default false).

ALTER TABLE "user_device_connections" ADD COLUMN "relay" BOOLEAN NOT NULL DEFAULT false;
