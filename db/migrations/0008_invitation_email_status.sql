-- =====================================================================
-- 0008_invitation_email_status.sql — the delivery state of the last
-- invitation e-mail is kept with the invitation (plan task 3.15;
-- docs/05-Backend-Schema.md "invitations"; docs/03 C06).
--
-- Until now only the browser that sent an invitation knew that its e-mail
-- had failed (sessionStorage clinicsys.unsent_invites), so a second admin,
-- or the same admin in another tab, saw nothing to re-send.
--
--   email_status     'pending' | 'sent' | 'failed'; NULL = a row from
--                    before this migration (state unknown).
--   email_status_at  when email_status last changed.
--
-- The API (api/src/invites.js) writes 'pending' when it creates or
-- re-sends an invitation (new token), then 'sent' or 'failed' once the
-- SMTP attempt finishes, even after the request has already answered
-- (slow SMTP, MAIL_WAIT_MS). The late write only touches the row while it
-- still holds the token that e-mail carried, so the result of an older
-- e-mail never overwrites the state of a newer one.
--
-- invitations is a platform/identity table (no RLS, convention 4); the
-- invitations_plan_limit trigger fires on status / organization_id /
-- expires_at only, so writing these columns never re-checks the plan.
--
-- PostgreSQL >= 13, no extensions. migrate.js wraps this file in one
-- transaction.
-- =====================================================================

alter table public.invitations
  add column if not exists email_status    text,
  add column if not exists email_status_at timestamptz;

alter table public.invitations drop constraint if exists invitations_email_status_check;
alter table public.invitations
  add constraint invitations_email_status_check
  check (email_status in ('pending', 'sent', 'failed'));
