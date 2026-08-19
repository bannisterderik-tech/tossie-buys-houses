-- The buyer list Tossie actually keeps is organised by city and state, not by
-- county: of the 70 buyers imported from the previous CRM, 49 carry target
-- cities and 39 carry a state, while only 6 carry a county. Without these the
-- dispo match falls back to counties/zips and silently drops the buying
-- criteria for two thirds of the list -- which reads as "the matcher is broken"
-- rather than "the criteria were never stored".
alter table public.buyers
  add column if not exists cities text[] not null default '{}',
  add column if not exists states text[] not null default '{}';

create index if not exists buyers_cities_idx on public.buyers using gin (cities);
create index if not exists buyers_states_idx on public.buyers using gin (states);

comment on column public.buyers.cities is 'Target cities, lower-cased. Primary dispo match for this team.';
comment on column public.buyers.states is 'Target states, two-letter lower-cased.';
