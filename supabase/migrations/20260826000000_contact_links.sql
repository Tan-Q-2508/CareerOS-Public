-- Expanded résumé-header links (2026-08-26). Until now a user's master résumé
-- could only carry three header links into generated résumés — LinkedIn,
-- Portfolio, Website — held in three text columns and classified positionally
-- (linkedin.com -> LinkedIn, first other anchor -> Portfolio, second -> Website),
-- so a GitHub link landed in the "Portfolio" slot with the wrong label and a
-- 4th link was dropped. This replaces the three columns with a single ordered
-- JSONB array of { type, url } objects, where `type` is one of the recognised
-- platforms in packages/shared/src/contact/linkTypes.js (linkedin, github,
-- gitlab, portfolio, website, scholar, orcid, twitter, medium, behance,
-- dribbble, stackoverflow, kaggle, youtube, instagram) or 'other' for an
-- unrecognised link that still carries through under a host-derived label.
--
-- Provenance: the seven-token contact_manual_fields model collapses the three
-- url tokens into a single `links` token — a hand-edit in Copilot's header
-- editor locks the whole link set as a unit (that is how a user edits it), the
-- other scalar tokens (name/city_state/phone/email) are unchanged.

alter table public.users
  add column if not exists contact_links jsonb not null default '[]'::jsonb;

-- Fold the three legacy columns in, preserving order linkedin -> portfolio -> website.
update public.users u
set contact_links = coalesce(
  (
    select jsonb_agg(jsonb_build_object('type', t.type, 'url', t.url) order by t.ord)
    from (
      values
        ('linkedin',  u.contact_linkedin_url,  1),
        ('portfolio', u.contact_portfolio_url, 2),
        ('website',   u.contact_website_url,   3)
    ) as t(type, url, ord)
    where t.url is not null and t.url <> ''
  ),
  '[]'::jsonb
)
where u.contact_linkedin_url is not null
   or u.contact_portfolio_url is not null
   or u.contact_website_url is not null;

-- Re-key provenance: if any of the three url tokens was set, the whole link
-- set is now user-owned under the single `links` token.
update public.users
set contact_manual_fields =
  array_remove(
    array_remove(
      array_remove(contact_manual_fields, 'linkedin_url'),
      'portfolio_url'),
    'website_url')
  || case
       when contact_manual_fields && array['linkedin_url', 'portfolio_url', 'website_url']
       then array['links']
       else array[]::text[]
     end
where contact_manual_fields && array['linkedin_url', 'portfolio_url', 'website_url'];

alter table public.users
  drop column if exists contact_linkedin_url,
  drop column if exists contact_portfolio_url,
  drop column if exists contact_website_url;
