-- Google Drive integration (spec §11.3), follow-up to 20260727010000. The root
-- "CareerOS" folder is per-user (one per Google grant), so it belongs on
-- google_oauth_credentials rather than on jobs/generated_documents.

begin;

alter table public.google_oauth_credentials add column drive_root_folder_id text;

commit;

notify pgrst, 'reload schema';
