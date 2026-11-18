-- Price per deployment model. Nullable, so the previous release keeps writing rows without it.
ALTER TABLE "deployment_model_choices" ADD COLUMN "pricing" JSONB;
