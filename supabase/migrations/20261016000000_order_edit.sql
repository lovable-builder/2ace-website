-- Fix an order's delivery details when they do not meet what a shipping label needs, and ask the customer for the correction.

-- Customers see why we asked (their order rows are readable by them); staff set and clear it.
alter table public.orders add column details_requested_at timestamptz;
alter table public.orders add column details_request_note text;
alter table public.orders add column details_requested_by uuid references auth.users(id);

-- Every problem with a set of delivery details, in plain words (wms_check_ship stops at the first one, this lists them all).
create or replace function public.wms_ship_problems(p_ship jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare out text[] := '{}'; nm text := regexp_replace(btrim(coalesce(p_ship->>'name', '')), '\s+', ' ', 'g'); cc text := upper(btrim(coalesce(p_ship->>'country', '')));
  d text := regexp_replace(coalesce(p_ship->>'phone', ''), '[^0-9]', '', 'g'); pc text := regexp_replace(btrim(coalesce(p_ship->>'postal', '')), '\s+', '', 'g');
  st text := btrim(coalesce(p_ship->>'line1', '')) || ' ' || btrim(coalesce(p_ship->>'line2', ''));
begin
  if nm = '' then out := array_append(out, 'The recipient name is missing.');
  elsif nm !~ '^[A-Za-zÀ-ɏ''.-]+( [A-Za-zÀ-ɏ''.-]+)+$' then out := array_append(out, ('The recipient name "' || nm || '" must be a first name and a surname, letters only.')); end if;
  if btrim(coalesce(p_ship->>'line1', '')) = '' then out := array_append(out, 'The street address is missing.');
  elsif cc = 'PL' and st !~ '[0-9]' then out := array_append(out, 'The street address needs the house number.'); end if;
  if btrim(coalesce(p_ship->>'city', '')) = '' then out := array_append(out, 'The city is missing.'); end if;
  if cc !~ '^[A-Z]{2}$' then out := array_append(out, 'The country must be a two-letter code, for example PL.'); end if;
  if left(d, 2) = '00' then d := substr(d, 3); end if;
  if d = '' then out := array_append(out, 'The recipient phone number is missing.');
  elsif cc = 'PL' then
    if length(d) = 11 and left(d, 2) = '48' then d := substr(d, 3); elsif length(d) = 10 and left(d, 1) = '0' then d := substr(d, 2); end if;
    if length(d) <> 9 then out := array_append(out, ('The recipient phone "' || btrim(coalesce(p_ship->>'phone', '')) || '" must be a Polish number with 9 digits.')); end if;
  elsif length(d) < 7 or length(d) > 15 then out := array_append(out, 'The recipient phone number must have 7 to 15 digits.'); end if;
  if cc = 'PL' then
    if pc ~ '^[0-9]{5}$' then pc := left(pc, 2) || '-' || right(pc, 3); end if;
    if pc !~ '^[0-9]{2}-[0-9]{3}$' then out := array_append(out, ('The postal code "' || btrim(coalesce(p_ship->>'postal', '')) || '" must look like 00-001.')); end if;
  elsif pc = '' then out := array_append(out, 'The postal code is missing.'); end if;
  if nullif(btrim(coalesce(p_ship->>'email', '')), '') is not null and btrim(p_ship->>'email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then out := array_append(out, 'The recipient email looks wrong.'); end if;
  return out;
end $$;
revoke all on function public.wms_ship_problems(jsonb) from public, anon;
grant execute on function public.wms_ship_problems(jsonb) to authenticated;

-- What is wrong with the details stored on an order right now (empty list: the label can be made). Staff only.
create or replace function public.order_ship_problems(p_order uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders;
begin
  perform public.wms_staff('admin','support','warehouse');
  select * into o from public.orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  return public.wms_ship_problems(jsonb_build_object('name', o.ship_name, 'line1', o.ship_line1, 'line2', o.ship_line2, 'postal', o.ship_postal, 'city', o.ship_city, 'country', o.ship_country, 'phone', o.ship_phone, 'email', o.ship_email));
end $$;

-- Edit the delivery details of an order that has not shipped and has no bought label yet. The same rules as creating an order.
create or replace function public.update_order_ship(p_order uuid, p_ship jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders; chk jsonb; em text := nullif(btrim(coalesce(p_ship->>'email', '')), ''); before jsonb;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('shipped','cancelled') then raise exception 'This order is %, its details can no longer be changed', o.status; end if;
  if exists (select 1 from public.shipments where order_id = p_order and status in ('buying','purchased')) then raise exception 'A label has already been bought for these details. The label would no longer match.'; end if;
  chk := public.wms_check_ship(p_ship);
  if btrim(coalesce(p_ship->>'city', '')) = '' then raise exception 'The recipient city is required'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'The recipient email looks wrong'; end if;
  before := jsonb_build_object('name', o.ship_name, 'company', o.ship_company, 'email', o.ship_email, 'phone', o.ship_phone, 'line1', o.ship_line1, 'line2', o.ship_line2, 'postal', o.ship_postal, 'city', o.ship_city, 'country', o.ship_country);
  update public.orders set ship_name = left(chk->>'name', 120), ship_company = nullif(left(btrim(coalesce(p_ship->>'company', '')), 120), ''), ship_email = em, ship_phone = chk->>'phone',
    ship_line1 = left(btrim(p_ship->>'line1'), 160), ship_line2 = nullif(left(btrim(coalesce(p_ship->>'line2', '')), 160), ''), ship_postal = left(chk->>'postal', 20), ship_city = left(btrim(p_ship->>'city'), 100), ship_country = chk->>'country',
    details_requested_at = null, details_request_note = null, details_requested_by = null
  where id = p_order;
  perform public.wms_audit(r, 'order.edit_ship', 'orders', p_order::text, o.org_id, jsonb_build_object('before', before, 'after', jsonb_build_object('name', chk->>'name', 'phone', chk->>'phone', 'postal', chk->>'postal', 'city', p_ship->>'city', 'country', chk->>'country')));
  return jsonb_build_object('id', p_order, 'ref', o.ref);
end $$;

-- Remember that we asked the customer (shown to them on the order, cleared when staff save the corrected details).
create or replace function public.mark_details_requested(p_order uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then raise exception 'Order not found'; end if;
  if o.status in ('shipped','cancelled') then raise exception 'This order is %', o.status; end if;
  update public.orders set details_requested_at = now(), details_request_note = left(btrim(coalesce(p_note, '')), 1000), details_requested_by = auth.uid() where id = p_order;
  perform public.wms_audit(r, 'order.request_details', 'orders', p_order::text, o.org_id, jsonb_build_object('note', left(btrim(coalesce(p_note, '')), 300)));
end $$;

do $$ declare f text; begin
  foreach f in array array['order_ship_problems(uuid)', 'update_order_ship(uuid,jsonb)', 'mark_details_requested(uuid,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
