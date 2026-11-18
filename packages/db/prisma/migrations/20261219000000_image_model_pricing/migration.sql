-- Price for the model that reads images. Nullable, so the previous release keeps working.
ALTER TABLE "deployment_settings" ADD COLUMN "imageModelPricing" JSONB;
