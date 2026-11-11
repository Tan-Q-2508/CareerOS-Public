-- Google Drive integration (spec §11.3, build order #15).
-- Drive is a free, optional delivery destination for already-generated .docx
-- files — never a second COS charge, never a backup mechanism (§10). These two
-- columns let the Drive adapter reuse a job's folder / a document's file across
-- repeated "Save to Drive" clicks instead of re-querying Drive by name (which
-- the narrow drive.file scope may not reliably support for folders it didn't
-- just create in this session) or creating duplicates.

begin;

alter table public.jobs add column drive_folder_id text;
alter table public.generated_documents add column drive_file_id text;

commit;

notify pgrst, 'reload schema';
