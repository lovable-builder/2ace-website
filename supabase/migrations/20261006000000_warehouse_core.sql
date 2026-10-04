-- Phase B: warehouse core. Locations, products, inbound bookings, receiving, putaway, an append-only stock ledger.
-- Same rules as Phase A: nobody writes tables directly. Every change goes through a SECURITY DEFINER function that checks who is
-- calling, validates, and writes the audit row in the same transaction. Every tenant row carries org_id.

-- ---------- internal helpers (not callable by clients) ----------
-- Raises unless the caller is active staff in one of the roles. Returns the role.
create or replace function public.wms_staff(variadic roles text[]) returns text
language plpgsql stable security definer set search_path = '' as $$
declare r text := public.staff_role();
begin
  if r is null or not (r = any(roles)) then raise exception 'You do not have permission to do this' using errcode = '42501'; end if;
  return r;
end $$;

-- Staff (any role) or a member of the organization who may handle stock. Returns 'admin'/'support'/'warehouse' or 'customer'.
create or replace function public.wms_org_access(p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare r text := public.staff_role();
begin
  if r is not null then return r; end if;
  if auth.uid() is not null and exists (select 1 from public.members m where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner','operations','staff')) then
    return 'customer';
  end if;
  raise exception 'You do not have permission to do this' using errcode = '42501';
end $$;

create or replace function public.wms_audit(p_role text, p_action text, p_entity text, p_id text, p_org uuid, p_after jsonb, p_reason text default null) returns void
language sql security definer set search_path = '' as $$
  select public.audit_write(auth.uid(), p_role, p_action, p_entity, p_id, p_org, null, p_after, p_reason, null);
$$;

-- ---------- locations ----------
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,29}$'),   -- this is what the printed barcode encodes
  kind text not null check (kind in ('receiving','bin','pallet','pack','returns','quarantine','shipping')),
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.locations enable row level security;

-- A bin or pallet slot is dedicated to one customer while an assignment is open. This is what we bill storage from.
create table public.location_assignments (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  org_id uuid not null references public.organizations(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  assigned_by uuid references auth.users(id)
);
create unique index location_one_open_assignment on public.location_assignments (location_id) where released_at is null;
create index location_assignments_org_idx on public.location_assignments (org_id) where released_at is null;
alter table public.location_assignments enable row level security;

-- ---------- products ----------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  sku text not null check (length(sku) between 1 and 60),
  name text not null check (length(name) between 1 and 200),
  length_cm numeric check (length_cm > 0), width_cm numeric check (width_cm > 0), height_cm numeric check (height_cm > 0),
  weight_g integer check (weight_g > 0),
  hs_code text, origin_country text,
  tracks_lot boolean not null default false,
  tracks_expiry boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, sku)
);
alter table public.products enable row level security;

create table public.product_barcodes (
  org_id uuid not null references public.organizations(id) on delete cascade,
  barcode text not null check (barcode ~ '^[0-9A-Za-z._-]{4,40}$'),
  product_id uuid not null references public.products(id) on delete cascade,
  primary key (org_id, barcode)
);
alter table public.product_barcodes enable row level security;

-- ---------- inbound ----------
create sequence public.inbound_seq;
create table public.inbound_bookings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  ref text not null unique default ('IN-' || lpad(nextval('public.inbound_seq')::text, 6, '0')),
  carrier text, tracking text, expected_date date, notes text,
  status text not null default 'booked' check (status in ('booked','receiving','received','cancelled')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  received_at timestamptz
);
create index inbound_bookings_status_idx on public.inbound_bookings (status, expected_date);
create index inbound_bookings_org_idx on public.inbound_bookings (org_id);
alter table public.inbound_bookings enable row level security;

create table public.inbound_lines (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.inbound_bookings(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  expected_qty integer not null check (expected_qty > 0),
  unique (booking_id, product_id)
);
alter table public.inbound_lines enable row level security;

create table public.receipt_lines (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.inbound_bookings(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  qty integer not null check (qty > 0),
  condition text not null check (condition in ('good','damaged','unexpected')),
  lot text not null default '', expiry date, note text,
  received_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  movement_id bigint
);
create index receipt_lines_booking_idx on public.receipt_lines (booking_id);
alter table public.receipt_lines enable row level security;

create table public.discrepancies (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.inbound_bookings(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  product_id uuid not null references public.products(id),
  kind text not null check (kind in ('short','over','damaged','unexpected')),
  expected_qty integer not null default 0, received_qty integer not null default 0,
  status text not null default 'open' check (status in ('open','resolved')),
  resolution text, resolved_by uuid references auth.users(id), resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index discrepancies_open_idx on public.discrepancies (status, created_at);
alter table public.discrepancies enable row level security;

-- ---------- the stock ledger ----------
-- Every change in stock is one row here, never edited, never deleted. stock_levels is just the running total, kept by trigger
-- in the same transaction, so the two can never disagree.
create table public.stock_movements (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  org_id uuid not null references public.organizations(id),
  product_id uuid not null references public.products(id),
  location_id uuid not null references public.locations(id),
  qty integer not null check (qty <> 0),
  reason text not null check (reason in ('receive','putaway','adjust')),
  ref_type text, ref_id text,
  lot text not null default '', expiry date,
  idempotency_key text unique,                  -- a repeated scan or double click posts nothing the second time
  actor_id uuid references auth.users(id),
  note text
);
create index stock_movements_product_idx on public.stock_movements (org_id, product_id, at desc);
create index stock_movements_location_idx on public.stock_movements (location_id);
alter table public.stock_movements enable row level security;

create table public.stock_levels (
  org_id uuid not null references public.organizations(id),
  product_id uuid not null references public.products(id),
  location_id uuid not null references public.locations(id),
  lot text not null default '',
  on_hand integer not null default 0 check (on_hand >= 0),
  reserved integer not null default 0 check (reserved >= 0),   -- used by orders in the next phase
  expiry date,
  updated_at timestamptz not null default now(),
  primary key (org_id, product_id, location_id, lot),
  check (reserved <= on_hand)
);
create index stock_levels_location_idx on public.stock_levels (location_id);
alter table public.stock_levels enable row level security;

create or replace function public.stock_block_change() returns trigger language plpgsql as $$
begin raise exception 'stock_movements is append-only: post a new movement instead'; end $$;
create trigger stock_movements_no_update before update or delete on public.stock_movements for each row execute function public.stock_block_change();
create trigger stock_movements_no_truncate before truncate on public.stock_movements for each statement execute function public.stock_block_change();

-- Rules every movement must satisfy, whichever function posted it.
create or replace function public.stock_movement_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p_org uuid; l public.locations;
begin
  select org_id into p_org from public.products where id = new.product_id;
  if p_org is distinct from new.org_id then raise exception 'That product does not belong to this customer'; end if;
  select * into l from public.locations where id = new.location_id;
  if not l.active then raise exception 'Location % is switched off', l.code; end if;
  if l.kind in ('bin','pallet') and not exists (
    select 1 from public.location_assignments a where a.location_id = l.id and a.org_id = new.org_id and a.released_at is null
  ) then raise exception 'Location % is not assigned to this customer', l.code; end if;
  return new;
end $$;
create trigger stock_movements_check before insert on public.stock_movements for each row execute function public.stock_movement_check();

create or replace function public.stock_apply() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Update first: an INSERT ... ON CONFLICT would check "on_hand >= 0" on the proposed row before noticing the row exists.
  for i in 1..2 loop
    update public.stock_levels set on_hand = on_hand + new.qty, updated_at = now(), expiry = coalesce(expiry, new.expiry)
     where org_id = new.org_id and product_id = new.product_id and location_id = new.location_id and lot = new.lot;
    if found then return new; end if;
    begin
      insert into public.stock_levels (org_id, product_id, location_id, lot, on_hand, expiry) values (new.org_id, new.product_id, new.location_id, new.lot, new.qty, new.expiry);
      return new;
    exception when unique_violation then null;   -- someone created the row a moment ago: go round and update it
    end;
  end loop;
  raise exception 'Could not update stock level';
end $$;
create trigger stock_movements_apply after insert on public.stock_movements for each row execute function public.stock_apply();

-- Post one movement. A repeated idempotency key returns the first movement's id and changes nothing.
create or replace function public.wms_post(
  p_org uuid, p_product uuid, p_loc uuid, p_qty integer, p_reason text, p_ref_type text, p_ref_id text,
  p_lot text, p_expiry date, p_key text, p_note text
) returns bigint language plpgsql security definer set search_path = '' as $$
declare mid bigint;
begin
  insert into public.stock_movements (org_id, product_id, location_id, qty, reason, ref_type, ref_id, lot, expiry, idempotency_key, actor_id, note)
  values (p_org, p_product, p_loc, p_qty, p_reason, p_ref_type, p_ref_id, coalesce(p_lot, ''), p_expiry, p_key, auth.uid(), p_note)
  on conflict (idempotency_key) do nothing returning id into mid;
  if mid is null then select id into mid from public.stock_movements where idempotency_key = p_key; end if;
  return mid;
end $$;

revoke all on function public.wms_staff(text[]), public.wms_org_access(uuid), public.wms_audit(text,text,text,text,uuid,jsonb,text),
  public.wms_post(uuid,uuid,uuid,integer,text,text,text,text,date,text,text) from public, anon, authenticated;

-- ---------- reading (RLS) ----------
-- Staff see every warehouse table. Customers see only their own organization's rows.
create policy "staff read locations" on public.locations for select using (public.has_staff_role('admin','support','warehouse'));
create policy "members read shared and own locations" on public.locations for select using (
  kind in ('receiving','quarantine') or exists (select 1 from public.location_assignments a where a.location_id = locations.id and a.released_at is null and public.is_member(a.org_id)));
create policy "staff read assignments" on public.location_assignments for select using (public.has_staff_role('admin','support','warehouse'));
create policy "members read own assignments" on public.location_assignments for select using (public.is_member(org_id));
do $$ declare t text; begin
  foreach t in array array['products','product_barcodes','inbound_bookings','inbound_lines','receipt_lines','discrepancies','stock_movements','stock_levels'] loop
    execute format('create policy "staff read %1$s" on public.%1$s for select using (public.has_staff_role(''admin'',''support'',''warehouse''))', t);
    execute format('create policy "members read own %1$s" on public.%1$s for select using (public.is_member(org_id))', t);
  end loop;
  foreach t in array array['locations','location_assignments','products','product_barcodes','inbound_bookings','inbound_lines','receipt_lines','discrepancies','stock_movements','stock_levels'] loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- What a customer sees per product. security_invoker: the caller's own RLS applies.
create or replace view public.v_inventory_by_product with (security_invoker = true) as
select p.id as product_id, p.org_id, p.sku, p.name, p.active,
  coalesce(sum(sl.on_hand), 0)::int as on_hand,
  coalesce(sum(sl.reserved), 0)::int as reserved,
  (coalesce(sum(sl.on_hand), 0) - coalesce(sum(sl.reserved), 0))::int as available,
  coalesce(sum(sl.on_hand) filter (where l.kind = 'receiving'), 0)::int as unplaced,
  coalesce(sum(sl.on_hand) filter (where l.kind = 'quarantine'), 0)::int as quarantined,
  (select coalesce(sum(il.expected_qty), 0) from public.inbound_lines il join public.inbound_bookings b on b.id = il.booking_id
     where il.product_id = p.id and b.status in ('booked','receiving'))::int as incoming
from public.products p
left join public.stock_levels sl on sl.product_id = p.id
left join public.locations l on l.id = sl.location_id
group by p.id;
grant select on public.v_inventory_by_product to authenticated;

-- ---------- locations ----------
create or replace function public.create_location(p_code text, p_kind text, p_label text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); v_code text := upper(btrim(coalesce(p_code, ''))); v_id uuid;
begin
  if v_code !~ '^[A-Z0-9][A-Z0-9._-]{0,29}$' then raise exception 'Use letters, numbers, dot, dash or underscore (up to 30 characters)'; end if;
  if p_kind not in ('receiving','bin','pallet','pack','returns','quarantine','shipping') then raise exception 'Choose a location type'; end if;
  if exists (select 1 from public.locations where locations.code = v_code) then raise exception 'A location with code % already exists', v_code; end if;
  insert into public.locations (code, kind, label) values (v_code, p_kind, nullif(left(btrim(coalesce(p_label, '')), 100), '')) returning locations.id into v_id;
  perform public.wms_audit(r, 'location.create', 'locations', v_id::text, null, jsonb_build_object('code', v_code, 'kind', p_kind));
  return v_id;
end $$;

create or replace function public.set_location_active(p_location uuid, p_active boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); l public.locations;
begin
  select * into l from public.locations where id = p_location for update;
  if not found then raise exception 'Location not found'; end if;
  if not p_active and exists (select 1 from public.stock_levels where location_id = p_location and on_hand > 0) then raise exception 'Location % still holds stock. Move it first.', l.code; end if;
  if not p_active and exists (select 1 from public.location_assignments where location_id = p_location and released_at is null) then raise exception 'Location % is assigned to a customer. Release it first.', l.code; end if;
  update public.locations set active = p_active where id = p_location;
  perform public.wms_audit(r, 'location.set_active', 'locations', p_location::text, null, jsonb_build_object('code', l.code, 'active', p_active));
end $$;

create or replace function public.assign_location(p_location uuid, p_org uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); l public.locations; cur public.location_assignments;
begin
  select * into l from public.locations where id = p_location for update;
  if not found or not l.active then raise exception 'Location not found or switched off'; end if;
  if l.kind not in ('bin','pallet') then raise exception 'Only bins and pallet slots can be assigned to a customer'; end if;
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Customer not found'; end if;
  select * into cur from public.location_assignments where location_id = p_location and released_at is null;
  if found then
    if cur.org_id = p_org then return; end if;
    if exists (select 1 from public.stock_levels where location_id = p_location and on_hand > 0) then raise exception 'Location % still holds another customer''s stock', l.code; end if;
    update public.location_assignments set released_at = now() where id = cur.id;
  end if;
  insert into public.location_assignments (location_id, org_id, assigned_by) values (p_location, p_org, auth.uid());
  perform public.wms_audit(r, 'location.assign', 'locations', p_location::text, p_org, jsonb_build_object('code', l.code));
end $$;

create or replace function public.release_location(p_location uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); cur public.location_assignments; l public.locations;
begin
  select * into l from public.locations where id = p_location for update;
  select * into cur from public.location_assignments where location_id = p_location and released_at is null;
  if not found then return; end if;
  if exists (select 1 from public.stock_levels where location_id = p_location and on_hand > 0) then raise exception 'Location % still holds stock. Move it first.', l.code; end if;
  update public.location_assignments set released_at = now() where id = cur.id;
  perform public.wms_audit(r, 'location.release', 'locations', p_location::text, cur.org_id, jsonb_build_object('code', l.code));
end $$;

-- ---------- products ----------
create or replace function public.create_product(
  p_org uuid, p_sku text, p_name text, p_ean text default null,
  p_length_cm numeric default null, p_width_cm numeric default null, p_height_cm numeric default null, p_weight_g integer default null,
  p_hs_code text default null, p_origin_country text default null, p_tracks_lot boolean default false, p_tracks_expiry boolean default false
) returns uuid language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_org_access(p_org); v_id uuid; v_sku text := btrim(coalesce(p_sku, '')); v_nm text := btrim(coalesce(p_name, '')); v_ean text := nullif(btrim(coalesce(p_ean, '')), '');
begin
  if v_sku = '' or length(v_sku) > 60 then raise exception 'SKU is required (up to 60 characters)'; end if;
  if v_nm = '' then raise exception 'Product name is required'; end if;
  if v_ean is not null and v_ean !~ '^[0-9A-Za-z._-]{4,40}$' then raise exception 'Barcode looks wrong. Use 4 to 40 letters or digits.'; end if;
  if exists (select 1 from public.products where org_id = p_org and products.sku = v_sku) then raise exception 'You already have a product with SKU %', v_sku; end if;
  if v_ean is not null and exists (select 1 from public.product_barcodes where org_id = p_org and barcode = v_ean) then raise exception 'That barcode is already used by another product'; end if;
  insert into public.products (org_id, sku, name, length_cm, width_cm, height_cm, weight_g, hs_code, origin_country, tracks_lot, tracks_expiry)
  values (p_org, v_sku, left(v_nm, 200), p_length_cm, p_width_cm, p_height_cm, p_weight_g,
          nullif(left(btrim(coalesce(p_hs_code, '')), 20), ''), nullif(left(upper(btrim(coalesce(p_origin_country, ''))), 2), ''), coalesce(p_tracks_lot, false), coalesce(p_tracks_expiry, false))
  returning products.id into v_id;
  if v_ean is not null then insert into public.product_barcodes (org_id, barcode, product_id) values (p_org, v_ean, v_id); end if;
  perform public.wms_audit(r, 'product.create', 'products', v_id::text, p_org, jsonb_build_object('sku', v_sku, 'name', v_nm));
  return v_id;
end $$;

create or replace function public.update_product(p_id uuid, p_patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text;
begin
  select * into p from public.products where id = p_id for update;
  if not found then raise exception 'Product not found'; end if;
  r := public.wms_org_access(p.org_id);
  update public.products set
    name = case when p_patch ? 'name' then left(btrim(p_patch->>'name'), 200) else name end,
    length_cm = case when p_patch ? 'length_cm' then (p_patch->>'length_cm')::numeric else length_cm end,
    width_cm = case when p_patch ? 'width_cm' then (p_patch->>'width_cm')::numeric else width_cm end,
    height_cm = case when p_patch ? 'height_cm' then (p_patch->>'height_cm')::numeric else height_cm end,
    weight_g = case when p_patch ? 'weight_g' then (p_patch->>'weight_g')::integer else weight_g end,
    hs_code = case when p_patch ? 'hs_code' then nullif(left(btrim(p_patch->>'hs_code'), 20), '') else hs_code end,
    origin_country = case when p_patch ? 'origin_country' then nullif(left(upper(btrim(p_patch->>'origin_country')), 2), '') else origin_country end,
    tracks_lot = case when p_patch ? 'tracks_lot' then (p_patch->>'tracks_lot')::boolean else tracks_lot end,
    tracks_expiry = case when p_patch ? 'tracks_expiry' then (p_patch->>'tracks_expiry')::boolean else tracks_expiry end,
    active = case when p_patch ? 'active' then (p_patch->>'active')::boolean else active end
  where id = p_id;
  perform public.wms_audit(r, 'product.update', 'products', p_id::text, p.org_id, p_patch);
end $$;

create or replace function public.add_product_barcode(p_product uuid, p_barcode text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text; b text := btrim(coalesce(p_barcode, ''));
begin
  select * into p from public.products where id = p_product;
  if not found then raise exception 'Product not found'; end if;
  r := public.wms_org_access(p.org_id);
  if b !~ '^[0-9A-Za-z._-]{4,40}$' then raise exception 'Barcode looks wrong. Use 4 to 40 letters or digits.'; end if;
  if exists (select 1 from public.product_barcodes where org_id = p.org_id and barcode = b) then raise exception 'That barcode is already in use'; end if;
  insert into public.product_barcodes (org_id, barcode, product_id) values (p.org_id, b, p_product);
  perform public.wms_audit(r, 'product.add_barcode', 'products', p_product::text, p.org_id, jsonb_build_object('barcode', b));
end $$;

-- ---------- inbound ----------
create or replace function public.book_inbound(
  p_org uuid, p_carrier text, p_tracking text, p_expected date, p_notes text, p_lines jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_org_access(p_org); bid uuid; ln jsonb; q integer; pid uuid; seen uuid[] := '{}';
begin
  if r = 'customer' and not exists (select 1 from public.organizations where id = p_org and status = 'active') then raise exception 'Your plan is not active yet'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one product'; end if;
  if jsonb_array_length(p_lines) > 200 then raise exception 'Too many lines in one delivery (200 maximum)'; end if;
  insert into public.inbound_bookings (org_id, carrier, tracking, expected_date, notes, created_by)
  values (p_org, nullif(left(btrim(coalesce(p_carrier, '')), 80), ''), nullif(left(btrim(coalesce(p_tracking, '')), 120), ''), p_expected, nullif(left(btrim(coalesce(p_notes, '')), 1000), ''), auth.uid())
  returning id into bid;
  for ln in select * from jsonb_array_elements(p_lines) loop
    pid := (ln->>'product_id')::uuid; q := (ln->>'qty')::integer;
    if q is null or q < 1 or q > 1000000 then raise exception 'Quantities must be between 1 and 1,000,000'; end if;
    if pid = any(seen) then raise exception 'Each product can appear once per delivery'; end if;
    if not exists (select 1 from public.products where id = pid and org_id = p_org and active) then raise exception 'A product on this delivery was not found or is switched off'; end if;
    seen := seen || pid;
    insert into public.inbound_lines (booking_id, org_id, product_id, expected_qty) values (bid, p_org, pid, q);
  end loop;
  perform public.wms_audit(r, 'inbound.book', 'inbound_bookings', bid::text, p_org, jsonb_build_object('lines', jsonb_array_length(p_lines)));
  return bid;
end $$;

create or replace function public.cancel_inbound(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.inbound_bookings; r text;
begin
  select * into b from public.inbound_bookings where id = p_id for update;
  if not found then raise exception 'Delivery not found'; end if;
  r := public.wms_org_access(b.org_id);
  if b.status <> 'booked' then raise exception 'Only a delivery that has not arrived yet can be cancelled'; end if;
  update public.inbound_bookings set status = 'cancelled' where id = p_id;
  perform public.wms_audit(r, 'inbound.cancel', 'inbound_bookings', p_id::text, b.org_id, jsonb_build_object('ref', b.ref));
end $$;

-- Receive one line. good and unexpected goods enter the receiving area; damaged goods go to quarantine.
create or replace function public.receive_line(
  p_booking uuid, p_product uuid, p_qty integer, p_condition text, p_lot text default '', p_expiry date default null, p_note text default null, p_key text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); b public.inbound_bookings; pr public.products; cond text := p_condition; loc uuid; mid bigint; lt text := coalesce(btrim(p_lot), '');
begin
  select * into b from public.inbound_bookings where id = p_booking for update;
  if not found then raise exception 'Delivery not found'; end if;
  if b.status not in ('booked','receiving') then raise exception 'This delivery is already %', b.status; end if;
  select * into pr from public.products where id = p_product and org_id = b.org_id;
  if not found then raise exception 'That product does not belong to this customer'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 1000000 then raise exception 'Enter a quantity of at least 1'; end if;
  if cond not in ('good','damaged','unexpected') then raise exception 'Choose good or damaged'; end if;
  if cond = 'good' and not exists (select 1 from public.inbound_lines where booking_id = p_booking and product_id = p_product) then cond := 'unexpected'; end if;
  if pr.tracks_lot and lt = '' then raise exception 'This product needs a lot number'; end if;
  if pr.tracks_expiry and p_expiry is null then raise exception 'This product needs an expiry date'; end if;
  select id into loc from public.locations where active and kind = (case when cond = 'damaged' then 'quarantine' else 'receiving' end) order by code limit 1;
  if loc is null then raise exception 'There is no active % location yet. Create one first.', case when cond = 'damaged' then 'quarantine' else 'receiving' end; end if;
  mid := public.wms_post(b.org_id, p_product, loc, p_qty, 'receive', 'inbound', p_booking::text, lt, p_expiry, p_key, p_note);
  if not exists (select 1 from public.receipt_lines where movement_id = mid) then
    insert into public.receipt_lines (booking_id, org_id, product_id, qty, condition, lot, expiry, note, received_by, movement_id)
    values (p_booking, b.org_id, p_product, p_qty, cond, lt, p_expiry, nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid(), mid);
    if b.status = 'booked' then update public.inbound_bookings set status = 'receiving' where id = p_booking; end if;
    perform public.wms_audit(r, 'inbound.receive_line', 'inbound_bookings', p_booking::text, b.org_id, jsonb_build_object('product', p_product, 'qty', p_qty, 'condition', cond));
  end if;
  return jsonb_build_object('movement_id', mid, 'condition', cond);
end $$;

-- Close receiving: compare what arrived with what was booked and open a discrepancy for every difference.
create or replace function public.receive_close(p_booking uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); b public.inbound_bookings; n integer := 0; x record; got integer;
begin
  select * into b from public.inbound_bookings where id = p_booking for update;
  if not found then raise exception 'Delivery not found'; end if;
  if b.status = 'received' then return jsonb_build_object('discrepancies', (select count(*) from public.discrepancies where booking_id = p_booking)); end if;
  if b.status not in ('booked','receiving') then raise exception 'This delivery is %', b.status; end if;
  for x in select il.product_id, il.expected_qty from public.inbound_lines il where il.booking_id = p_booking loop
    select coalesce(sum(qty), 0) into got from public.receipt_lines where booking_id = p_booking and product_id = x.product_id and condition = 'good';
    if got < x.expected_qty then insert into public.discrepancies (booking_id, org_id, product_id, kind, expected_qty, received_qty) values (p_booking, b.org_id, x.product_id, 'short', x.expected_qty, got); n := n + 1;
    elsif got > x.expected_qty then insert into public.discrepancies (booking_id, org_id, product_id, kind, expected_qty, received_qty) values (p_booking, b.org_id, x.product_id, 'over', x.expected_qty, got); n := n + 1; end if;
  end loop;
  for x in select product_id, condition, sum(qty)::int as q from public.receipt_lines where booking_id = p_booking and condition in ('damaged','unexpected') group by product_id, condition loop
    insert into public.discrepancies (booking_id, org_id, product_id, kind, expected_qty, received_qty) values (p_booking, b.org_id, x.product_id, x.condition, 0, x.q); n := n + 1;
  end loop;
  update public.inbound_bookings set status = 'received', received_at = now() where id = p_booking;
  perform public.wms_audit(r, 'inbound.close', 'inbound_bookings', p_booking::text, b.org_id, jsonb_build_object('ref', b.ref, 'discrepancies', n));
  return jsonb_build_object('discrepancies', n);
end $$;

create or replace function public.resolve_discrepancy(p_id uuid, p_resolution text) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); d public.discrepancies;
begin
  if length(btrim(coalesce(p_resolution, ''))) < 3 then raise exception 'Write what was decided'; end if;
  select * into d from public.discrepancies where id = p_id for update;
  if not found then raise exception 'Not found'; end if;
  if d.status = 'resolved' then return; end if;
  update public.discrepancies set status = 'resolved', resolution = left(btrim(p_resolution), 1000), resolved_by = auth.uid(), resolved_at = now() where id = p_id;
  perform public.wms_audit(r, 'discrepancy.resolve', 'discrepancies', p_id::text, d.org_id, jsonb_build_object('resolution', p_resolution));
end $$;

-- ---------- putaway and adjustments ----------
-- Move stock between two locations as one pair of ledger rows. Destination bins must be dedicated to this customer.
create or replace function public.putaway(
  p_org uuid, p_product uuid, p_from uuid, p_to uuid, p_qty integer, p_lot text default '', p_key text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); sl public.stock_levels; lt text := coalesce(btrim(p_lot), ''); lf public.locations; lt2 public.locations;
begin
  if p_key is not null and exists (select 1 from public.stock_movements where idempotency_key = p_key || ':out') then return; end if;   -- replayed scan
  if p_qty is null or p_qty < 1 then raise exception 'Enter a quantity of at least 1'; end if;
  if p_from = p_to then raise exception 'Choose a different destination'; end if;
  select * into lf from public.locations where id = p_from; select * into lt2 from public.locations where id = p_to;
  if lf.id is null or lt2.id is null then raise exception 'Location not found'; end if;
  if lt2.kind in ('receiving','shipping') then raise exception 'Stock cannot be moved into %', lt2.code; end if;
  select * into sl from public.stock_levels where org_id = p_org and product_id = p_product and location_id = p_from and lot = lt for update;
  if not found or sl.on_hand - sl.reserved < p_qty then raise exception 'Not enough free stock at % (have %)', lf.code, coalesce(sl.on_hand - sl.reserved, 0); end if;
  perform public.wms_post(p_org, p_product, p_from, -p_qty, 'putaway', 'putaway', p_to::text, lt, sl.expiry, case when p_key is null then null else p_key || ':out' end, null);
  perform public.wms_post(p_org, p_product, p_to, p_qty, 'putaway', 'putaway', p_from::text, lt, sl.expiry, case when p_key is null then null else p_key || ':in' end, null);
  perform public.wms_audit(r, 'stock.putaway', 'products', p_product::text, p_org, jsonb_build_object('from', lf.code, 'to', lt2.code, 'qty', p_qty));
end $$;

-- Counted differently from the books? Post the difference with a reason. Large changes need an admin.
create or replace function public.adjust_stock(
  p_org uuid, p_product uuid, p_location uuid, p_delta integer, p_reason text, p_lot text default '', p_key text default null
) returns void language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); sl public.stock_levels; lt text := coalesce(btrim(p_lot), ''); l public.locations; have integer;
begin
  if p_key is not null and exists (select 1 from public.stock_movements where idempotency_key = p_key) then return; end if;   -- replayed
  if p_delta is null or p_delta = 0 then raise exception 'The change cannot be zero'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'A reason is required'; end if;
  if abs(p_delta) > 20 and r <> 'admin' then raise exception 'Changes above 20 units need an admin'; end if;
  select * into l from public.locations where id = p_location;
  if not found then raise exception 'Location not found'; end if;
  select * into sl from public.stock_levels where org_id = p_org and product_id = p_product and location_id = p_location and lot = lt for update;
  have := coalesce(sl.on_hand, 0);
  if have + p_delta < 0 then raise exception 'That would leave negative stock at % (have %)', l.code, have; end if;
  if have + p_delta < coalesce(sl.reserved, 0) then raise exception 'Part of this stock is reserved for orders'; end if;
  perform public.wms_post(p_org, p_product, p_location, p_delta, 'adjust', 'adjustment', null, lt, null, p_key, left(btrim(p_reason), 500));
  perform public.wms_audit(r, 'stock.adjust', 'products', p_product::text, p_org, jsonb_build_object('location', l.code, 'delta', p_delta), btrim(p_reason));
end $$;

-- ---------- scan lookup: a barcode (location code, product barcode or SKU) -> what it is ----------
create or replace function public.wms_lookup(p_code text, p_org uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c text := btrim(coalesce(p_code, '')); l public.locations; pr record; asg uuid;
begin
  perform public.wms_staff('admin','warehouse','support');
  select * into l from public.locations where code = upper(c);
  if found then
    select org_id into asg from public.location_assignments where location_id = l.id and released_at is null;
    return jsonb_build_object('type', 'location', 'id', l.id, 'code', l.code, 'kind', l.kind, 'org_id', asg);
  end if;
  for pr in
    select p.id, p.org_id, p.sku, p.name from public.products p
    where (p_org is null or p.org_id = p_org) and (p.sku = c or exists (select 1 from public.product_barcodes b where b.product_id = p.id and b.barcode = c))
    limit 5
  loop
    return jsonb_build_object('type', 'product', 'id', pr.id, 'org_id', pr.org_id, 'sku', pr.sku, 'name', pr.name,
      'ambiguous', (select count(*) > 1 from public.products p2 where (p_org is null or p2.org_id = p_org) and (p2.sku = c or exists (select 1 from public.product_barcodes b2 where b2.product_id = p2.id and b2.barcode = c))));
  end loop;
  return jsonb_build_object('type', 'none');
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'create_location(text,text,text)', 'set_location_active(uuid,boolean)', 'assign_location(uuid,uuid)', 'release_location(uuid)',
    'create_product(uuid,text,text,text,numeric,numeric,numeric,integer,text,text,boolean,boolean)', 'update_product(uuid,jsonb)', 'add_product_barcode(uuid,text)',
    'book_inbound(uuid,text,text,date,text,jsonb)', 'cancel_inbound(uuid)',
    'receive_line(uuid,uuid,integer,text,text,date,text,text)', 'receive_close(uuid)', 'resolve_discrepancy(uuid,text)',
    'putaway(uuid,uuid,uuid,uuid,integer,text,text)', 'adjust_stock(uuid,uuid,uuid,integer,text,text,text)', 'wms_lookup(text,uuid)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Warehouse staff may not read the customers table, but they must pick a customer when assigning bins or receiving.
-- This hands out just id and name.
create or replace function public.wms_orgs() returns table (id uuid, name text, status text)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.status from public.organizations o where public.has_staff_role('admin','support','warehouse') order by o.name;
$$;
revoke all on function public.wms_orgs() from public, anon;
grant execute on function public.wms_orgs() to authenticated;
