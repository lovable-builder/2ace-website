-- Prices at or below the Polish market (October 2026): packing and returns per parcel size class.
-- Packing XS 2.89 · S 3.49 · M 4.90 · L 7.50 · XL 11.50 zł; returns XS 3.90 · S 4.70 · M 6.60 · L 10.10 · XL 15.50 zł (net).
-- Only the classes that exist with these names are changed; staff can still edit the tariff in the admin panel afterwards.
update public.handling_tiers t set handling_net = v.h, return_net = v.r
from (values ('XS', 2.89, 3.90), ('S', 3.49, 4.70), ('M', 4.90, 6.60), ('L', 7.50, 10.10), ('XL', 11.50, 15.50)) as v(size_class, h, r)
where t.size_class = v.size_class;
