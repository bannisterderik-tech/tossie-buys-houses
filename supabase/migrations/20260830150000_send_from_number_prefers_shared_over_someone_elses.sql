-- Fixing an ordering bug in send_from_number, found by its own test.
--
-- The first version ranked with `(n.user_id = p_user_id) DESC NULLS LAST`,
-- which reads correctly and is wrong. For somebody looking at a number that
-- belongs to a colleague the expression is FALSE; for an unassigned shared
-- number it is NULL. DESC NULLS LAST puts false ahead of null -- so a number
-- assigned to another person outranked the shared team line, and Derik would
-- have sent from the number belonging to marketing@.
--
-- Written as an explicit CASE instead. Three tiers, in the order a person would
-- say them out loud: mine, then the shared one, then somebody else's as a last
-- resort rather than a preference.
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
   ORDER BY CASE
              WHEN n.user_id = p_user_id THEN 0   -- mine
              WHEN n.user_id IS NULL     THEN 1   -- shared
              ELSE 2                              -- a colleague's; last resort
            END,
            n.is_primary DESC,
            n.created_at
   LIMIT 1;
$$;

revoke execute on function public.send_from_number(uuid, boolean) from public, anon;
grant  execute on function public.send_from_number(uuid, boolean) to authenticated, service_role;
