-- CareerOS — the v2 test engine has been promoted to be the only résumé
-- generation pipeline (no more separate "Test Engine v2" button/doc_type);
-- revert generated_documents.doc_type to just the two real document types.
alter table public.generated_documents drop constraint generated_documents_doc_type_check;
alter table public.generated_documents add constraint generated_documents_doc_type_check
  check (doc_type in ('resume', 'cover_letter'));
