-- Files belong to the property, not only to the contract.
--
-- deal_documents required a deal, so everything that arrives BEFORE one — a
-- probate letter, a signed disclosure, a payoff statement, the photo of a
-- notice taped to the door — had nowhere to live. The operator either held it
-- in email until a deal existed, or attached it to a deal created early just to
-- have somewhere to put it. Both lose the document.
--
-- ONE TABLE, NOT TWO. Photos and contracts already carry lead_id and deal_id on
-- the same row and follow the property through conversion; documents get the
-- same treatment rather than a lead_documents table that would drift from this
-- one within a month. The rename would be honest but is not worth breaking
-- every reference in the app over -- the table is documents about a property,
-- whatever it is called.
alter table public.deal_documents
  add column if not exists lead_id uuid references public.leads(id) on delete cascade;

-- deal_id stops being required. It has to keep ON DELETE CASCADE for the
-- deal-only case, so the trigger below handles the rest.
alter table public.deal_documents alter column deal_id drop not null;

alter table public.deal_documents
  drop constraint if exists deal_documents_needs_a_subject;
alter table public.deal_documents
  add constraint deal_documents_needs_a_subject
  check (num_nonnulls(lead_id, deal_id) >= 1);

-- The old uniqueness was (deal_id, storage_path), which permits unlimited
-- duplicates once deal_id is null. The path is already unique per upload.
alter table public.deal_documents drop constraint if exists deal_documents_path_unique;
create unique index if not exists deal_documents_storage_path_key
  on public.deal_documents (storage_path);

create index if not exists deal_documents_lead_idx
  on public.deal_documents (lead_id, created_at desc);

-- Kinds that only make sense before there is a contract.
alter table public.deal_documents drop constraint if exists deal_documents_kind_check;
alter table public.deal_documents add constraint deal_documents_kind_check
  check (kind in (
    'purchase_agreement', 'assignment_agreement', 'addendum', 'emd_receipt',
    'proof_of_funds', 'settlement_statement', 'inspection_report',
    'title_commitment', 'photo', 'comps', 'other',
    -- new, and all of them things a seller hands over before signing
    'seller_disclosure', 'probate_paperwork', 'death_certificate',
    'payoff_statement', 'tax_notice', 'code_violation', 'lien_notice',
    'lease_agreement', 'insurance_claim', 'id_document'
  ));

-- Carry a lead's documents onto the deal made from it, and catch the other
-- direction in time. Identical to the photo and contract triggers.
create or replace function public.attach_lead_documents_to_deal()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE public.deal_documents
       SET deal_id = NEW.id
     WHERE lead_id = NEW.lead_id AND deal_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
revoke execute on function public.attach_lead_documents_to_deal() from public, anon, authenticated;

drop trigger if exists trg_deal_inherits_lead_documents on public.deals;
create trigger trg_deal_inherits_lead_documents
  after insert on public.deals
  for each row execute function public.attach_lead_documents_to_deal();

create or replace function public.attach_document_to_existing_deal()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  IF NEW.lead_id IS NOT NULL AND NEW.deal_id IS NULL THEN
    SELECT d.id INTO NEW.deal_id FROM public.deals d
     WHERE d.lead_id = NEW.lead_id AND NOT d.trashed
     ORDER BY d.created_at DESC LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;
revoke execute on function public.attach_document_to_existing_deal() from public, anon, authenticated;

drop trigger if exists trg_document_joins_existing_deal on public.deal_documents;
create trigger trg_document_joins_existing_deal
  before insert on public.deal_documents
  for each row execute function public.attach_document_to_existing_deal();

-- deal_id still cascades, so a deleted deal would take a document that also
-- belongs to a lead. The lead is the more durable subject: a deal dies, the
-- probate letter is still about that house. Detach rather than destroy.
create or replace function public.keep_lead_documents_when_deal_dies()
returns trigger language plpgsql security definer
set search_path to 'public', 'pg_catalog'
as $$
BEGIN
  UPDATE public.deal_documents
     SET deal_id = NULL
   WHERE deal_id = OLD.id AND lead_id IS NOT NULL;
  RETURN OLD;
END;
$$;
revoke execute on function public.keep_lead_documents_when_deal_dies() from public, anon, authenticated;

drop trigger if exists trg_deal_delete_keeps_lead_documents on public.deals;
create trigger trg_deal_delete_keeps_lead_documents
  before delete on public.deals
  for each row execute function public.keep_lead_documents_when_deal_dies();

comment on column public.deal_documents.lead_id is
  'The property this document is about. Set before a deal exists; the deal is stamped on later by trigger.';
