-- =====================================================================
-- MIGRATION 05 — CMS integrity, staff management, property workflow,
-- lead CRM, audit log, storage hardening, cache versioning
-- ---------------------------------------------------------------------
-- Run AFTER migrations 01–04 (see supabase/migrations/README.md).
-- Safe to re-run. Nothing is deleted: duplicate "featured" flags are
-- cleared (the image itself stays), every other change only ADDS
-- columns, tables, functions, triggers or replaces policies.
--
--  1. Staff: admin_users.is_active; role helpers ignore inactive staff;
--     last ACTIVE super_admin can't be removed/demoted/deactivated;
--     list_staff() / add_staff_by_email() for super_admin only.
--  2. Featured images: at most ONE per property (partial unique index,
--     duplicates cleaned first), automatic promotion when the featured
--     image is deleted, atomic set_featured_image().
--  3. property_images path integrity: new rows must use
--     "<property id>/<safe file>" and get their public URL from the path.
--  4. Property business rules (For Sale + Rented etc.) enforced in the DB.
--  5. Review workflow: properties.review_status (draft / under_review /
--     approved). Editors submit for review; only admins approve/publish.
--  6. property_internal: owner/mandate/expiry data in a SEPARATE table
--     with no public policy — it can never reach the public API.
--  7. Leads CRM: priority, assigned_to, follow_up_date, budget,
--     requirement, next_action + lead_activity timeline.
--  8. audit_log: written only by triggers; read by super_admin/admin;
--     nobody can edit or delete entries through the API.
--  9. Storage: tighter property-images policies (safe file names, real
--     property folder for every write), orphan-cleanup queue + report,
--     public site-media bucket for branding/founder/homepage/general.
-- 10. site_cache_state: version number bumped on every public-content
--     change so the Worker's cache refreshes within seconds.
-- 11. settings: homepage SEO, default share image, office hours, and
--     server-side validation of URLs / phone / email.
-- 12. dashboard_stats(): all dashboard numbers in one RLS-respecting call.
-- =====================================================================

begin;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------
-- 0. Generic helpers (private: not callable through the API)
-- ---------------------------------------------------------------------
-- Keys whose values differ between two row images.
create or replace function private.changed_keys(o jsonb, n jsonb, ignore text[] default '{}')
returns text[]
language sql immutable
as $$
  select coalesce(array_agg(k order by k), '{}')
  from (
    select key as k from jsonb_object_keys(coalesce(o, '{}'::jsonb) || coalesce(n, '{}'::jsonb)) as t(key)
  ) keys
  where not (k = any(ignore))
    and (o -> k) is distinct from (n -> k)
$$;

-- The given keys of a row image, long text shortened (audit rows stay small).
create or replace function private.pick(j jsonb, keys text[])
returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_object_agg(k,
           case when jsonb_typeof(j -> k) = 'string' and char_length(j ->> k) > 300
                then to_jsonb(left(j ->> k, 300) || '…')
                else j -> k end), '{}'::jsonb)
  from unnest(keys) as k
  where j ? k
$$;

-- ---------------------------------------------------------------------
-- 1. STAFF
-- ---------------------------------------------------------------------
alter table public.admin_users add column if not exists is_active boolean not null default true;
alter table public.admin_users add column if not exists updated_at timestamptz not null default now();
alter table public.admin_users drop constraint if exists admin_users_display_name_len;
alter table public.admin_users add constraint admin_users_display_name_len
  check (display_name is null or char_length(display_name) <= 80) not valid;

-- Inactive staff lose every permission immediately (all RLS policies go
-- through these two helpers).
create or replace function public.current_admin_role()
returns text
language sql stable security definer
set search_path = public
as $$
  select role from public.admin_users where user_id = auth.uid() and is_active
$$;

create or replace function public.has_admin_role(allowed text[])
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where user_id = auth.uid() and is_active and role = any(allowed)
  )
$$;

create or replace function public.guard_last_super_admin()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;
  if (tg_op = 'DELETE' and old.role = 'super_admin' and old.is_active)
     or (tg_op = 'UPDATE' and old.role = 'super_admin' and old.is_active
         and (new.role <> 'super_admin' or not new.is_active)) then
    if (select count(*) from public.admin_users
         where role = 'super_admin' and is_active and user_id <> old.user_id) = 0 then
      raise exception 'Cannot remove, demote or deactivate the last active super_admin.'
        using errcode = '42501';
    end if;
  end if;
  return coalesce(new, old);
end $$;

-- Staff list with e-mail addresses (auth.users is not readable by clients).
create or replace function public.list_staff()
returns table (user_id uuid, email text, display_name text, role text, is_active boolean,
               created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql stable security definer
set search_path = public, auth
as $$
#variable_conflict use_column
begin
  if not public.has_admin_role(array['super_admin']) then
    raise exception 'Only a super admin can manage staff.' using errcode = '42501';
  end if;
  return query
    select a.user_id, u.email::text, a.display_name, a.role, a.is_active, a.created_at, u.last_sign_in_at
      from public.admin_users a
      join auth.users u on u.id = a.user_id
     order by a.is_active desc, a.role, lower(u.email::text);
end $$;
revoke all on function public.list_staff() from public, anon;
grant execute on function public.list_staff() to authenticated;

-- Give an EXISTING Supabase Auth account a staff role (or change it).
-- New accounts are created by Supabase Auth (invite / dashboard), never here.
create or replace function public.add_staff_by_email(p_email text, p_role text, p_display_name text default null)
returns jsonb
language plpgsql security definer
set search_path = public, auth
as $$
declare
  v_uid uuid;
begin
  if not public.has_admin_role(array['super_admin']) then
    raise exception 'Only a super admin can manage staff.' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('super_admin','admin','editor','sales','viewer') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role');
  end if;
  select id into v_uid from auth.users where lower(email::text) = lower(btrim(coalesce(p_email, '')));
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'no_account');
  end if;
  insert into public.admin_users (user_id, role, display_name, created_by, is_active)
  values (v_uid, p_role, nullif(left(btrim(coalesce(p_display_name, '')), 80), ''), auth.uid(), true)
  on conflict (user_id) do update
     set role = excluded.role,
         display_name = coalesce(excluded.display_name, public.admin_users.display_name),
         is_active = true;
  return jsonb_build_object('ok', true, 'user_id', v_uid);
end $$;
revoke all on function public.add_staff_by_email(text, text, text) from public, anon;
grant execute on function public.add_staff_by_email(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2. FEATURED IMAGE: at most one per property
-- ---------------------------------------------------------------------
do $$
declare n int;
begin
  with ranked as (
    select id, row_number() over (partition by property_id
             order by sort_order nulls last, created_at, id) as rn
      from public.property_images where is_featured_image
  )
  update public.property_images set is_featured_image = false
   where id in (select id from ranked where rn > 1);
  get diagnostics n = row_count;
  if n > 0 then
    raise notice 'Featured images: cleared % duplicate featured flag(s) (images kept).', n;
  end if;
end $$;

alter table public.property_images alter column is_featured_image set default false;
update public.property_images set is_featured_image = false where is_featured_image is null;

create unique index if not exists uniq_property_images_one_featured
  on public.property_images (property_id) where is_featured_image;

-- Atomic "make this the featured image" (RLS decides who may).
create or replace function public.set_featured_image(p_image_id uuid)
returns void
language plpgsql security invoker
set search_path = public
as $$
declare v_property uuid;
begin
  select property_id into v_property from public.property_images where id = p_image_id;
  if v_property is null then
    raise exception 'Image not found.' using errcode = 'P0002';
  end if;
  update public.property_images set is_featured_image = false
   where property_id = v_property and is_featured_image and id <> p_image_id;
  update public.property_images set is_featured_image = true where id = p_image_id;
  if not found then
    raise exception 'Your role is not allowed to change images.' using errcode = '42501';
  end if;
end $$;
revoke all on function public.set_featured_image(uuid) from public, anon;
grant execute on function public.set_featured_image(uuid) to authenticated;

-- Deleting the featured image promotes the next one (by sort order), so a
-- property with photos is never left without a featured photo.
create or replace function public.promote_featured_image_after_delete()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if old.is_featured_image then
    update public.property_images set is_featured_image = true
     where id = (select id from public.property_images
                  where property_id = old.property_id
                  order by sort_order nulls last, created_at, id limit 1)
       and not exists (select 1 from public.property_images
                        where property_id = old.property_id and is_featured_image);
  end if;
  return null;
end $$;

drop trigger if exists trg_promote_featured_image on public.property_images;
create trigger trg_promote_featured_image
  after delete on public.property_images
  for each row execute function public.promote_featured_image_after_delete();

-- ---------------------------------------------------------------------
-- 3. property_images path integrity (new / changed rows only)
-- ---------------------------------------------------------------------
create or replace function public.is_valid_property_image_path(p text)
returns boolean
language sql immutable
as $$
  select coalesce(p, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
     and coalesce(p, '') !~ '\.\.'
     and lower(coalesce(p, '')) ~ '\.(jpe?g|png|webp|avif)$'
$$;

create or replace function public.check_property_image_row()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.storage_path is distinct from old.storage_path then
    if coalesce(new.storage_path, '') <> '' then
      if not public.is_valid_property_image_path(new.storage_path)
         or split_part(new.storage_path, '/', 1) <> new.property_id::text then
        raise exception 'Image path must be "<this property id>/<file name>.jpg|png|webp|avif".'
          using errcode = '23514';
      end if;
      -- One source of truth for the public address of uploaded photos.
      new.public_url := '/media/property-images/' || new.storage_path;
    end if;
  end if;
  if new.alt_text is not null and char_length(new.alt_text) > 200 then
    raise exception 'ALT text must be 200 characters or fewer.' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_check_property_image_row on public.property_images;
create trigger trg_check_property_image_row
  before insert or update on public.property_images
  for each row execute function public.check_property_image_row();

-- ---------------------------------------------------------------------
-- 4. PROPERTY BUSINESS RULES (checked when listing type / status change)
-- ---------------------------------------------------------------------
create or replace function public.validate_property_business_rules()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT'
     or new.listing_type is distinct from old.listing_type
     or new.status is distinct from old.status then
    if new.listing_type = 'For Sale' and new.status in ('Rented', 'Leased') then
      raise exception 'A property listed For Sale cannot be marked "%". Change the listing type or the status.', new.status
        using errcode = '23514';
    end if;
    if new.listing_type in ('For Rent', 'For Lease') and new.status = 'Sold' then
      raise exception 'A property listed % cannot be marked "Sold". Use Rented / Leased, or change the listing type.', new.listing_type
        using errcode = '23514';
    end if;
  end if;
  if (tg_op = 'INSERT' or new.price is distinct from old.price)
     and new.price is not null and new.price > 1e12 then
    raise exception 'Price looks wrong (more than ₹1,00,000 crore).' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_property_business_rules on public.properties;
create trigger trg_property_business_rules
  before insert or update on public.properties
  for each row execute function public.validate_property_business_rules();

-- seo_keywords is kept (no data is dropped) but is not an SEO feature:
-- nothing reads it and the admin no longer shows it.
comment on column public.properties.seo_keywords is
  'DEPRECATED — not used by the website (search engines ignore meta keywords). Kept only so no data is lost.';

-- ---------------------------------------------------------------------
-- 5. REVIEW WORKFLOW
--    Draft → Under Review → Approved → Published (is_published)
--    Market state stays in `status` (Available / Under Offer / Sold /
--    Rented / Leased / Inactive); Archived stays `is_archived`.
-- ---------------------------------------------------------------------
alter table public.properties add column if not exists review_status text not null default 'draft';
alter table public.properties drop constraint if exists properties_review_status_check;
alter table public.properties add constraint properties_review_status_check
  check (review_status in ('draft', 'under_review', 'approved'));

-- Back-fill: already-published listings count as approved. updated_at
-- is left untouched so sitemap dates don't jump.
alter table public.properties disable trigger trg_properties_updated_at;
update public.properties set review_status = 'approved'
 where is_published and review_status = 'draft';
alter table public.properties enable trigger trg_properties_updated_at;

create or replace function public.property_review_workflow()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  is_admin boolean := auth.uid() is null or public.has_admin_role(array['super_admin','admin']);
  ignore text[] := array['updated_at','review_status','is_featured'];
begin
  -- Publishing implies approval.
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) then
    new.review_status := 'approved';
  end if;

  if not is_admin then
    if tg_op = 'INSERT' then
      if new.review_status = 'approved' then
        raise exception 'Only an admin can approve a property.' using errcode = '42501';
      end if;
    else
      if new.review_status = 'approved' and old.review_status <> 'approved' then
        raise exception 'Only an admin can approve a property. Submit it for review instead.' using errcode = '42501';
      end if;
      -- An editor changing an approved (not yet published) listing sends it
      -- back for review, so admins always approve what actually goes live.
      if old.review_status = 'approved' and new.review_status = 'approved' and not new.is_published
         and (to_jsonb(new) - ignore) is distinct from (to_jsonb(old) - ignore) then
        new.review_status := 'under_review';
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_property_review_workflow on public.properties;
create trigger trg_property_review_workflow
  before insert or update on public.properties
  for each row execute function public.property_review_workflow();

create index if not exists idx_properties_review on public.properties (review_status) where not is_published and not is_archived;

-- ---------------------------------------------------------------------
-- 6. INTERNAL PROPERTY DATA (never public)
-- ---------------------------------------------------------------------
create table if not exists public.property_internal (
  property_id        uuid primary key references public.properties(id) on delete cascade,
  owner_name         text check (owner_name is null or char_length(owner_name) <= 120),
  owner_phone        text check (owner_phone is null or char_length(owner_phone) <= 25),
  mandate            text check (mandate is null or mandate in ('exclusive', 'non_exclusive')),
  listing_date       date,
  expiry_date        date,
  acquisition_source text check (acquisition_source is null or char_length(acquisition_source) <= 120),
  internal_notes     text check (internal_notes is null or char_length(internal_notes) <= 4000),
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  constraint property_internal_dates check (expiry_date is null or listing_date is null or expiry_date >= listing_date)
);
comment on table public.property_internal is
  'Staff-only listing data (owner, mandate, dates, notes). Deliberately a separate table: the public can read published rows of `properties`, so private data must never be a column there.';

alter table public.property_internal enable row level security;
revoke all on public.property_internal from anon;

drop policy if exists "internal read" on public.property_internal;
drop policy if exists "internal insert" on public.property_internal;
drop policy if exists "internal update" on public.property_internal;
drop policy if exists "internal delete" on public.property_internal;
create policy "internal read" on public.property_internal for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor','sales']));
create policy "internal insert" on public.property_internal for insert to authenticated
  with check (public.has_admin_role(array['super_admin','admin','editor']));
create policy "internal update" on public.property_internal for update to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor']))
  with check (public.has_admin_role(array['super_admin','admin','editor']));
create policy "internal delete" on public.property_internal for delete to authenticated
  using (public.has_admin_role(array['super_admin','admin']));

create or replace function public.touch_property_internal()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists trg_touch_property_internal on public.property_internal;
create trigger trg_touch_property_internal
  before insert or update on public.property_internal
  for each row execute function public.touch_property_internal();

-- ---------------------------------------------------------------------
-- 7. LEADS CRM
-- ---------------------------------------------------------------------
alter table public.leads add column if not exists priority       text not null default 'normal';
alter table public.leads add column if not exists assigned_to    uuid references public.admin_users(user_id) on delete set null;
alter table public.leads add column if not exists follow_up_date date;
alter table public.leads add column if not exists budget         text;
alter table public.leads add column if not exists requirement    text;
alter table public.leads add column if not exists next_action    text;

alter table public.leads drop constraint if exists leads_priority_check;
alter table public.leads add constraint leads_priority_check
  check (priority in ('low', 'normal', 'high', 'urgent'));
alter table public.leads drop constraint if exists leads_crm_lengths;
alter table public.leads add constraint leads_crm_lengths check (
  (budget is null or char_length(budget) <= 200)
  and (requirement is null or char_length(requirement) <= 2000)
  and (next_action is null or char_length(next_action) <= 500)
  and (internal_notes is null or char_length(internal_notes) <= 4000)
) not valid;

create index if not exists idx_leads_open_created on public.leads (created_at desc) where not is_archived;
create index if not exists idx_leads_assigned on public.leads (assigned_to) where assigned_to is not null;
create index if not exists idx_leads_follow_up on public.leads (follow_up_date) where follow_up_date is not null and not is_archived;

-- Assignment rules (database-enforced, not just hidden buttons).
create or replace function public.guard_lead_update()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.assigned_to is distinct from old.assigned_to then
    if new.assigned_to is not null and not exists (
         select 1 from public.admin_users
          where user_id = new.assigned_to and is_active and role in ('super_admin','admin','sales')) then
      raise exception 'Leads can only be assigned to active super admin, admin or sales staff.' using errcode = '23514';
    end if;
    if auth.uid() is not null and not public.has_admin_role(array['super_admin','admin']) then
      -- Sales may claim an unassigned lead or release their own — nothing else.
      if not ((old.assigned_to is null and new.assigned_to = auth.uid())
              or (old.assigned_to = auth.uid() and new.assigned_to is null)) then
        raise exception 'Only an admin can reassign a lead that belongs to someone else.' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_lead_update on public.leads;
create trigger trg_guard_lead_update
  before update on public.leads
  for each row execute function public.guard_lead_update();

create table if not exists public.lead_activity (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.leads(id) on delete cascade,
  actor      uuid,
  kind       text not null check (kind in (
               'assigned','unassigned','status_changed','priority_changed','details_updated',
               'follow_up_scheduled','follow_up_cleared','follow_up_completed',
               'note','call','whatsapp','email','archived','restored')),
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_activity_lead on public.lead_activity (lead_id, created_at desc);
create index if not exists idx_lead_activity_recent on public.lead_activity (created_at desc);

alter table public.lead_activity enable row level security;
revoke all on public.lead_activity from anon;
drop policy if exists "lead staff read activity" on public.lead_activity;
drop policy if exists "lead staff add own notes" on public.lead_activity;
create policy "lead staff read activity" on public.lead_activity for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','sales']));
-- Staff may only add their OWN manual entries; system events come from
-- triggers. No update/delete policy: the timeline is append-only.
create policy "lead staff add own notes" on public.lead_activity for insert to authenticated
  with check (
    public.has_admin_role(array['super_admin','admin','sales'])
    and actor = auth.uid()
    and kind in ('note','call','whatsapp','email')
    and char_length(coalesce(detail ->> 'text', '')) <= 4000
  );

create or replace function public.log_lead_activity()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_done  boolean := coalesce(current_setting('dgss.follow_up_done', true), '') = '1';
  v_keys  text[];
begin
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_activity (lead_id, actor, kind, detail)
    values (new.id, v_actor, case when new.assigned_to is null then 'unassigned' else 'assigned' end,
            jsonb_build_object('from', old.assigned_to, 'to', new.assigned_to));
  end if;
  if new.status is distinct from old.status then
    insert into public.lead_activity (lead_id, actor, kind, detail)
    values (new.id, v_actor, 'status_changed', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.priority is distinct from old.priority then
    insert into public.lead_activity (lead_id, actor, kind, detail)
    values (new.id, v_actor, 'priority_changed', jsonb_build_object('from', old.priority, 'to', new.priority));
  end if;
  if new.follow_up_date is distinct from old.follow_up_date then
    if v_done and old.follow_up_date is not null then
      insert into public.lead_activity (lead_id, actor, kind, detail)
      values (new.id, v_actor, 'follow_up_completed', jsonb_build_object('date', old.follow_up_date));
    end if;
    if new.follow_up_date is not null then
      insert into public.lead_activity (lead_id, actor, kind, detail)
      values (new.id, v_actor, 'follow_up_scheduled', jsonb_build_object('date', new.follow_up_date));
    elsif not v_done then
      insert into public.lead_activity (lead_id, actor, kind, detail)
      values (new.id, v_actor, 'follow_up_cleared', jsonb_build_object('date', old.follow_up_date));
    end if;
  end if;
  if new.is_archived is distinct from old.is_archived then
    insert into public.lead_activity (lead_id, actor, kind, detail)
    values (new.id, v_actor, case when new.is_archived then 'archived' else 'restored' end, '{}'::jsonb);
  end if;
  v_keys := private.changed_keys(
    jsonb_build_object('budget', old.budget, 'requirement', old.requirement, 'next_action', old.next_action, 'internal_notes', old.internal_notes),
    jsonb_build_object('budget', new.budget, 'requirement', new.requirement, 'next_action', new.next_action, 'internal_notes', new.internal_notes));
  if array_length(v_keys, 1) > 0 then
    insert into public.lead_activity (lead_id, actor, kind, detail)
    values (new.id, v_actor, 'details_updated', jsonb_build_object('fields', to_jsonb(v_keys)));
  end if;
  return null;
end $$;
drop trigger if exists trg_log_lead_activity on public.leads;
create trigger trg_log_lead_activity
  after update on public.leads
  for each row execute function public.log_lead_activity();

-- "Follow-up done" (optionally scheduling the next one) in one step.
create or replace function public.complete_lead_follow_up(p_lead_id uuid, p_next date default null, p_note text default null)
returns void
language plpgsql security invoker
set search_path = public
as $$
begin
  if not public.has_admin_role(array['super_admin','admin','sales']) then
    raise exception 'Your role cannot update leads.' using errcode = '42501';
  end if;
  perform set_config('dgss.follow_up_done', '1', true);
  update public.leads set follow_up_date = p_next where id = p_lead_id;
  if not found then
    raise exception 'Lead not found.' using errcode = 'P0002';
  end if;
  perform set_config('dgss.follow_up_done', '', true);
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    insert into public.lead_activity (lead_id, actor, kind, detail)
    values (p_lead_id, auth.uid(), 'note', jsonb_build_object('text', left(btrim(p_note), 4000)));
  end if;
end $$;
revoke all on function public.complete_lead_follow_up(uuid, date, text) from public, anon;
grant execute on function public.complete_lead_follow_up(uuid, date, text) to authenticated;

-- Names of staff who can own leads (for the "Assign to" list). Emails
-- are not exposed; display name falls back to a short label.
create or replace function public.lead_assignees()
returns table (user_id uuid, label text, role text)
language plpgsql stable security definer
set search_path = public, auth
as $$
#variable_conflict use_column
begin
  if not public.has_admin_role(array['super_admin','admin','sales']) then
    raise exception 'Your role cannot view leads.' using errcode = '42501';
  end if;
  return query
    select a.user_id,
           coalesce(nullif(a.display_name, ''), split_part(u.email::text, '@', 1)),
           a.role
      from public.admin_users a join auth.users u on u.id = a.user_id
     where a.is_active and a.role in ('super_admin','admin','sales')
     order by 2;
end $$;
revoke all on function public.lead_assignees() from public, anon;
grant execute on function public.lead_assignees() to authenticated;

-- Readable names for the audit log / dashboards (admins only). No emails.
create or replace function public.staff_labels()
returns table (user_id uuid, label text, role text, is_active boolean)
language plpgsql stable security definer
set search_path = public, auth
as $$
#variable_conflict use_column
begin
  if not public.has_admin_role(array['super_admin','admin']) then
    raise exception 'Admins only.' using errcode = '42501';
  end if;
  return query
    select a.user_id, coalesce(nullif(a.display_name, ''), split_part(u.email::text, '@', 1)), a.role, a.is_active
      from public.admin_users a join auth.users u on u.id = a.user_id;
end $$;
revoke all on function public.staff_labels() from public, anon;
grant execute on function public.staff_labels() to authenticated;

-- ---------------------------------------------------------------------
-- 8. AUDIT LOG
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor       uuid,
  actor_role  text,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  summary     text,
  before      jsonb,
  after       jsonb
);
create index if not exists idx_audit_created on public.audit_log (created_at desc);
create index if not exists idx_audit_entity on public.audit_log (entity_type, entity_id, created_at desc);

alter table public.audit_log enable row level security;
revoke all on public.audit_log from anon;
revoke insert, update, delete, truncate on public.audit_log from authenticated;
drop policy if exists "admins read audit log" on public.audit_log;
create policy "admins read audit log" on public.audit_log for select to authenticated
  using (public.has_admin_role(array['super_admin','admin']));
-- No insert/update/delete policies: entries are written by triggers only.

create or replace function private.block_audit_update()
returns trigger language plpgsql as $$
begin
  raise exception 'Audit log entries cannot be changed.' using errcode = '42501';
end $$;
drop trigger if exists trg_block_audit_update on public.audit_log;
create trigger trg_block_audit_update before update on public.audit_log
  for each row execute function private.block_audit_update();

create or replace function private.audit_write(p_action text, p_entity_type text, p_entity_id text,
                                               p_summary text, p_before jsonb, p_after jsonb)
returns void
language sql security definer
set search_path = public
as $$
  insert into public.audit_log (actor, actor_role, action, entity_type, entity_id, summary, before, after)
  values (auth.uid(), public.current_admin_role(), p_action, p_entity_type, p_entity_id,
          left(p_summary, 300), nullif(p_before, '{}'::jsonb), nullif(p_after, '{}'::jsonb));
$$;
revoke all on function private.audit_write(text, text, text, text, jsonb, jsonb) from public, anon, authenticated;

-- properties
create or replace function private.audit_properties()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  keys text[];
  rest text[];
  price_keys text[] := array['price','display_price','price_per_sqft','is_price_on_request','is_negotiable'];
  id_keys text[] := array['title','slug','status','listing_type'];
  v_id text := coalesce(n ->> 'id', o ->> 'id');
  v_title text := coalesce(n ->> 'title', o ->> 'title');
begin
  if tg_op = 'INSERT' then
    perform private.audit_write('property_created', 'property', v_id, v_title, null,
      private.pick(n, id_keys || array['is_published','review_status','price','display_price']));
    return null;
  elsif tg_op = 'DELETE' then
    perform private.audit_write('property_deleted', 'property', v_id, v_title,
      private.pick(o, id_keys || array['is_published','is_archived','price','display_price']), null);
    return null;
  end if;

  keys := private.changed_keys(o, n, array['updated_at','created_at']);
  if coalesce(array_length(keys, 1), 0) = 0 then return null; end if;
  rest := keys;

  if 'is_published' = any(keys) then
    perform private.audit_write(case when new.is_published then 'property_published' else 'property_unpublished' end,
      'property', v_id, v_title, private.pick(o, array['is_published']), private.pick(n, array['is_published']));
    rest := array_remove(array_remove(rest, 'is_published'), 'review_status');
  end if;
  if 'is_archived' = any(keys) then
    perform private.audit_write(case when new.is_archived then 'property_archived' else 'property_unarchived' end,
      'property', v_id, v_title, private.pick(o, array['is_archived']), private.pick(n, array['is_archived']));
    rest := array_remove(rest, 'is_archived');
  end if;
  if keys && price_keys then
    perform private.audit_write('price_changed', 'property', v_id, v_title,
      private.pick(o, price_keys), private.pick(n, price_keys));
    rest := array(select k from unnest(rest) k where not (k = any(price_keys)));
  end if;
  if 'review_status' = any(rest) then
    perform private.audit_write('property_review_' || new.review_status, 'property', v_id, v_title,
      private.pick(o, array['review_status']), private.pick(n, array['review_status']));
    rest := array_remove(rest, 'review_status');
  end if;
  if coalesce(array_length(rest, 1), 0) > 0 then
    perform private.audit_write('property_edited', 'property', v_id, v_title,
      private.pick(o, rest), private.pick(n, rest));
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_properties on public.properties;
create trigger trg_audit_properties after insert or update or delete on public.properties
  for each row execute function private.audit_properties();

-- property_images (featured changes, additions, deletions)
create or replace function private.audit_property_images()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write('image_added', 'property', new.property_id::text, null, null,
      jsonb_build_object('image_id', new.id, 'storage_path', new.storage_path));
  elsif tg_op = 'DELETE' then
    perform private.audit_write('image_deleted', 'property', old.property_id::text, null,
      jsonb_build_object('image_id', old.id, 'storage_path', old.storage_path, 'was_featured', old.is_featured_image), null);
  elsif new.is_featured_image and not coalesce(old.is_featured_image, false) then
    perform private.audit_write('featured_image_changed', 'property', new.property_id::text, null, null,
      jsonb_build_object('image_id', new.id));
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_property_images on public.property_images;
create trigger trg_audit_property_images after insert or update or delete on public.property_images
  for each row execute function private.audit_property_images();

-- leads (no personal data in the audit log — only workflow fields)
create or replace function private.audit_leads()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform private.audit_write('lead_deleted', 'lead', old.id::text, null,
      jsonb_build_object('source', old.source, 'status', old.status), null);
    return null;
  end if;
  if new.status is distinct from old.status then
    perform private.audit_write('lead_status_changed', 'lead', new.id::text, null,
      jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  if new.is_archived is distinct from old.is_archived then
    perform private.audit_write(case when new.is_archived then 'lead_archived' else 'lead_restored' end,
      'lead', new.id::text, null, null, null);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform private.audit_write('lead_assigned', 'lead', new.id::text, null,
      jsonb_build_object('assigned_to', old.assigned_to), jsonb_build_object('assigned_to', new.assigned_to));
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_leads on public.leads;
create trigger trg_audit_leads after update or delete on public.leads
  for each row execute function private.audit_leads();

-- settings
create or replace function private.audit_settings()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare keys text[];
begin
  keys := private.changed_keys(to_jsonb(old), to_jsonb(new), array['updated_at']);
  if coalesce(array_length(keys, 1), 0) > 0 then
    perform private.audit_write('settings_changed', 'settings', '1', array_to_string(keys, ', '),
      private.pick(to_jsonb(old), keys), private.pick(to_jsonb(new), keys));
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_settings on public.settings;
create trigger trg_audit_settings after update on public.settings
  for each row execute function private.audit_settings();

-- testimonials
create or replace function private.audit_testimonials()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare keys text[];
begin
  if tg_op = 'INSERT' then
    perform private.audit_write('testimonial_created', 'testimonial', new.id::text, new.client_name, null,
      private.pick(to_jsonb(new), array['client_name','is_published']));
  elsif tg_op = 'DELETE' then
    perform private.audit_write('testimonial_deleted', 'testimonial', old.id::text, old.client_name,
      private.pick(to_jsonb(old), array['client_name','is_published']), null);
  else
    keys := private.changed_keys(to_jsonb(old), to_jsonb(new), array['created_at']);
    if coalesce(array_length(keys, 1), 0) > 0 then
      perform private.audit_write(
        case when 'is_published' = any(keys) then
               case when new.is_published then 'testimonial_published' else 'testimonial_unpublished' end
             else 'testimonial_changed' end,
        'testimonial', new.id::text, new.client_name, private.pick(to_jsonb(old), keys), private.pick(to_jsonb(new), keys));
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_testimonials on public.testimonials;
create trigger trg_audit_testimonials after insert or update or delete on public.testimonials
  for each row execute function private.audit_testimonials();

-- staff
create or replace function private.audit_admin_users()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit_write('staff_added', 'staff', new.user_id::text, new.display_name, null,
      jsonb_build_object('role', new.role, 'is_active', new.is_active));
  elsif tg_op = 'DELETE' then
    perform private.audit_write('staff_removed', 'staff', old.user_id::text, old.display_name,
      jsonb_build_object('role', old.role, 'is_active', old.is_active), null);
  else
    if new.role is distinct from old.role then
      perform private.audit_write('staff_role_changed', 'staff', new.user_id::text, new.display_name,
        jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
    end if;
    if new.is_active is distinct from old.is_active then
      perform private.audit_write(case when new.is_active then 'staff_reactivated' else 'staff_deactivated' end,
        'staff', new.user_id::text, new.display_name, null, null);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_admin_users on public.admin_users;
create trigger trg_audit_admin_users after insert or update or delete on public.admin_users
  for each row execute function private.audit_admin_users();

-- internal property data: which fields changed, never the values
create or replace function private.audit_property_internal()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare keys text[];
begin
  keys := private.changed_keys(case when tg_op <> 'INSERT' then to_jsonb(old) end,
                               case when tg_op <> 'DELETE' then to_jsonb(new) end,
                               array['updated_at','updated_by','property_id']);
  if coalesce(array_length(keys, 1), 0) > 0 then
    perform private.audit_write('internal_data_changed', 'property',
      coalesce(new.property_id, old.property_id)::text, array_to_string(keys, ', '), null, null);
  end if;
  return null;
end $$;
drop trigger if exists trg_audit_property_internal on public.property_internal;
create trigger trg_audit_property_internal after insert or update or delete on public.property_internal
  for each row execute function private.audit_property_internal();

-- CSV exports of personal data are recorded too.
create or replace function public.log_lead_export(p_count int, p_filters jsonb default '{}'::jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.has_admin_role(array['super_admin','admin','sales']) then
    raise exception 'Your role cannot export leads.' using errcode = '42501';
  end if;
  perform private.audit_write('leads_exported', 'lead', null, p_count || ' rows', null,
    jsonb_build_object('rows', p_count, 'filters', coalesce(p_filters, '{}'::jsonb)));
end $$;
revoke all on function public.log_lead_export(int, jsonb) from public, anon;
grant execute on function public.log_lead_export(int, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 9. STORAGE
-- ---------------------------------------------------------------------
-- 9a. property-images: every write needs a safe file name inside the
--     folder of an existing property. Admins may additionally delete
--     orphaned files (folders of deleted properties) during clean-up.
drop policy if exists "editors upload property images" on storage.objects;
drop policy if exists "editors update property images" on storage.objects;
drop policy if exists "editors delete property images" on storage.objects;

create policy "editors upload property images"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'property-images'
    and public.has_admin_role(array['super_admin','admin','editor'])
    and public.is_valid_property_image_path(name)
    and exists (select 1 from public.properties p where p.id::text = split_part(name, '/', 1))
  );

create policy "editors update property images"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'property-images'
    and public.has_admin_role(array['super_admin','admin','editor'])
    and exists (select 1 from public.properties p where p.id::text = split_part(name, '/', 1))
  )
  with check (
    bucket_id = 'property-images'
    and public.has_admin_role(array['super_admin','admin','editor'])
    and public.is_valid_property_image_path(name)
    and exists (select 1 from public.properties p where p.id::text = split_part(name, '/', 1))
  );

create policy "editors delete property images"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'property-images'
    and (
      public.has_admin_role(array['super_admin','admin'])
      or (public.has_admin_role(array['editor'])
          and exists (select 1 from public.properties p where p.id::text = split_part(name, '/', 1)))
    )
  );

-- 9b. Clean-up queue: a deleted image record queues its file. The admin
--     panel deletes the file and then resolves the entry; anything left
--     here is a failed clean-up an admin can retry from Media.
create table if not exists public.storage_cleanup_queue (
  bucket_id   text not null default 'property-images',
  object_path text not null,
  reason      text not null,
  queued_at   timestamptz not null default now(),
  attempts    int not null default 0,
  last_error  text,
  primary key (bucket_id, object_path)
);
alter table public.storage_cleanup_queue enable row level security;
revoke all on public.storage_cleanup_queue from anon;
drop policy if exists "editors read cleanup queue" on public.storage_cleanup_queue;
create policy "editors read cleanup queue" on public.storage_cleanup_queue for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor']));

create or replace function public.queue_image_file_cleanup()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if coalesce(old.storage_path, '') <> ''
     and not exists (select 1 from public.property_images where storage_path = old.storage_path) then
    insert into public.storage_cleanup_queue (bucket_id, object_path, reason)
    values ('property-images', old.storage_path, 'image record deleted')
    on conflict (bucket_id, object_path) do nothing;
  end if;
  return null;
end $$;
drop trigger if exists trg_queue_image_file_cleanup on public.property_images;
create trigger trg_queue_image_file_cleanup
  after delete on public.property_images
  for each row execute function public.queue_image_file_cleanup();

-- Removes queue entries ONLY for files that are really gone from Storage.
create or replace function public.resolve_storage_cleanup(p_paths text[])
returns int
language plpgsql security definer
set search_path = public, storage
as $$
declare n int;
begin
  if not public.has_admin_role(array['super_admin','admin','editor']) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  delete from public.storage_cleanup_queue q
   where q.bucket_id = 'property-images'
     and q.object_path = any(p_paths)
     and not exists (select 1 from storage.objects o where o.bucket_id = 'property-images' and o.name = q.object_path);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.resolve_storage_cleanup(text[]) from public, anon;
grant execute on function public.resolve_storage_cleanup(text[]) to authenticated;

create or replace function public.report_storage_cleanup_failure(p_path text, p_error text)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if not public.has_admin_role(array['super_admin','admin','editor']) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  update public.storage_cleanup_queue
     set attempts = attempts + 1, last_error = left(p_error, 300)
   where bucket_id = 'property-images' and object_path = p_path;
end $$;
revoke all on function public.report_storage_cleanup_failure(text, text) from public, anon;
grant execute on function public.report_storage_cleanup_failure(text, text) to authenticated;

-- Admin report: queued clean-ups, files no record points to (older than
-- an hour, so uploads in progress are ignored) and records whose file is
-- missing. Read-only.
create or replace function public.storage_orphan_report()
returns jsonb
language plpgsql stable security definer
set search_path = public, storage
as $$
begin
  if not public.has_admin_role(array['super_admin','admin']) then
    raise exception 'Only an admin can view the storage report.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'queued', coalesce((select jsonb_agg(jsonb_build_object('path', object_path, 'reason', reason,
                         'attempts', attempts, 'last_error', last_error, 'queued_at', queued_at) order by queued_at)
                        from public.storage_cleanup_queue where bucket_id = 'property-images'), '[]'::jsonb),
    'unreferenced_files', coalesce((select jsonb_agg(o.name order by o.name)
                        from storage.objects o
                       where o.bucket_id = 'property-images'
                         and o.created_at < now() - interval '1 hour'
                         and not exists (select 1 from public.property_images i where i.storage_path = o.name)
                         and not exists (select 1 from public.storage_cleanup_queue q
                                          where q.bucket_id = 'property-images' and q.object_path = o.name)), '[]'::jsonb),
    'missing_files', coalesce((select jsonb_agg(jsonb_build_object('image_id', i.id, 'property_id', i.property_id,
                         'path', i.storage_path) order by i.storage_path)
                        from public.property_images i
                       where coalesce(i.storage_path, '') <> ''
                         and not exists (select 1 from storage.objects o
                                          where o.bucket_id = 'property-images' and o.name = i.storage_path)), '[]'::jsonb),
    'legacy_paths', coalesce((select jsonb_agg(jsonb_build_object('image_id', i.id, 'path', i.storage_path) order by i.storage_path)
                        from public.property_images i
                       where coalesce(i.storage_path, '') <> ''
                         and not public.is_valid_property_image_path(i.storage_path)), '[]'::jsonb)
  );
end $$;
revoke all on function public.storage_orphan_report() from public, anon;
grant execute on function public.storage_orphan_report() to authenticated;

-- 9c. site-media: public bucket for branding / founder / homepage /
--     general images (logo, founder photo, share images). Public by
--     design — these are shown on the public site. Only admins write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-media', 'site-media', true, 5242880, array['image/jpeg','image/png','image/webp','image/avif'])
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.is_valid_site_media_path(p text)
returns boolean
language sql immutable
as $$
  select coalesce(p, '') ~ '^(branding|founder|homepage|general)/[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
     and coalesce(p, '') !~ '\.\.'
     and lower(coalesce(p, '')) ~ '\.(jpe?g|png|webp|avif)$'
$$;

drop policy if exists "staff list site media" on storage.objects;
drop policy if exists "admins upload site media" on storage.objects;
drop policy if exists "admins update site media" on storage.objects;
drop policy if exists "admins delete site media" on storage.objects;
create policy "staff list site media" on storage.objects for select to authenticated
  using (bucket_id = 'site-media' and public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));
create policy "admins upload site media" on storage.objects for insert to authenticated
  with check (bucket_id = 'site-media' and public.has_admin_role(array['super_admin','admin'])
              and public.is_valid_site_media_path(name));
create policy "admins update site media" on storage.objects for update to authenticated
  using (bucket_id = 'site-media' and public.has_admin_role(array['super_admin','admin']))
  with check (bucket_id = 'site-media' and public.has_admin_role(array['super_admin','admin'])
              and public.is_valid_site_media_path(name));
create policy "admins delete site media" on storage.objects for delete to authenticated
  using (bucket_id = 'site-media' and public.has_admin_role(array['super_admin','admin']));

create table if not exists public.media_assets (
  id           uuid primary key default gen_random_uuid(),
  category     text not null check (category in ('branding','founder','homepage','general')),
  storage_path text not null unique,
  public_url   text not null,
  title        text check (title is null or char_length(title) <= 120),
  alt_text     text check (alt_text is null or char_length(alt_text) <= 200),
  mime_type    text,
  size_bytes   int,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  constraint media_assets_path check (public.is_valid_site_media_path(storage_path)),
  constraint media_assets_category_matches check (split_part(storage_path, '/', 1) = category)
);
alter table public.media_assets enable row level security;
revoke all on public.media_assets from anon;
drop policy if exists "staff read media assets" on public.media_assets;
drop policy if exists "admins write media assets" on public.media_assets;
create policy "staff read media assets" on public.media_assets for select to authenticated
  using (public.has_admin_role(array['super_admin','admin','editor','sales','viewer']));
create policy "admins write media assets" on public.media_assets for all to authenticated
  using (public.has_admin_role(array['super_admin','admin']))
  with check (public.has_admin_role(array['super_admin','admin']));

create or replace function public.prepare_media_asset()
returns trigger language plpgsql set search_path = public as $$
begin
  new.public_url := '/media/site-media/' || new.storage_path;   -- served by the site's Worker
  if tg_op = 'INSERT' then new.uploaded_by := auth.uid(); end if;
  return new;
end $$;
drop trigger if exists trg_prepare_media_asset on public.media_assets;
create trigger trg_prepare_media_asset before insert or update on public.media_assets
  for each row execute function public.prepare_media_asset();

-- ---------------------------------------------------------------------
-- 10. CACHE VERSION (public; bumped on every public-content change)
-- ---------------------------------------------------------------------
create table if not exists public.site_cache_state (
  id         int primary key default 1 check (id = 1),
  version    bigint not null default 1,
  updated_at timestamptz not null default now()
);
-- Starts from the clock (not 1) so a rebuilt or restored database never
-- reuses version numbers whose cached pages belong to different data.
insert into public.site_cache_state (id, version)
values (1, (extract(epoch from clock_timestamp()) * 1000)::bigint)
on conflict (id) do nothing;
alter table public.site_cache_state enable row level security;
drop policy if exists "public read cache version" on public.site_cache_state;
create policy "public read cache version" on public.site_cache_state for select using (true);

create or replace function private.bump_cache_version()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.site_cache_state set version = version + 1, updated_at = now() where id = 1;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['properties','property_images','settings','testimonials','property_slug_redirects'] loop
    execute format('drop trigger if exists trg_bump_cache_version on public.%I', t);
    execute format('create trigger trg_bump_cache_version after insert or update or delete on public.%I
                    for each statement execute function private.bump_cache_version()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 11. SETTINGS: new fields + server-side validation
-- ---------------------------------------------------------------------
alter table public.settings add column if not exists home_seo_title        text;
alter table public.settings add column if not exists home_seo_description  text;
alter table public.settings add column if not exists default_og_image_url  text;
alter table public.settings add column if not exists office_hours          text;

create or replace function public.validate_settings()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  f text;
  v text;
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  n jsonb := to_jsonb(new);
  url_fields text[] := array['logo_url','google_maps_url','instagram_url','facebook_url','youtube_url',
                             'founder_photo_url','default_og_image_url'];
  max_len jsonb := '{"company_name":120,"phone":25,"whatsapp":25,"email":254,"office_address":300,
                     "office_hours":120,"hero_heading":160,"hero_subheading":400,"hero_cta_text":40,
                     "default_seo_title":120,"default_seo_description":300,"home_seo_title":120,
                     "home_seo_description":300,"founder_name":80,"founder_designation":120}'::jsonb;
begin
  -- Only fields that are actually changing are checked, so an old value
  -- never blocks saving something else.
  foreach f in array url_fields loop
    v := n ->> f;
    if (o -> f) is distinct from (n -> f) and v is not null
       and v !~ '^(https://[^\s"''<>]+|/[A-Za-z0-9][^\s"''<>]*)$' then
      raise exception '%: enter a full https:// link (or a /path on this site).', f using errcode = '23514';
    end if;
  end loop;
  foreach f in array array['phone','whatsapp'] loop
    v := n ->> f;
    if (o -> f) is distinct from (n -> f) and v is not null
       and (v !~ '^\+?[0-9 ()\-.]+$' or char_length(regexp_replace(v, '\D', '', 'g')) not between 8 and 15) then
      raise exception '%: enter a phone number with 8–15 digits, e.g. +91 98400 00000.', f using errcode = '23514';
    end if;
  end loop;
  v := n ->> 'email';
  if (o -> 'email') is distinct from (n -> 'email') and v is not null
     and v !~* '^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$' then
    raise exception 'email: enter a valid email address.' using errcode = '23514';
  end if;
  for f in select jsonb_object_keys(max_len) loop
    if (o -> f) is distinct from (n -> f) and char_length(coalesce(n ->> f, '')) > (max_len ->> f)::int then
      raise exception '%: must be % characters or fewer.', f, max_len ->> f using errcode = '23514';
    end if;
  end loop;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_validate_settings on public.settings;
create trigger trg_validate_settings before update on public.settings
  for each row execute function public.validate_settings();

-- Testimonials: the photo/rating fields are now shown publicly, so the
-- photo link is validated like the others.
create or replace function public.validate_testimonial()
returns trigger language plpgsql set search_path = public as $$
begin
  if (tg_op = 'INSERT' or new.photo_url is distinct from old.photo_url) and new.photo_url is not null
     and new.photo_url !~ '^(https://[^\s"''<>]+|/[A-Za-z0-9][^\s"''<>]*)$' then
    raise exception 'Photo URL must be a full https:// link (or a /path on this site).' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists trg_validate_testimonial on public.testimonials;
create trigger trg_validate_testimonial before insert or update on public.testimonials
  for each row execute function public.validate_testimonial();

-- ---------------------------------------------------------------------
-- 12. DASHBOARD (one call; RLS still applies — security invoker)
-- ---------------------------------------------------------------------
create or replace function public.dashboard_stats()
returns jsonb
language plpgsql stable security invoker
set search_path = public
as $$
declare
  props jsonb;
  leads_j jsonb := null;
begin
  if not public.has_admin_role(array['super_admin','admin','editor','sales','viewer']) then
    raise exception 'Staff only.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'active',       count(*) filter (where is_published and not is_archived and status in ('Available','Under Offer')),
    'draft',        count(*) filter (where not is_published and not is_archived and review_status = 'draft'),
    'under_review', count(*) filter (where not is_published and not is_archived and review_status = 'under_review'),
    'approved',     count(*) filter (where not is_published and not is_archived and review_status = 'approved'),
    'published',    count(*) filter (where is_published and not is_archived),
    'under_offer',  count(*) filter (where not is_archived and status = 'Under Offer'),
    'sold',         count(*) filter (where not is_archived and status = 'Sold'),
    'rented',       count(*) filter (where not is_archived and status = 'Rented'),
    'leased',       count(*) filter (where not is_archived and status = 'Leased'),
    'archived',     count(*) filter (where is_archived)
  ) into props from public.properties;

  if public.has_admin_role(array['super_admin','admin','sales']) then
    select jsonb_build_object(
      'by_status', coalesce((select jsonb_object_agg(status, n) from
                     (select status, count(*) n from public.leads where not is_archived group by status) s), '{}'::jsonb),
      'by_source', coalesce((select jsonb_object_agg(source, n) from
                     (select source, count(*) n from public.leads where not is_archived group by source) s), '{}'::jsonb),
      'open',      (select count(*) from public.leads where not is_archived),
      'follow_ups_due', (select count(*) from public.leads where not is_archived and follow_up_date <= current_date + 7
                          and status not in ('Closed','Not Interested')),
      'follow_ups_overdue', (select count(*) from public.leads where not is_archived and follow_up_date < current_date
                          and status not in ('Closed','Not Interested')),
      'mine',      (select count(*) from public.leads where not is_archived and assigned_to = auth.uid())
    ) into leads_j;
  end if;
  return jsonb_build_object('properties', props, 'leads', leads_j);
end $$;
revoke all on function public.dashboard_stats() from public, anon;
grant execute on function public.dashboard_stats() to authenticated;

commit;
