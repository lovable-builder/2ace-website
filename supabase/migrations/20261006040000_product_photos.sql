-- Product photos (up to 4 per product, the first is the thumbnail) in a private bucket. Photos describe a product, they do not move stock,
-- so the customer and staff can manage them directly (no approval queue).
alter table public.products add column photo_paths text[] not null default '{}';

-- Same view as before with the product's photo paths added at the end.
create or replace view public.v_inventory_by_product with (security_invoker = true) as
select p.id as product_id, p.org_id, p.sku, p.name, p.active,
  coalesce(sum(sl.on_hand), 0)::int as on_hand,
  coalesce(sum(sl.reserved), 0)::int as reserved,
  (coalesce(sum(sl.on_hand), 0) - coalesce(sum(sl.reserved), 0))::int as available,
  coalesce(sum(sl.on_hand) filter (where l.kind = 'receiving'), 0)::int as unplaced,
  coalesce(sum(sl.on_hand) filter (where l.kind = 'quarantine'), 0)::int as quarantined,
  (select coalesce(sum(il.expected_qty), 0) from public.inbound_lines il join public.inbound_bookings b on b.id = il.booking_id
     where il.product_id = p.id and b.status in ('booked','receiving'))::int as incoming,
  p.photo_paths
from public.products p
left join public.stock_levels sl on sl.product_id = p.id
left join public.locations l on l.id = sl.location_id
group by p.id;

-- Support is read-only in the warehouse. The screens already hide the buttons; this makes the database refuse too.
-- (wms_org_access guards every product and delivery write, so this covers create, edit, delete, book, cancel, requests and photos.)
create or replace function public.wms_org_access(p_org uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare r text := public.staff_role();
begin
  if r = 'support' then raise exception 'Support access is read-only' using errcode = '42501'; end if;
  if r is not null then return r; end if;
  if auth.uid() is not null and exists (select 1 from public.members m where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner','operations','staff')) then
    return 'customer';
  end if;
  raise exception 'You do not have permission to do this' using errcode = '42501';
end $$;

-- Who may add or remove files for an organization: warehouse/admin staff, or a member who handles stock.
create or replace function public.wms_can_write_org(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.has_staff_role('admin','warehouse')
    or exists (select 1 from public.members m where m.org_id = p_org and m.user_id = auth.uid() and m.role in ('owner','operations','staff'));
$$;
revoke all on function public.wms_can_write_org(uuid) from public, anon;
grant execute on function public.wms_can_write_org(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('products', 'products', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "product photos: add" on storage.objects for insert to authenticated
  with check (bucket_id = 'products' and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
    and public.wms_can_write_org(((storage.foldername(name))[1])::uuid));
create policy "product photos: remove" on storage.objects for delete to authenticated
  using (bucket_id = 'products' and name ~ '^[0-9a-f-]{36}/' and public.wms_can_write_org(((storage.foldername(name))[1])::uuid));
create policy "product photos: read" on storage.objects for select to authenticated
  using (bucket_id = 'products' and (
    public.has_staff_role('admin','support','warehouse')
    or case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end));

-- Set the product's photos (replaces the list, so removing one is just leaving it out). Paths must be this product's own uploads.
create or replace function public.set_product_photos(p_product uuid, p_paths text[]) returns text[]
language plpgsql security definer set search_path = '' as $$
declare p public.products; r text; pre text; x text; clean text[] := '{}'; removed text[];
begin
  select * into p from public.products where id = p_product for update;
  if not found then raise exception 'Product not found'; end if;
  r := public.wms_org_access(p.org_id);
  pre := p.org_id::text || '/' || p.id::text || '/';
  foreach x in array coalesce(p_paths, '{}') loop
    if left(x, length(pre)) <> pre or x !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' then raise exception 'Invalid photo path'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'products' and name = x) then raise exception 'A photo was not uploaded'; end if;
    if not (x = any(clean)) then clean := clean || x; end if;
  end loop;
  if coalesce(array_length(clean, 1), 0) > 4 then raise exception 'At most 4 photos per product'; end if;
  select array(select y from unnest(p.photo_paths) y where not (y = any(clean))) into removed;
  update public.products set photo_paths = clean where id = p_product;
  perform public.wms_audit(r, 'product.photos', 'products', p_product::text, p.org_id, jsonb_build_object('count', coalesce(array_length(clean, 1), 0)));
  return removed;   -- the caller deletes these files from storage
end $$;
revoke all on function public.set_product_photos(uuid, text[]) from public, anon;
grant execute on function public.set_product_photos(uuid, text[]) to authenticated;
