#!/usr/bin/env bash
# Check a live deployment serves what it is supposed to.
#
# Exists because the first production deploy looked fine on /app/ and 404'd on
# every deep route: `cleanUrls: true` turns the SPA rewrite destination
# (/app/index.html) into a 308 back to /app/, so the rewrite never served
# anything. Nothing local catches that — cleanUrls only exists on Vercel.
#
#   ./scripts/probe-deploy.sh https://tossie-buys-houses.vercel.app

set -uo pipefail
BASE="${1:-https://tossie-buys-houses.vercel.app}"
fail=0

check() {
  local label="$1" path="$2" expect="$3"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 15 "$BASE$path")
  if [ "$code" = "$expect" ]; then
    printf '  ✓ %s   %s\n' "$code" "$label"
  else
    printf '  \033[31m✗ %s (want %s)  %s\033[0m\n' "$code" "$expect" "$label"
    fail=1
  fi
}

# Deep SPA routes must serve the shell, not 404. A lead-alert email links
# straight to /app/leads/<uuid>, so this is the difference between a working
# link and a dead one.
contains() {
  local label="$1" path="$2" needle="$3"
  if curl -s -L --max-time 15 "$BASE$path" | grep -q "$needle"; then
    printf '  ✓ ok   %s\n' "$label"
  else
    printf '  \033[31m✗ MISSING  %s (expected %s)\033[0m\n' "$label" "$needle"
    fail=1
  fi
}

echo "▸ probing $BASE"

check 'marketing home'          '/'                     200
check 'a generated city page'   '/sell-my-house-fast/georgia/brunswick/' 200
check 'app shell'               '/app/'                 200
check 'app deep route: today'   '/app/today/'           200
check 'app deep route: board'   '/app/board/'           200
check 'app deep route: new'     '/app/leads/new/'       200
check 'app deep route: a lead'  '/app/leads/70551e00-0000-4000-8000-000000000099/' 200

contains 'deep route serves the SPA shell' '/app/today/' 'id="root"'
contains 'robots disallows /app'           '/robots.txt' 'Disallow: /app/'

# The website form POSTs to /api/lead. trailingSlash:true 308s that to
# /api/lead/, which a browser fetch follows with the method and body intact —
# but it is worth asserting, because a broken lead endpoint is invisible: the
# form would show its success message and the lead would be gone.
echo "▸ lead capture"
post() {
  local label="$1" body="$2" expect="$3"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 15 -X POST "$BASE/api/lead" \
         -H 'Content-Type: application/json' -d "$body")
  if [ "$code" = "$expect" ]; then
    printf '  ✓ %s   %s\n' "$code" "$label"
  else
    printf '  \033[31m✗ %s (want %s)  %s\033[0m\n' "$code" "$expect" "$label"
    fail=1
  fi
}

     # This one WRITES A ROW into the live CRM, now that SUPABASE_SERVICE_KEY is
     # set. That is the point — it is the only assertion that proves the whole
     # chain rather than just the endpoint — but it means the probe leaves a
     # lead behind, and a fake lead sitting in a real pipeline is worse than no
     # test. Marked unmistakably and cleaned up below.
post 'accepts a valid lead (writes a row)' \
     '{"address":"1 Probe St, Savannah, GA 31401","name":"ZZ Deploy Probe","phone":"9125550000","email":"deploy-probe@invalid.test"}' 200
post 'rejects a bad email' \
     '{"address":"1 Probe St","name":"X","phone":"9125550000","email":"nope"}' 400
post 'rejects a short phone' \
     '{"address":"1 Probe St","name":"X","phone":"123","email":"x@example.com"}' 400
post 'swallows a honeypot hit' \
     '{"address":"1 Probe St","name":"X","phone":"9125550000","email":"x@example.com","company":"spam"}' 200

echo "▸ headers on /app"
curl -s -D- -o /dev/null -L --max-time 15 "$BASE/app/" \
  | grep -iE 'x-robots-tag|x-frame-options|cache-control' | sed 's/^/  /'

cat <<'CLEANUP'

▸ this run left one probe lead in the live CRM — remove it with:
    DELETE FROM public.leads WHERE email = 'deploy-probe@invalid.test';
  (.test is a reserved TLD, so the address can never belong to a real seller.)
CLEANUP

[ $fail -eq 0 ] && echo "▸ deployment looks right" || echo "▸ DEPLOYMENT HAS PROBLEMS"
exit $fail
