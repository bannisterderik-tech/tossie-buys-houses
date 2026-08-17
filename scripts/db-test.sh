#!/usr/bin/env bash
# Apply every migration to a throwaway Postgres and run the test suite.
#
# No Supabase project, no network, no Docker. It spins up a local cluster in a
# temp dir, stubs the handful of `auth.*` objects the migrations reference, and
# tears everything down afterwards.
#
#   ./scripts/db-test.sh              # all suites
#   ./scripts/db-test.sh phase0       # one suite
#
# Requires a local postgres (brew install postgresql@17).

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PGTEST_PORT:-55432}"
DATA="$(mktemp -d)/pgdata"
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres

cleanup() {
  pg_ctl -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")"
}
trap cleanup EXIT

echo "▸ starting scratch postgres on :$PORT"
# LC_ALL=C: without it PG18 on macOS dies with "postmaster became multithreaded".
# -k '': the scratch dir path is longer than the 103-byte unix socket limit, so
# this cluster is TCP-only.
LC_ALL=C initdb -D "$DATA" -U postgres --auth=trust >/dev/null
LC_ALL=C pg_ctl -D "$DATA" -o "-p $PORT -k ''" -l "$DATA/../pg.log" start >/dev/null

for _ in $(seq 1 20); do pg_isready -q && break; sleep 0.3; done
pg_isready -q || { echo "postgres never came up:"; cat "$DATA/../pg.log"; exit 1; }

echo "▸ applying migrations"
psql -q -d postgres -c "CREATE DATABASE tossie" >/dev/null
psql -q -v ON_ERROR_STOP=1 -d tossie -f supabase/tests/00_auth_stub.sql >/dev/null
for f in supabase/migrations/*.sql; do
  printf '  %s\n' "$(basename "$f")"
  psql -q -v ON_ERROR_STOP=1 -d tossie -f "$f" >/dev/null
done

suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(phase0)

fail=0
for s in "${suites[@]}"; do
  echo "▸ suite: $s"
  # ON_ERROR_STOP is set inside each suite file; a failing assertion aborts it.
  if ! psql -q -v ON_ERROR_STOP=1 -d tossie -f "supabase/tests/$s.sql" 2>&1 \
       | grep -v '^GRANT$\|^SET$\|^INSERT\|^UPDATE\|^BEGIN$\|^COMMIT$\|^DO$\|^Pager'; then
    echo "  ✗ $s FAILED"
    fail=1
  fi
done

[ $fail -eq 0 ] && echo "▸ all suites passed"
exit $fail
