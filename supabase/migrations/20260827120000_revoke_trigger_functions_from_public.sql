-- The earlier revoke did not work, and the advisor was right to keep flagging it.
--
-- "revoke execute ... from anon, authenticated" removes a grant those roles were
-- never separately given. Postgres grants EXECUTE on every new function to
-- PUBLIC, and anon/authenticated inherit it from there -- so revoking from the
-- named roles leaves the PUBLIC grant untouched and the function still callable
-- over /rest/v1/rpc. The functions that were already locked down
-- (touch_updated_at, place_new_lead_on_pipeline, log_lead_status_change) were
-- revoked from PUBLIC, which is why they read false while these read true.
revoke execute on function public.log_deal_status_change()   from public, anon, authenticated;
revoke execute on function public.sync_deal_milestones()     from public, anon, authenticated;
revoke execute on function public.stamp_trashed_at()         from public, anon, authenticated;
revoke execute on function public.broadcast_campaign_freeze() from public, anon, authenticated;
revoke execute on function public.broadcast_log_deal_event() from public, anon, authenticated;
revoke execute on function public.broadcast_campaign_no_delete_after_materialise()
  from public, anon, authenticated;
revoke execute on function public.enforce_deal_status_transition() from public, anon, authenticated;
