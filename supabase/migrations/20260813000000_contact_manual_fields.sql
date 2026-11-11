-- Keyword-extraction/stale-portfolio-link root-cause pass (2026-08-13).
-- The single contact_manual boolean (20260802000000) locks the ENTIRE
-- contact record on any one field edit — e.g. editing LinkedIn once in
-- Copilot's header editor (routes/copilot.js's PATCH .../header) sets
-- contact_manual = true, after which a fresh master résumé upload's
-- portfolio/website/phone/etc. can never reach the stored columns again,
-- even though the user never touched those fields. Per-field provenance
-- replaces the single flag: only a field actually present in
-- contact_manual_fields is treated as user-owned and protected from a
-- fresh extraction; every other field re-syncs from the newly uploaded
-- résumé (routes/resume.js POST) or from a fresh extractContact() read
-- (extractContact.js's resolveContact) on every subsequent call.
--
-- Existing contact_manual = true rows are backfilled to the FULL field
-- list below, so no existing hand-edit is silently un-protected by this
-- migration. contact_manual itself is kept (not dropped) for one release
-- as a read-only historical marker before being retired.
alter table public.users
  add column if not exists contact_manual_fields text[] not null default '{}';

update public.users
set contact_manual_fields = array['name', 'city_state', 'phone', 'email', 'linkedin_url', 'portfolio_url', 'website_url']
where contact_manual = true
  and contact_manual_fields = '{}';
