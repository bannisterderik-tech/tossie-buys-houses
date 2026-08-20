-- Split the FOR ALL policies into per-command ones so a capability can sit on
-- each verb. Same team check on every one -- capabilities narrow access within
-- a team, they never widen it across teams. Edge functions are unaffected: they
-- run on the service role, which bypasses RLS entirely.
drop policy if exists leads_team_all on public.leads;
create policy leads_select on public.leads for select
  using (team_id = public.get_my_team_id() and public.has_capability('leads.view'));
create policy leads_insert on public.leads for insert
  with check (team_id = public.get_my_team_id() and public.has_capability('leads.edit'));
create policy leads_update on public.leads for update
  using (team_id = public.get_my_team_id() and public.has_capability('leads.edit'))
  with check (team_id = public.get_my_team_id());
create policy leads_delete on public.leads for delete
  using (team_id = public.get_my_team_id() and public.has_capability('leads.delete'));

drop policy if exists buyers_team_all on public.buyers;
create policy buyers_select on public.buyers for select
  using (team_id = public.get_my_team_id() and public.has_capability('buyers.view'));
create policy buyers_insert on public.buyers for insert
  with check (team_id = public.get_my_team_id() and public.has_capability('buyers.edit'));
create policy buyers_update on public.buyers for update
  using (team_id = public.get_my_team_id() and public.has_capability('buyers.edit'))
  with check (team_id = public.get_my_team_id());
create policy buyers_delete on public.buyers for delete
  using (team_id = public.get_my_team_id() and public.has_capability('buyers.delete'));

drop policy if exists deals_team_all on public.deals;
create policy deals_select on public.deals for select
  using (team_id = public.get_my_team_id() and public.has_capability('deals.view'));
create policy deals_insert on public.deals for insert
  with check (team_id = public.get_my_team_id() and public.has_capability('deals.edit'));
create policy deals_update on public.deals for update
  using (team_id = public.get_my_team_id() and public.has_capability('deals.edit'))
  with check (team_id = public.get_my_team_id());
create policy deals_delete on public.deals for delete
  using (team_id = public.get_my_team_id() and public.has_capability('deals.delete'));

drop policy if exists prospects_team_all on public.prospects;
create policy prospects_select on public.prospects for select
  using (team_id = public.get_my_team_id() and public.has_capability('prospects.view'));
create policy prospects_insert on public.prospects for insert
  with check (team_id = public.get_my_team_id() and public.has_capability('prospects.edit'));
create policy prospects_update on public.prospects for update
  using (team_id = public.get_my_team_id() and public.has_capability('prospects.edit'))
  with check (team_id = public.get_my_team_id());
create policy prospects_delete on public.prospects for delete
  using (team_id = public.get_my_team_id() and public.has_capability('prospects.delete'));

-- Creating the row is the act that matters: materialise and send both require
-- one, so gating INSERT on campaigns.send is what actually stops a VA blasting
-- the buyers list, with or without the button.
drop policy if exists broadcast_campaigns_team_all on public.broadcast_campaigns;
create policy broadcast_campaigns_select on public.broadcast_campaigns for select
  using (team_id = public.get_my_team_id() and public.has_capability('campaigns.view'));
create policy broadcast_campaigns_insert on public.broadcast_campaigns for insert
  with check (team_id = public.get_my_team_id() and public.has_capability('campaigns.send'));
create policy broadcast_campaigns_update on public.broadcast_campaigns for update
  using (team_id = public.get_my_team_id() and public.has_capability('campaigns.send'))
  with check (team_id = public.get_my_team_id());
create policy broadcast_campaigns_delete on public.broadcast_campaigns for delete
  using (team_id = public.get_my_team_id() and public.has_capability('campaigns.send'));

drop policy if exists team_members_team_all on public.team_members;
drop policy if exists team_members_read     on public.team_members;
drop policy if exists team_members_manage   on public.team_members;
create policy team_members_read on public.team_members for select
  using (team_id = public.get_my_team_id());
create policy team_members_manage on public.team_members for all
  using (team_id = public.get_my_team_id() and public.has_capability('team.manage'))
  with check (team_id = public.get_my_team_id() and public.has_capability('team.manage'));
