-- Three things: enrolment is opt-in, an SDR is a persona rather than one global
-- personality, and what it says can be corrected over time.
--
-- ENROLMENT WAS BACKWARDS. ai-sdr gates on `lead.sdr_enabled === false`, and
-- the column was nullable with no default -- so every one of the 347 imported
-- leads sits at NULL, which is not false, and the SDR considered all of them
-- fair game. Nobody noticed because the team switch is off. Turning it on would
-- have started texting a list nobody chose. Opt-in is the only safe default for
-- a thing that sends messages on its own.
alter table public.leads alter column sdr_enabled set default false;
update public.leads set sdr_enabled = false where sdr_enabled is null;
alter table public.leads alter column sdr_enabled set not null;

/**
 * An SDR persona: the rules and voice for one kind of lead.
 *
 * A probate lead and a pre-foreclosure lead should not be opened the same way,
 * and one global `personality` column could not express that. The prompt is now
 * assembled from a persona, which means the wholesaler can run a gentle script
 * for inherited property and a direct one for a website enquiry without either
 * one being a compromise.
 *
 * custom_rules and learned_guidance are appended to the STABLE half of the
 * system prompt -- per persona, so they stay cacheable. Editing them costs one
 * cache warm-up on that persona, which is the right trade for text that changes
 * a few times a month.
 */
create table if not exists public.sdr_personas (
  id               uuid primary key default gen_random_uuid(),
  team_id          uuid not null references public.teams(id) on delete cascade,
  name             text not null,
  description      text,
  personality      text not null default 'balanced'
                     check (personality in ('aggressive','balanced','supportive')),
  -- Extra rules for this lead type, in the operator's own words.
  custom_rules     text,
  -- How to open. The single highest-leverage sentence in the whole script.
  opener_guidance  text,
  -- Grown from thumbs-down feedback the owner chose to apply. Kept separate
  -- from custom_rules so a bad correction can be rolled back without losing
  -- the rules somebody wrote deliberately.
  learned_guidance text,
  is_default       boolean not null default false,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint sdr_personas_name_not_blank check (btrim(name) <> '')
);

-- Exactly one default per team: the fallback when a lead names no persona.
create unique index if not exists sdr_personas_one_default
  on public.sdr_personas (team_id) where is_default;

alter table public.leads
  add column if not exists sdr_persona_id uuid references public.sdr_personas(id) on delete set null;

/**
 * A thumbs up or down on one message the SDR wrote.
 *
 * This is prompt refinement, not model training -- worth being plain about,
 * because "train the AI" implies weights are changing and none are. A rating
 * plus a note is evidence; promoting it writes a line into the persona's
 * learned_guidance, and that line is what actually changes the next message.
 * The chain stays visible and reversible, which a fine-tune would not be.
 */
create table if not exists public.sdr_message_feedback (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references public.teams(id) on delete cascade,
  conversation_id uuid references public.sdr_conversations(id) on delete cascade,
  sdr_send_id     uuid references public.sdr_sends(id) on delete set null,
  persona_id      uuid references public.sdr_personas(id) on delete set null,
  lead_id         uuid references public.leads(id) on delete set null,
  rating          text not null check (rating in ('up','down')),
  -- Snapshot, because the point is to review what was actually said. The
  -- conversation's messages array can be compacted or the send row purged.
  body            text not null,
  note            text,
  -- True once the note has been folded into the persona's learned_guidance.
  applied         boolean not null default false,
  created_by      uuid,
  created_at      timestamptz not null default now()
);

create index if not exists sdr_feedback_persona_idx
  on public.sdr_message_feedback (persona_id, created_at desc);
create index if not exists sdr_feedback_unapplied_idx
  on public.sdr_message_feedback (team_id, created_at desc) where not applied;

alter table public.sdr_personas         enable row level security;
alter table public.sdr_message_feedback enable row level security;

-- Reading a persona is how the Leads screen labels an enrolled lead, so every
-- role that can see leads can read them. Changing one is sdr.manage.
drop policy if exists sdr_personas_read   on public.sdr_personas;
drop policy if exists sdr_personas_manage on public.sdr_personas;
create policy sdr_personas_read on public.sdr_personas for select
  using (team_id = public.get_my_team_id());
create policy sdr_personas_manage on public.sdr_personas for all
  using (team_id = public.get_my_team_id() and public.has_capability('sdr.manage'))
  with check (team_id = public.get_my_team_id() and public.has_capability('sdr.manage'));

-- Anyone working leads can rate a message -- the VA reading the replies is
-- exactly who notices a bad one. Only sdr.manage can act on the ratings.
drop policy if exists sdr_feedback_read   on public.sdr_message_feedback;
drop policy if exists sdr_feedback_write  on public.sdr_message_feedback;
drop policy if exists sdr_feedback_manage on public.sdr_message_feedback;
create policy sdr_feedback_read on public.sdr_message_feedback for select
  using (team_id = public.get_my_team_id() and public.has_capability('leads.view'));
create policy sdr_feedback_write on public.sdr_message_feedback for insert
  with check (team_id = public.get_my_team_id() and public.has_capability('leads.view'));
create policy sdr_feedback_manage on public.sdr_message_feedback for update
  using (team_id = public.get_my_team_id() and public.has_capability('sdr.manage'))
  with check (team_id = public.get_my_team_id());

drop trigger if exists trg_sdr_personas_touch on public.sdr_personas;
create trigger trg_sdr_personas_touch before update on public.sdr_personas
  for each row execute function public.touch_updated_at();

-- Seed one persona from the settings that exist, so nothing is without a script
-- the moment this lands.
insert into public.sdr_personas (team_id, name, description, personality, is_default)
select s.team_id, 'General seller',
       'The default script. Used for any enrolled lead that has not been given a persona of its own.',
       s.personality, true
  from public.sdr_settings s
 where not exists (select 1 from public.sdr_personas p where p.team_id = s.team_id)
on conflict do nothing;
