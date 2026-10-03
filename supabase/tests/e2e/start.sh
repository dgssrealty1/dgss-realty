#!/usr/bin/env bash
# TEST-ONLY: builds the e2e database and starts PostgREST + mock Supabase.
set -euo pipefail
cd "$(dirname "$0")/../../.."
P="psql -h /var/tmp/pgtest -p 5433 -U postgres -v ON_ERROR_STOP=1 -q"
pkill -f "postgrest.conf" 2>/dev/null || true
pkill -f "e2e/mock-supabase" 2>/dev/null || true
sleep 1
$P -c "drop database if exists e2e" -c "create database e2e" >/dev/null
for f in supabase/tests/00_supabase_stub.sql supabase/schema.sql supabase/add-founder-settings.sql supabase/seed-existing-properties.sql; do
  $P -d e2e -f "$f" 2>&1 | grep -v NOTICE || true
done
$P -d e2e -c "insert into auth.users(email) values ('gopi@dgssrealty.com')" >/dev/null
for f in supabase/migrations/2026*.sql; do $P -d e2e -f "$f" 2>&1 | grep -v NOTICE || true; done
$P -d e2e -f supabase/tests/e2e/seed_e2e.sql 2>&1 | grep -v NOTICE || true
$P -d e2e -f supabase/tests/e2e/seed_e2e_cms.sql 2>&1 | grep -v NOTICE || true
cat > /var/tmp/pgtest/postgrest.conf <<CONF
db-uri = "postgres://authenticator@/e2e?host=/var/tmp/pgtest&port=5433"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "local-test-secret-local-test-secret-000"
server-port = 3001
server-host = "127.0.0.1"
CONF
rm -rf /var/tmp/pgtest/storage
# real image bytes for the seeded Storage objects
while IFS='|' read -r name; do
  [ -n "$name" ] || continue
  mkdir -p "/var/tmp/pgtest/storage/property-images/$(dirname "$name")"
  cp images/properties/prop-4-ashok-nagar-800.webp "/var/tmp/pgtest/storage/property-images/$name"
done < <($P -d e2e -Atc "select name from storage.objects where bucket_id='property-images'")
nohup /tmp/claude-0/postgrest /var/tmp/pgtest/postgrest.conf > /var/tmp/pgtest/postgrest.log 2>&1 &
NO_PROXY=127.0.0.1,localhost nohup node supabase/tests/e2e/mock-supabase.mjs > /var/tmp/pgtest/mock.log 2>&1 &
sleep 2
curl -s -o /dev/null -w "postgrest %{http_code}\n" http://127.0.0.1:3001/properties?select=slug\&limit=1
curl -s -o /dev/null -w "mock %{http_code}\n" "http://127.0.0.1:54321/rest/v1/properties?select=slug&limit=1"
# Worker (keep its state outside the project: the project root is the
# assets directory, and state written there makes wrangler reload forever):
#   npx wrangler dev --port 8787 --ip 127.0.0.1 --persist-to /tmp/wrangler-state \
#     --var SUPABASE_URL:http://127.0.0.1:54321 --var SITE_ORIGIN:http://127.0.0.1:8787
# Browser QA (needs playwright-core + @supabase/supabase-js in $E2E_MODULES):
#   node supabase/tests/e2e/admin-qa.mjs
