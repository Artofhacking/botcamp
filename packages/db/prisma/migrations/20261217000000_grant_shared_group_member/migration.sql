-- The shared-group policy helpers run SECURITY DEFINER, so the runtime login
-- must be allowed to call them. 20261213000000 granted that to rakazo_app only;
-- a BotCamp database that never had rakazo_app (the role the rename migration
-- grants when the older login exists) left botcamp_app without EXECUTE, and
-- every bot, group, and shared-thread query failed once RLS was enforced.
GRANT EXECUTE ON FUNCTION app_shared_group_member(text) TO botcamp_app;
