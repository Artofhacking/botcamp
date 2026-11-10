-- Additive: older releases never read or write this column.
ALTER TABLE "messages" ADD COLUMN "origin" TEXT;
