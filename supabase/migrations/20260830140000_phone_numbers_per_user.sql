-- Whose number is this.
--
-- Five numbers, one team, and no way to say that the (912) 207-7192 belongs to
-- Al in acquisitions. Everything sends from the single team primary, so a
-- seller Al has spoken to four times gets a text from a number they have never
-- seen, and Al's callbacks ring a phone nobody is holding.
--
-- Assignment, not ownership: a number is still the team's, still billed to the
-- team, still released by the owner. user_id only answers "who works this
-- number", which decides two things -- what an operator sends from by default,
-- and whose phone an unanswered call should reach.
--
-- Null stays meaningful and stays the default. A shared number that anyone may
-- send from is the ordinary case for a marketing line, and making every number
-- belong to somebody would be worse than the problem being fixed.
alter table public.phone_numbers
  add column if not exists user_id uuid references public.profiles(id) on delete set null;

create index if not exists phone_numbers_user_idx
  on public.phone_numbers (team_id, user_id) where user_id is not null;

comment on column public.phone_numbers.user_id is
  'Who works this number. Null means shared. Decides the default send-from number and, with forward_to_e164, whose phone an unanswered call reaches.';

/**
 * The number a given person should send from.
 *
 * Order is the whole point:
 *
 *   1. Their own assigned number, if it can do the job. A seller answering a
 *      callback should see the number that called them.
 *   2. The team primary.
 *   3. Any live number at all, so a team that has never set a primary is not
 *      simply unable to send.
 *
 * p_needs_sms because the two channels have different rules -- a number can be
 * voice-ready while its A2P registration is still pending, and picking it for a
 * text produces a carrier filter rather than an error anybody sees. Released
 * numbers are excluded on both paths: the send functions already refuse them,
 * so returning one would just move the failure somewhere less legible.
 */
create or replace function public.send_from_number(
  p_user_id   uuid,
  p_needs_sms boolean default false
) returns public.phone_numbers
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  SELECT n.* FROM public.phone_numbers n
   WHERE n.team_id = (SELECT team_id FROM public.profiles WHERE id = p_user_id)
     AND n.released_at IS NULL
     AND (NOT p_needs_sms OR (n.sms_enabled AND n.a2p_status = 'approved'))
     AND (p_needs_sms OR n.voice_enabled)
   ORDER BY (n.user_id = p_user_id) DESC NULLS LAST,
            n.is_primary DESC,
            n.created_at
   LIMIT 1;
$$;

revoke execute on function public.send_from_number(uuid, boolean) from public, anon;
grant  execute on function public.send_from_number(uuid, boolean) to authenticated, service_role;
