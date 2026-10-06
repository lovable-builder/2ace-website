-- Orders must carry what a shipping label needs, so a label can never fail later for a missing or malformed field.
-- Returns the cleaned name, phone, postal code and country; raises a message that says what to fix.
create or replace function public.wms_check_ship(p_ship jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare nm text := regexp_replace(btrim(coalesce(p_ship->>'name', '')), '\s+', ' ', 'g'); cc text := upper(btrim(coalesce(p_ship->>'country', '')));
  d text := regexp_replace(coalesce(p_ship->>'phone', ''), '[^0-9]', '', 'g'); pc text := regexp_replace(btrim(coalesce(p_ship->>'postal', '')), '\s+', '', 'g');
  st text := btrim(coalesce(p_ship->>'line1', '')) || ' ' || btrim(coalesce(p_ship->>'line2', ''));
begin
  if nm = '' then raise exception 'The recipient name is required'; end if;
  if nm !~ '^[A-Za-zÀ-ɏ''.-]+( [A-Za-zÀ-ɏ''.-]+)+$' then raise exception 'Enter the recipient''s first name and surname, letters only. The carrier refuses anything else (for example "Jan Kowalski").'; end if;
  if cc !~ '^[A-Z]{2}$' then raise exception 'Use a two-letter country code, for example PL or DE'; end if;
  if btrim(coalesce(p_ship->>'line1', '')) = '' then raise exception 'The recipient street address is required'; end if;
  if d = '' then raise exception 'The recipient phone number is required, the carrier needs it to deliver'; end if;
  if left(d, 2) = '00' then d := substr(d, 3); end if;
  if cc = 'PL' then
    if length(d) = 11 and left(d, 2) = '48' then d := substr(d, 3); elsif length(d) = 10 and left(d, 1) = '0' then d := substr(d, 2); end if;
    if length(d) <> 9 then raise exception 'The recipient phone must be a Polish number with 9 digits, for example 608 180 946'; end if;
    if pc ~ '^[0-9]{5}$' then pc := left(pc, 2) || '-' || right(pc, 3); end if;
    if pc !~ '^[0-9]{2}-[0-9]{3}$' then raise exception 'Polish postal codes look like 00-001'; end if;
    if st !~ '[0-9]' then raise exception 'The street address needs the house number, for example "Prosta 1"'; end if;
  elsif length(d) < 7 or length(d) > 15 then raise exception 'Enter the recipient phone number with 7 to 15 digits';
  end if;
  return jsonb_build_object('name', nm, 'phone', d, 'postal', pc, 'country', cc);
end $$;
revoke all on function public.wms_check_ship(jsonb) from public, anon;
grant execute on function public.wms_check_ship(jsonb) to authenticated;

create or replace function public.create_order(
  p_org uuid, p_external_ref text, p_ship jsonb, p_notes text, p_lines jsonb, p_channel text default 'manual'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_org_access(p_org); chk jsonb; oid uuid; oref text; st text; ln jsonb; q integer; pid uuid; seen uuid[] := '{}'; ext text := nullif(btrim(coalesce(p_external_ref, '')), '');
  nm text := btrim(coalesce(p_ship->>'name', '')); l1 text := btrim(coalesce(p_ship->>'line1', '')); pc text := btrim(coalesce(p_ship->>'postal', '')); ct text := btrim(coalesce(p_ship->>'city', '')); cc text := upper(btrim(coalesce(p_ship->>'country', '')));
  em text := nullif(btrim(coalesce(p_ship->>'email', '')), '');
begin
  if r = 'customer' and not exists (select 1 from public.organizations where id = p_org and status = 'active') then raise exception 'Your plan is not active yet'; end if;
  if p_channel not in ('manual','csv') then raise exception 'Unknown channel'; end if;
  if ext is not null then
    select id, ref, status into oid, oref, st from public.orders where org_id = p_org and external_ref = ext;
    if found then return jsonb_build_object('id', oid, 'ref', oref, 'status', st, 'duplicate', true); end if;
  end if;
  chk := public.wms_check_ship(p_ship);   -- everything the shipping label needs, or a clear message saying what to fix
  nm := chk->>'name'; pc := chk->>'postal'; cc := chk->>'country';
  if nm = '' or length(nm) > 120 then raise exception 'The recipient name is required'; end if;
  if l1 = '' or length(l1) > 160 then raise exception 'The recipient street address is required'; end if;
  if pc = '' or length(pc) > 20 then raise exception 'The recipient postal code is required'; end if;
  if ct = '' or length(ct) > 100 then raise exception 'The recipient city is required'; end if;
  if cc !~ '^[A-Z]{2}$' then raise exception 'Use a two-letter country code, for example PL or DE'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'The recipient email looks wrong'; end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one product'; end if;
  if jsonb_array_length(p_lines) > 100 then raise exception 'Too many lines in one order (100 maximum)'; end if;
  insert into public.orders (org_id, external_ref, channel, ship_name, ship_company, ship_email, ship_phone, ship_line1, ship_line2, ship_postal, ship_city, ship_country, notes, created_by)
  values (p_org, ext, p_channel, left(nm, 120), nullif(left(btrim(coalesce(p_ship->>'company', '')), 120), ''), em, chk->>'phone',
          left(l1, 160), nullif(left(btrim(coalesce(p_ship->>'line2', '')), 160), ''), left(pc, 20), left(ct, 100), cc, nullif(left(btrim(coalesce(p_notes, '')), 500), ''), auth.uid())
  returning id, ref into oid, oref;
  for ln in select * from jsonb_array_elements(p_lines) loop
    q := (ln->>'qty')::integer;
    if q is null or q < 1 or q > 100000 then raise exception 'Quantities must be between 1 and 100,000'; end if;
    if ln ? 'product_id' and ln->>'product_id' is not null then
      pid := (ln->>'product_id')::uuid;
      if not exists (select 1 from public.products where id = pid and org_id = p_org and active) then raise exception 'A product on this order was not found or is switched off'; end if;
    else
      select id into pid from public.products where org_id = p_org and sku = btrim(coalesce(ln->>'sku', '')) and active;
      if pid is null then raise exception 'Unknown SKU %', coalesce(ln->>'sku', ''); end if;
    end if;
    if pid = any(seen) then raise exception 'Each product can appear once per order'; end if;
    seen := seen || pid;
    insert into public.order_lines (order_id, org_id, product_id, qty) values (oid, p_org, pid, q);
  end loop;
  st := public.wms_allocate(oid);
  perform public.wms_audit(r, 'order.create', 'orders', oid::text, p_org, jsonb_build_object('ref', oref, 'status', st, 'lines', jsonb_array_length(p_lines), 'channel', p_channel));
  return jsonb_build_object('id', oid, 'ref', oref, 'status', st, 'duplicate', false);
end $$;
