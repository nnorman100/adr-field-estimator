-- Letterhead fields and document settings (S5a-4b, docs/plans/S5.md): the one database job of the
-- step. This file only adds; nothing in 0001 to 0012 changes except that `companies` gains six
-- columns and 0010's context trigger names them. No company's own values are seeded: every company,
-- the existing ones included, starts with the five letterhead fields empty and the settings at their
-- neutral defaults.
--
-- 1. Five letterhead lines (emergency phone, fax, website, tagline, mailing address): one line each,
--    no padding, empty until set, as 0010's profile columns are.
-- 2. profile_documents: the company's document settings, a jsonb object under 64 KiB. SQL cannot
--    check its shape; the one Zod schema (web/src/lib/profile/settings.ts) checks it at write and
--    at read, as price versions are checked (0009). '{}' means every setting at its neutral default.
-- 3. The column-level UPDATE grant and 0010's trigger split extend to the six columns: a company's
--    own transaction changes them, an operator never does. That only the owner may is the route's
--    rule (profile_manage), as for the rest of the profile.

ALTER TABLE companies
  ADD COLUMN profile_emergency_phone text NOT NULL DEFAULT '',
  ADD COLUMN profile_fax text NOT NULL DEFAULT '',
  ADD COLUMN profile_website text NOT NULL DEFAULT '',
  ADD COLUMN profile_tagline text NOT NULL DEFAULT '',
  ADD COLUMN profile_mailing_address text NOT NULL DEFAULT '',
  ADD COLUMN profile_documents jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT companies_profile_emergency_phone_check
    CHECK (profile_emergency_phone = btrim(profile_emergency_phone) AND char_length(profile_emergency_phone) <= 80 AND profile_emergency_phone !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_fax_check
    CHECK (profile_fax = btrim(profile_fax) AND char_length(profile_fax) <= 80 AND profile_fax !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_website_check
    CHECK (profile_website = btrim(profile_website) AND char_length(profile_website) <= 200 AND profile_website !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_tagline_check
    CHECK (profile_tagline = btrim(profile_tagline) AND char_length(profile_tagline) <= 150 AND profile_tagline !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_mailing_address_check
    CHECK (profile_mailing_address = btrim(profile_mailing_address) AND char_length(profile_mailing_address) <= 500 AND profile_mailing_address !~ '[[:cntrl:]]'),
  ADD CONSTRAINT companies_profile_documents_check
    CHECK (jsonb_typeof(profile_documents) = 'object' AND octet_length(profile_documents::text) < 65536);

-- 0010's split, now naming the six new columns beside the five it named: in a company's own
-- transaction the profile only, never status or sign-in tenant; in an operator's context everything
-- but the profile. The trigger itself (0010) is unchanged and calls this function by name.
CREATE OR REPLACE FUNCTION companies_guard_context_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'public.companies'::regclass), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF (SELECT public.app_operator_active()) THEN
    IF NEW.profile_address IS DISTINCT FROM OLD.profile_address
      OR NEW.profile_phone IS DISTINCT FROM OLD.profile_phone
      OR NEW.profile_email IS DISTINCT FROM OLD.profile_email
      OR NEW.profile_license IS DISTINCT FROM OLD.profile_license
      OR NEW.profile_signoff IS DISTINCT FROM OLD.profile_signoff
      OR NEW.profile_emergency_phone IS DISTINCT FROM OLD.profile_emergency_phone
      OR NEW.profile_fax IS DISTINCT FROM OLD.profile_fax
      OR NEW.profile_website IS DISTINCT FROM OLD.profile_website
      OR NEW.profile_tagline IS DISTINCT FROM OLD.profile_tagline
      OR NEW.profile_mailing_address IS DISTINCT FROM OLD.profile_mailing_address
      OR NEW.profile_documents IS DISTINCT FROM OLD.profile_documents THEN
      RAISE EXCEPTION 'a platform operator cannot change a company''s profile' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status OR NEW.auth_tenant_id IS DISTINCT FROM OLD.auth_tenant_id THEN
    RAISE EXCEPTION 'a company cannot change its own status or sign-in tenant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION companies_guard_context_change() FROM PUBLIC;

-- The new profile columns of the company's own row, beside 0010's five (updated_at is 0006's).
GRANT UPDATE (
  profile_emergency_phone, profile_fax, profile_website, profile_tagline, profile_mailing_address, profile_documents
) ON companies TO dryscope_runtime;
