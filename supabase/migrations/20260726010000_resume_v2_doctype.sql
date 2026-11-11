-- CareerOS — allow a distinct 'resume_v2' doc_type (test engine, parallel to prod
-- 'resume' generation) so it can be trialed against real jobs without colliding
-- with or overwriting the prod résumé document row/storage file.
alter table public.generated_documents drop constraint generated_documents_doc_type_check;
alter table public.generated_documents add constraint generated_documents_doc_type_check
  check (doc_type in ('resume', 'cover_letter', 'resume_v2'));
