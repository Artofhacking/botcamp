-- The previous release calls app_rls_bypass() and does not name this schema on the
-- request path. Rename it and point that function at the new name in one step.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'rakazo_private') THEN
    ALTER SCHEMA rakazo_private RENAME TO botcamp_private;
  END IF;
END $$;

DO $$
DECLARE
  fn record;
  body text;
BEGIN
  FOR fn IN
    SELECT p.oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND pg_get_functiondef(p.oid) LIKE '%rakazo_private%'
  LOOP
    body := replace(pg_get_functiondef(fn.oid), 'rakazo_private', 'botcamp_private');
    EXECUTE body;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app_rls_bypass() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
    SELECT coalesce(current_setting('app.rls_bypass', true) = 'on', false) AND (
      NOT EXISTS (SELECT 1 FROM botcamp_private.rls_bypass_keys)
      OR EXISTS (
        SELECT 1 FROM botcamp_private.rls_bypass_keys
        WHERE digest = sha256(convert_to(coalesce(current_setting('app.rls_bypass_key', true), ''), 'UTF8'))
      )
    )
  $$;
