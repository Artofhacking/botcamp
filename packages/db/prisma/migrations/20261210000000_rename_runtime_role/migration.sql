-- The previous release keeps connecting as rakazo_app. This adds botcamp_app
-- beside it and grants the old role, so the new login has the same grants.
-- The owner login, the database name, and schema rakazo_private stay.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'botcamp_app') THEN
    CREATE ROLE botcamp_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN
    GRANT rakazo_app TO botcamp_app;
  END IF;
END $$;
