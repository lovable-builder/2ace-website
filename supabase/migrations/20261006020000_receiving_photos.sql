-- Photos of damaged or wrong goods at receiving, kept in a private bucket, plus a flag so each discrepancy is announced only once.
alter table public.receipt_lines add column photo_paths text[] not null default '{}';
alter table public.discrepancies add column notified_at timestamptz;

-- Private bucket: files live at <org_id>/<booking_id>/<uuid>.<ext>. Staff upload; staff and the customer's own members read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receiving', 'receiving', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "warehouse staff add receiving photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'receiving' and public.has_staff_role('admin','warehouse')
    and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$');
create policy "staff and the owning customer read receiving photos" on storage.objects for select to authenticated
  using (bucket_id = 'receiving' and (
    public.has_staff_role('admin','support','warehouse')
    or case when (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$' then public.is_member(((storage.foldername(name))[1])::uuid) else false end));

-- receive_line now also returns the receipt line id, so photos can be attached to it.
create or replace function public.receive_line(
  p_booking uuid, p_product uuid, p_qty integer, p_condition text, p_lot text default '', p_expiry date default null, p_note text default null, p_key text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); b public.inbound_bookings; pr public.products; cond text := p_condition; loc uuid; mid bigint; lt text := coalesce(btrim(p_lot), ''); rid uuid;
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
  select id into rid from public.receipt_lines where movement_id = mid;
  if rid is null then
    insert into public.receipt_lines (booking_id, org_id, product_id, qty, condition, lot, expiry, note, received_by, movement_id)
    values (p_booking, b.org_id, p_product, p_qty, cond, lt, p_expiry, nullif(left(btrim(coalesce(p_note, '')), 500), ''), auth.uid(), mid) returning id into rid;
    if b.status = 'booked' then update public.inbound_bookings set status = 'receiving' where id = p_booking; end if;
    perform public.wms_audit(r, 'inbound.receive_line', 'inbound_bookings', p_booking::text, b.org_id, jsonb_build_object('product', p_product, 'qty', p_qty, 'condition', cond));
  end if;
  return jsonb_build_object('movement_id', mid, 'condition', cond, 'receipt_id', rid);
end $$;

-- Attach uploaded photos to a receipt line. Paths must sit under this delivery's own folder and exist in storage.
create or replace function public.add_receipt_photos(p_line uuid, p_paths text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); l public.receipt_lines; p text; pre text; merged text[];
begin
  select * into l from public.receipt_lines where id = p_line for update;
  if not found then raise exception 'Receipt line not found'; end if;
  pre := l.org_id::text || '/' || l.booking_id::text || '/';
  if p_paths is null or array_length(p_paths, 1) is null then return; end if;
  foreach p in array p_paths loop
    if left(p, length(pre)) <> pre or p !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$' then raise exception 'Invalid photo path'; end if;
    if not exists (select 1 from storage.objects where bucket_id = 'receiving' and name = p) then raise exception 'A photo was not uploaded'; end if;
  end loop;
  select array(select distinct x from unnest(l.photo_paths || p_paths) x) into merged;
  if array_length(merged, 1) > 8 then raise exception 'At most 8 photos per line'; end if;
  update public.receipt_lines set photo_paths = merged where id = p_line;
  perform public.wms_audit(r, 'inbound.add_photos', 'receipt_lines', p_line::text, l.org_id, jsonb_build_object('count', array_length(p_paths, 1)));
end $$;
revoke all on function public.add_receipt_photos(uuid, text[]) from public, anon;
grant execute on function public.add_receipt_photos(uuid, text[]) to authenticated;
