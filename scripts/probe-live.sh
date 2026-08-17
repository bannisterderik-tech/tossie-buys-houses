#!/usr/bin/env bash
# Probe a live Supabase project with the PUBLIC anon key and assert it cannot
# reach seller data.
#
# The anon key ships inside the browser bundle at /app, so anyone who opens dev
# tools has it. This script asks the question an attacker would ask, against the
# real REST API rather than against SQL privileges — the two can disagree, since
# PostgREST caches its schema and applies its own layer on top.
#
#   SUPABASE_URL=https://<ref>.supabase.co \
#   SUPABASE_ANON_KEY=<anon key> \
#   ./scripts/probe-live.sh
#
# Every check must DENY. A single ALLOW is a leak of seller PII.

set -uo pipefail

: "${SUPABASE_URL:?set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?set SUPABASE_ANON_KEY}"

TEAM='70551e00-0000-4000-8000-000000000001'
fail=0

# Anything other than 2xx is a denial, which is what we want everywhere here.
probe() {
  local label="$1" method="$2" path="$3" body="${4:-}"
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method"
              -H "apikey: $SUPABASE_ANON_KEY"
              -H "Authorization: Bearer $SUPABASE_ANON_KEY")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")

  local code
  code=$(curl "${args[@]}" "$SUPABASE_URL$path")

  if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then
    printf '  \033[31m✗ ALLOWED (%s)\033[0m  %s\n' "$code" "$label"
    fail=1
  else
    printf '  ✓ denied (%s)   %s\n' "$code" "$label"
  fi
}

echo "▸ probing $SUPABASE_URL with the public anon key"

probe 'read leads'                GET  '/rest/v1/leads?select=*'
probe 'read seller phone numbers' GET  '/rest/v1/leads?select=name,phone,email'
probe 'read profiles'             GET  '/rest/v1/profiles?select=email'
probe 'read teams'                GET  '/rest/v1/teams?select=*'
probe 'read lead notes'           GET  '/rest/v1/lead_notes?select=body'
probe 'read the activity log'     GET  '/rest/v1/lead_activity?select=*'
probe 'inject a lead'             POST '/rest/v1/leads' \
      "{\"team_id\":\"$TEAM\",\"name\":\"probe\",\"phone\":\"9125550000\"}"
probe 'call the signup trigger'   POST '/rest/v1/rpc/handle_new_user' '{}'
probe 'call the pipeline trigger' POST '/rest/v1/rpc/place_new_lead_on_pipeline' '{}'

if [ $fail -eq 0 ]; then
  echo "▸ all probes denied"
else
  echo "▸ SOMETHING IS EXPOSED — fix before this goes anywhere near real leads"
fi
exit $fail
