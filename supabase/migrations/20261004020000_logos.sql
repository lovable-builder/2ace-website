-- Company logos: public-read bucket, writes limited to the company's owner/finance members.
alter table public.organizations add column logo_path text;
grant update (logo_path) on public.organizations to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 1048576, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 1048576, allowed_mime_types = array['image/png','image/jpeg','image/webp'];

-- Objects live at <org_id>/<file>; the first folder must be an org the user owns/finances.
create policy "logos read own org" on storage.objects for select to authenticated
  using (bucket_id = 'logos' and exists (select 1 from public.members m where m.user_id = auth.uid() and m.org_id::text = (storage.foldername(name))[1]));
create policy "logos insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and exists (select 1 from public.members m where m.user_id = auth.uid() and m.role in ('owner','finance') and m.org_id::text = (storage.foldername(name))[1]));
create policy "logos delete" on storage.objects for delete to authenticated
  using (bucket_id = 'logos' and exists (select 1 from public.members m where m.user_id = auth.uid() and m.role in ('owner','finance') and m.org_id::text = (storage.foldername(name))[1]));
