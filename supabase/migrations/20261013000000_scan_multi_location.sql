-- Multi-location scans (spec 4.6.6). ATS Direct schedules can now filter by
-- several locations at once (e.g. India and USA): a posting is kept if it
-- matches any of them. `locations` is canonical; `location` is kept as the
-- list joined by " or " for legacy readers, the same contract job_titles /
-- job_title follow (20260810040000_scan_multi_title.sql).
alter table public.scan_schedules add column locations text[];

update public.scan_schedules
set locations = array[location]
where location is not null and locations is null;

comment on column public.scan_schedules.locations is
  'Canonical location-filter list (4.6.6; more than one is ATS Direct only). location is kept in sync as the list joined by " or " by the application for legacy readers.';
