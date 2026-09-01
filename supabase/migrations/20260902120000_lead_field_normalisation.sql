-- Every field a vendor sends, in a column somebody can work.
--
-- leads has about seventy-five columns. ingest_lead_from_source filled
-- fourteen. Everything else a vendor posted — beds, baths, asking price,
-- timeline, occupancy, mortgage balance, whether it is already listed — landed
-- in raw_payload and was invisible to every screen, every filter and every
-- buyer match. Not lost, which is why raw_payload exists, but not usable
-- either, and a field nobody can filter on may as well not have arrived.
--
-- THE ALIAS TABLE MOVES INTO THE DATABASE. It was a constant in the edge
-- function, which meant every new vendor spelling — "f name", "First_Name",
-- "sellerFirstName" — cost a function deploy. It is a row now. Adding a
-- spelling is an INSERT, and it takes effect on the next lead.
--
-- ingest_lead_from_source already receives the untouched payload as p_raw, so
-- it can resolve anything the edge function did not. The function's own map
-- stays as the fast path for the common fields; this is the long tail.
create table if not exists public.lead_field_aliases (
  -- The leads column this spelling means.
  column_name text not null,
  -- The vendor's spelling, already normalised: lowercase, letters and digits
  -- only. "First Name", "first_name" and "firstName" are all 'firstname'.
  alias       text not null,
  -- Lower wins when a payload carries two spellings of the same thing. A
  -- vendor sending `phone` and `mobile` means the mobile is the extra.
  priority    int  not null default 100,
  primary key (column_name, alias)
);

comment on table public.lead_field_aliases is
  'Vendor field spellings mapped onto leads columns. Add a row to teach the importer a new name — no deploy.';

alter table public.lead_field_aliases enable row level security;

-- Global, not per team: these are spellings of English words, not anybody's
-- data. Readable by any signed-in operator so the Import screen can show what
-- is understood; writable by nobody through the API, because a bad row here
-- would silently misfile a field on every future lead.
drop policy if exists lead_field_aliases_read on public.lead_field_aliases;
create policy lead_field_aliases_read on public.lead_field_aliases
  for select to authenticated using (true);

revoke all on public.lead_field_aliases from public, anon;
grant select on public.lead_field_aliases to authenticated, service_role;

/** 'First Name' -> 'firstname'. The same rule the edge function uses. */
create or replace function public.normalise_field_key(k text)
returns text
language sql
immutable
as $$ SELECT lower(regexp_replace(coalesce(k, ''), '[^a-zA-Z0-9]', '', 'g')) $$;

/**
 * Flatten a posted payload to one level of normalised key -> text value.
 *
 * Vendors nest: {data:{...}}, {lead:{contact:{...}, address:{...}}}. Outer keys
 * win over inner ones, because a vendor sending a top-level `email` and a
 * nested `contact.email` means the top-level one — taking the deepest match
 * would prefer whichever branch the walk happened to finish on.
 *
 * Objects and arrays that survive to a leaf are kept as their JSON text. A
 * value we cannot interpret is still better read than dropped.
 */
create or replace function public.flatten_payload(p jsonb, p_depth int default 0)
returns jsonb
language plpgsql
immutable
as $$
DECLARE
  out jsonb := '{}'::jsonb;
  k   text;
  v   jsonb;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR p_depth > 3 THEN
    RETURN out;
  END IF;

  -- Scalars first, so a shallow key is never overwritten by a deeper one.
  FOR k, v IN SELECT key, value FROM jsonb_each(p) LOOP
    IF jsonb_typeof(v) IN ('string', 'number', 'boolean') THEN
      out := out || jsonb_build_object(
        public.normalise_field_key(k),
        CASE WHEN jsonb_typeof(v) = 'string' THEN v #>> '{}' ELSE v::text END);
    END IF;
  END LOOP;

  FOR k, v IN SELECT key, value FROM jsonb_each(p) LOOP
    IF jsonb_typeof(v) = 'object' THEN
      -- Existing keys win: `out || nested` would let the nested one through.
      out := public.flatten_payload(v, p_depth + 1) || out;
    ELSIF jsonb_typeof(v) = 'array' THEN
      out := out || jsonb_build_object(public.normalise_field_key(k), v::text);
    END IF;
  END LOOP;

  RETURN out;
END;
$$;

/**
 * The value a payload carries for one leads column, or null.
 *
 * Reads the alias table in priority order and returns the first spelling the
 * payload actually has. Blank strings count as absent — a vendor posting
 * `"beds": ""` is telling us nothing, not telling us zero.
 */
create or replace function public.payload_value(p_flat jsonb, p_column text)
returns text
language sql
stable
as $$
  SELECT nullif(btrim(p_flat ->> a.alias), '')
    FROM public.lead_field_aliases a
   WHERE a.column_name = p_column
     AND p_flat ? a.alias
     AND nullif(btrim(p_flat ->> a.alias), '') IS NOT NULL
   ORDER BY a.priority, a.alias
   LIMIT 1;
$$;

/** Digits only, then a number, or null. "$185,000" and "185000.00" both work. */
create or replace function public.payload_number(p_flat jsonb, p_column text)
returns numeric
language plpgsql
stable
as $$
DECLARE
  t text := public.payload_value(p_flat, p_column);
  c text;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  c := regexp_replace(t, '[^0-9.\-]', '', 'g');
  IF c IS NULL OR c = '' OR c = '-' OR c = '.' THEN RETURN NULL; END IF;
  BEGIN
    RETURN c::numeric;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$;

/**
 * Vendors express yes in every way English allows. Anything unrecognised is
 * null rather than false: "we do not know" and "no" are different answers, and
 * on columns like pre_foreclosure the difference decides how a lead is worked.
 */
create or replace function public.payload_bool(p_flat jsonb, p_column text)
returns boolean
language sql
stable
as $$
  SELECT CASE
    WHEN lower(public.payload_value(p_flat, p_column)) IN
         ('true','t','yes','y','1','on','checked','si') THEN true
    WHEN lower(public.payload_value(p_flat, p_column)) IN
         ('false','f','no','n','0','off','unchecked') THEN false
    ELSE NULL
  END;
$$;

revoke all on function public.normalise_field_key(text) from public, anon;
revoke all on function public.flatten_payload(jsonb, int) from public, anon;
revoke all on function public.payload_value(jsonb, text)  from public, anon;
revoke all on function public.payload_number(jsonb, text) from public, anon;
revoke all on function public.payload_bool(jsonb, text)   from public, anon;
grant execute on function public.normalise_field_key(text) to authenticated, service_role;
grant execute on function public.flatten_payload(jsonb, int) to authenticated, service_role;
grant execute on function public.payload_value(jsonb, text)  to authenticated, service_role;
grant execute on function public.payload_number(jsonb, text) to authenticated, service_role;
grant execute on function public.payload_bool(jsonb, text)   to authenticated, service_role;
