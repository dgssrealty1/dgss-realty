#!/usr/bin/env bash
# Same as run_all.sh, but with the LIVE project's privilege model
# (01_live_privileges.sql + 02_live_table_grants.sql). Optional extra
# migration files can be passed as arguments (applied after 2026*.sql).
set -uo pipefail
cd "$(dirname "$0")/../.."
P="psql -h /var/tmp/pgtest -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists dgss_live_model" -c "create database dgss_live_model" >/dev/null
for f in supabase/tests/00_supabase_stub.sql supabase/tests/01_live_privileges.sql supabase/schema.sql supabase/tests/02_live_table_grants.sql supabase/add-founder-settings.sql supabase/seed-existing-properties.sql; do
  $P -d dgss_live_model -f "$f" 2>&1 | grep -v NOTICE || true
done
$P -d dgss_live_model -c "insert into auth.users(email) values ('gopi@dgssrealty.com')" >/dev/null
for f in supabase/migrations/2026*.sql "$@"; do
  echo "== applying $f"; $P -d dgss_live_model -f "$f" 2>&1 | grep -v NOTICE || true
done
LIVE_MODEL=1 python3 supabase/tests/rls_test.py dgss_live_model
