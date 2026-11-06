-- Deployment-wide model order. The previous release does not read this table.
CREATE TABLE "deployment_model_choices" (
    "position" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "deployment_model_choices_pkey" PRIMARY KEY ("position")
);

CREATE UNIQUE INDEX "deployment_model_choices_provider_modelId_key"
    ON "deployment_model_choices"("provider", "modelId");

GRANT SELECT, INSERT, UPDATE, DELETE ON "deployment_model_choices" TO rakazo_app;
