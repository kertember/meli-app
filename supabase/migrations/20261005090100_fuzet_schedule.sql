-- Every minute, ask the notify Edge Function to send what is due, but only when something is.
-- The function records the project URL on its first call (the app makes one when
-- notifications are turned on), so this needs no project-specific values.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

select cron.schedule(
  'fuzet-notify',
  '* * * * *',
  $$
  select net.http_post(
    url := s.value || '/functions/v1/notify',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  )
  from meli_private.settings s
  where s.key = 'project_url' and public.meli_notifications_due();
  $$
);
