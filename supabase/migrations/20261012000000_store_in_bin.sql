-- One-click put-away: move goods (all free units by default) from where they are into the customer's own bin.
-- The bin is the customer's first assigned bin, or one created and assigned automatically. Reserved units stay where they are.
create or replace function public.putaway_to_default(p_org uuid, p_product uuid, p_from uuid, p_qty integer default null, p_lot text default '', p_key text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r text := public.wms_staff('admin','warehouse'); v_lot text := coalesce(btrim(p_lot), ''); v_free integer; v_qty integer; v_to uuid; v_code text;
begin
  if not exists (select 1 from public.locations where id = p_from) then raise exception 'Location not found'; end if;
  select on_hand - reserved into v_free from public.stock_levels where org_id = p_org and product_id = p_product and location_id = p_from and lot = v_lot;
  if coalesce(v_free, 0) < 1 then raise exception 'There is nothing free to move from there'; end if;
  v_qty := coalesce(p_qty, v_free);
  if v_qty < 1 or v_qty > v_free then raise exception 'Not enough free stock there (have %)', v_free; end if;
  v_to := public.wms_default_bin(p_org);
  if v_to = p_from then raise exception 'These goods are already in the customer''s bin'; end if;
  select code into v_code from public.locations where id = v_to;
  perform public.putaway(p_org, p_product, p_from, v_to, v_qty, v_lot, p_key);
  return jsonb_build_object('location', v_code, 'qty', v_qty);
end $$;
revoke all on function public.putaway_to_default(uuid,uuid,uuid,integer,text,text) from public, anon;
grant execute on function public.putaway_to_default(uuid,uuid,uuid,integer,text,text) to authenticated;
