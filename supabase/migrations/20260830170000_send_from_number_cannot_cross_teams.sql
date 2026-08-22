-- Closing a cross-tenant leak I introduced two migrations ago.
--
-- send_from_number is SECURITY DEFINER and took the user as a parameter, then
-- resolved the team FROM THAT PARAMETER:
--
--   WHERE n.team_id = (SELECT team_id FROM profiles WHERE id = p_user_id)
--
-- So any signed-in person could call it over /rest/v1/rpc with a uuid
-- belonging to somebody in another account and be handed that account's phone
-- number, friendly name, Twilio SID and A2P state. RLS never entered into it —
-- SECURITY DEFINER is precisely the thing that skips RLS, which is why a
-- DEFINER function must do its own scoping and this one did not.
--
-- The team now comes from the caller, never from the argument, and a request
-- about somebody outside the caller's team returns nothing at all. The
-- parameter stays because the answer is genuinely per-person -- an admin
-- setting up a colleague's line needs to see what that colleague would send
-- from -- it just can no longer point outside the account.
--
-- service_role keeps unrestricted use: the edge functions have no auth.uid()
-- and legitimately resolve a send-from number on behalf of any user.
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
   WHERE n.team_id = (SELECT p.team_id FROM public.profiles p WHERE p.id = p_user_id)
     -- The caller's own team, or nothing. auth.uid() is null for service_role,
     -- so the edge functions fall through this check unchanged.
     AND (
       auth.uid() IS NULL
       OR n.team_id = public.get_my_team_id()
     )
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

comment on function public.send_from_number(uuid, boolean) is
  'The number a person should send from: their own, then the shared primary, then a colleague''s. Scoped to the caller''s team — a uuid from another account returns nothing.';
