-- A page the seller fills in themselves.
--
-- The SDR can ask five questions over five texts and lose somebody on the
-- third. A link asks all of them at once, on a screen, where the answers can be
-- typed properly and photos can be attached — and the photos are the part no
-- text thread will ever get you.
--
-- A ROW PER LINK, not a column on leads. A token needs to be revocable without
-- touching the lead, reissuable when somebody loses the text, and auditable
-- afterwards: who opened it, when, and whether they finished. A column can do
-- none of that, and "when did this seller give us these answers" is a question
-- that gets asked later.
create table if not exists public.lead_portals (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references public.teams(id) on delete cascade,
  lead_id      uuid not null references public.leads(id) on delete cascade,

  -- What travels in the URL. Not a uuid: a seller reads this off a text
  -- message on a phone, and 32 hex characters is already long enough that it
  -- cannot be guessed. gen_random_bytes is a CSPRNG, so this is 128 bits.
  token        text not null unique,

  -- Everything the seller typed, as posted. Kept whole rather than only merged
  -- onto the lead, because the lead's fields get edited afterwards and this is
  -- the record of what they actually said.
  answers      jsonb not null default '{}'::jsonb,

  created_at   timestamptz not null default now(),
  -- Links do not live forever. Ninety days is longer than any deal this
  -- business runs and short enough that an old text is not a standing door.
  expires_at   timestamptz not null default now() + interval '90 days',
  revoked_at   timestamptz,
  first_opened_at timestamptz,
  submitted_at    timestamptz,
  photo_count  integer not null default 0
);

create index if not exists lead_portals_lead_idx on public.lead_portals (lead_id, created_at desc);

alter table public.lead_portals enable row level security;

-- Operators see their team's links. The seller never touches this table
-- directly — every public read and write goes through the API route holding
-- the service key, so `anon` has no grant here at all and no RLS policy to
-- probe. A public token check that lives in a policy is a policy somebody has
-- to get exactly right; a table anon cannot see is one they cannot.
drop policy if exists lead_portals_team on public.lead_portals;
create policy lead_portals_team on public.lead_portals
  for all to authenticated
  using (team_id = public.get_my_team_id() and public.has_capability('leads.view'))
  with check (team_id = public.get_my_team_id() and public.has_capability('leads.edit'));

revoke all on public.lead_portals from public, anon;
grant select, insert, update on public.lead_portals to authenticated;
grant all on public.lead_portals to service_role;

/**
 * The live link for a lead, making one if there is not a usable one already.
 *
 * Reuses rather than reissues: a seller who was sent a link on Tuesday and is
 * sent it again on Thursday should land on the same half-finished form, not a
 * blank one. A new token is minted only when the old one has expired or been
 * revoked.
 */
create or replace function public.lead_portal_token(p_lead_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions', 'pg_catalog'
as $$
DECLARE
  v_team  uuid;
  v_token text;
BEGIN
  SELECT team_id INTO v_team FROM public.leads WHERE id = p_lead_id;
  IF v_team IS NULL THEN
    RAISE EXCEPTION 'No such lead' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT token INTO v_token
    FROM public.lead_portals
   WHERE lead_id = p_lead_id
     AND revoked_at IS NULL
     AND expires_at > now()
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_token IS NOT NULL THEN RETURN v_token; END IF;

  v_token := encode(gen_random_bytes(16), 'hex');
  INSERT INTO public.lead_portals (team_id, lead_id, token)
  VALUES (v_team, p_lead_id, v_token);

  RETURN v_token;
END;
$$;

revoke execute on function public.lead_portal_token(uuid) from public, anon;
grant execute on function public.lead_portal_token(uuid) to authenticated, service_role;

/**
 * Merge what the seller typed onto the lead.
 *
 * The seller's answers WIN here, unlike the vendor enrichment, and the reason
 * is whose information it is. A vendor's payload is a claim about somebody; an
 * answer typed into this form is the owner of the house telling us directly.
 * If those two disagree, the person who lives there is right.
 *
 * Except on the two columns that are ours rather than theirs: consent and
 * anything the operator has recorded on the compliance card. Those are not
 * theirs to overwrite through a public form.
 */
create or replace function public.apply_portal_answers(p_portal_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
DECLARE
  p public.lead_portals;
  a jsonb;
  v text;
BEGIN
  SELECT * INTO p FROM public.lead_portals WHERE id = p_portal_id;
  IF NOT FOUND THEN RETURN; END IF;
  a := coalesce(p.answers, '{}'::jsonb);

  UPDATE public.leads SET
    asking_price    = coalesce((nullif(regexp_replace(coalesce(a->>'asking_price',''), '[^0-9]', '', 'g'), ''))::int, asking_price),
    mortgage_balance= coalesce((nullif(regexp_replace(coalesce(a->>'mortgage_balance',''), '[^0-9]', '', 'g'), ''))::int, mortgage_balance),
    timeline        = coalesce(nullif(btrim(a->>'timeline'), ''), timeline),
    motivation      = coalesce(nullif(btrim(a->>'motivation'), ''), motivation),
    condition_notes = coalesce(nullif(btrim(a->>'condition_notes'), ''), condition_notes),
    repairs_needed  = coalesce(nullif(btrim(a->>'repairs_needed'), ''), repairs_needed),
    occupancy       = coalesce(public.normalise_occupancy(a->>'occupancy'), occupancy),
    beds            = coalesce((nullif(regexp_replace(coalesce(a->>'beds',''), '[^0-9.]', '', 'g'), ''))::numeric, beds),
    baths           = coalesce((nullif(regexp_replace(coalesce(a->>'baths',''), '[^0-9.]', '', 'g'), ''))::numeric, baths),
    already_listed  = coalesce((a->>'already_listed')::boolean, already_listed),
    -- Somebody who filled in a form about their own house is not cold.
    temperature     = CASE WHEN temperature IN ('cold','dead') THEN 'warm' ELSE temperature END,
    updated_at      = now()
  WHERE id = p.lead_id;

  v := nullif(btrim(coalesce(a->>'anything_else', '')), '');

  INSERT INTO public.lead_activity (team_id, lead_id, actor_kind, type, summary, payload)
  VALUES (p.team_id, p.lead_id, 'system', 'portal_submitted',
          'Seller filled in the property form themselves'
            || CASE WHEN p.photo_count > 0
                    THEN ' and added ' || p.photo_count || ' photo' || CASE WHEN p.photo_count = 1 THEN '' ELSE 's' END
                    ELSE '' END,
          jsonb_build_object('portal_id', p.id, 'answers', a));

  IF v IS NOT NULL THEN
    INSERT INTO public.lead_notes (team_id, lead_id, body, author_id)
    VALUES (p.team_id, p.lead_id, 'From the seller''s own form: ' || v, NULL);
  END IF;
END;
$$;

revoke execute on function public.apply_portal_answers(uuid) from public, anon, authenticated;
grant execute on function public.apply_portal_answers(uuid) to service_role;

comment on table public.lead_portals is
  'One tokenised link per lead. The seller answers questions and adds photos; nothing public touches this table directly.';
