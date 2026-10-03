-- =====================================================================
-- TEST-ONLY: reproduces the privilege model observed on the LIVE project
-- (uiirwgzyuhxyerakvzzf, 2026-10-03) on top of 00_supabase_stub.sql:
--   * tables created by postgres give anon/authenticated/service_role
--     only TRUNCATE, REFERENCES, TRIGGER (no SELECT/INSERT/UPDATE/DELETE)
--   * functions created by postgres are executable by postgres only
-- Run right after 00_supabase_stub.sql. NEVER run against Supabase.
-- =====================================================================
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public grant truncate, references, trigger on tables to anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges in schema public revoke execute on functions from anon, authenticated, service_role;
alter default privileges revoke execute on functions from public;
