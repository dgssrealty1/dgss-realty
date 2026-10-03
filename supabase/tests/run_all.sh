#!/usr/bin/env bash
# Rebuilds a throwaway local database exactly like production + the new
# migrations, then runs the RLS test matrix. Requires a local Postgres on
# socket /var/tmp/pgtest port 5433 (see report). Never touches Supabase.
set -euo pipefail
cd "$(dirname "$0")/../.."
P="psql -h /var/tmp/pgtest -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists dgss_test" -c "create database dgss_test" >/dev/null
for f in supabase/tests/00_supabase_stub.sql supabase/schema.sql supabase/add-founder-settings.sql supabase/seed-existing-properties.sql; do
  $P -d dgss_test -f "$f" 2>&1 | grep -v NOTICE || true
done
$P -d dgss_test -c "insert into auth.users(email) values ('gopi@dgssrealty.com')" >/dev/null
for f in supabase/migrations/2026*.sql; do
  $P -d dgss_test -f "$f" 2>&1 | grep -v NOTICE || true
done
python3 supabase/tests/rls_test.py dgss_test
