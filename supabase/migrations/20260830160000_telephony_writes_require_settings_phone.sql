-- A hole found by a test that was written to check something else.
--
-- phone_numbers and telephony_settings both carried a single
-- `FOR ALL USING (team_id = get_my_team_id())` policy — team scoping and
-- nothing more. Every capability check for these screens lived in the nav and
-- in the page, and as capabilities.jsx says in its own header: a hidden button
-- is not a permission. A signed-in VA holds a PostgREST token.
--
-- What that allowed, before this migration:
--
--   * repoint forward_to_e164 at their own mobile, and take the business's
--     inbound calls at home
--   * flip sms_enabled on a number the carriers have not cleared, which risks
--     the A2P campaign for everybody
--   * move is_primary, changing the number every seller sees
--   * edit telephony_settings — the team forward, the send-from number, call
--     recording
--
-- None of it was reachable through the UI, which is exactly why it survived:
-- the screen is behind settings.phone, so nobody testing by clicking would
-- ever find it.
--
-- Reading stays open to the whole team. LeadDetail, MessagesPage and
-- CampaignsPage all read these to show which number a message will come from,
-- and a VA who cannot see that gets a blank where the sending number should be.
-- Writing is settings.phone, which is admin and owner. The edge functions are
-- unaffected — they run as service_role and bypass RLS entirely.

drop policy if exists phone_numbers_team_all on public.phone_numbers;
drop policy if exists phone_numbers_read     on public.phone_numbers;
drop policy if exists phone_numbers_write    on public.phone_numbers;

create policy phone_numbers_read on public.phone_numbers for select
  using (team_id = public.get_my_team_id());
create policy phone_numbers_write on public.phone_numbers for all
  using (team_id = public.get_my_team_id() and public.has_capability('settings.phone'))
  with check (team_id = public.get_my_team_id() and public.has_capability('settings.phone'));

drop policy if exists telephony_settings_team_all on public.telephony_settings;
drop policy if exists telephony_settings_read     on public.telephony_settings;
drop policy if exists telephony_settings_write    on public.telephony_settings;

create policy telephony_settings_read on public.telephony_settings for select
  using (team_id = public.get_my_team_id());
create policy telephony_settings_write on public.telephony_settings for all
  using (team_id = public.get_my_team_id() and public.has_capability('settings.phone'))
  with check (team_id = public.get_my_team_id() and public.has_capability('settings.phone'));
