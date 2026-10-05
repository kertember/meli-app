-- Füzet: the students' hours, the phone's push subscription, and the bookkeeping that makes
-- every reminder and evening summary go out once.
--
-- Times are Europe/Bucharest wall-clock times: an appointment is a day plus a whole hour
-- (9 to 20). Everything the app reads or writes is limited to the signed-in user by RLS.

-- ---------------------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------------------

create table public.appointments (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day date not null,
  hour smallint not null check (hour between 9 and 20),
  name text not null check (btrim(name) <> '' and length(name) <= 200),
  phone text not null default '' check (length(phone) <= 50),
  note text not null default '' check (length(note) <= 1000),
  -- Set once the 1-hour reminder has gone out (or was not wanted, see the trigger below).
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, day, hour)
);

create index appointments_pending_reminders on public.appointments (day) where reminder_sent_at is null;

alter table public.appointments enable row level security;

create policy "Own appointments" on public.appointments
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

/** When an appointment starts. */
create function public.appointment_start(p_day date, p_hour smallint)
returns timestamptz
language sql stable
set search_path = ''
as $$
  select (p_day + make_time(p_hour, 0, 0)) at time zone 'Europe/Bucharest'
$$;

/**
 * Keeps the bookkeeping columns out of the app's hands. A student booked less than an hour
 * ahead gets no reminder, since she has only just written them in; moving a booking to
 * another hour plans its reminder again.
 */
create function public.appointments_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    -- The notification job marking reminders as sent.
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    new.reminder_sent_at := old.reminder_sent_at;
  end if;

  if tg_op = 'INSERT' or (new.day, new.hour) is distinct from (old.day, old.hour) then
    new.reminder_sent_at := case
      when public.appointment_start(new.day, new.hour) - interval '1 hour' <= now() then now()
    end;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger appointments_before_write
  before insert or update on public.appointments
  for each row execute function public.appointments_before_write();

-- ---------------------------------------------------------------------------------------
-- Push subscriptions (one per phone or browser that turned notifications on)
-- ---------------------------------------------------------------------------------------

create table public.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint like 'https://%' and length(endpoint) <= 2000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  created_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;

create policy "Own push subscriptions" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------
-- Evening summaries already decided: one row per user and listed day, whether or not a
-- notification went out (none does when there are no students that day).
-- ---------------------------------------------------------------------------------------

create table public.evening_summaries (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  student_count integer not null,
  decided_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.evening_summaries enable row level security;
-- No policies: only the notification functions below touch it.
revoke all on public.evening_summaries from anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- Settings the notification function keeps for itself: its VAPID keys and the project URL
-- the scheduler calls. Not exposed through the API.
-- ---------------------------------------------------------------------------------------

create schema meli_private;
revoke all on schema meli_private from public;

create table meli_private.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------
-- Functions for the notification Edge Function (service role only)
-- ---------------------------------------------------------------------------------------

/**
 * Records the project URL and returns the VAPID keys. With [p_new_keys] it stores them unless
 * another call already did, and returns whichever keys were kept.
 */
create function public.meli_push_config(p_project_url text, p_new_keys jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_project_url is not null then
    insert into meli_private.settings (key, value) values ('project_url', p_project_url)
    on conflict (key) do update set value = excluded.value, updated_at = now()
      where meli_private.settings.value is distinct from excluded.value;
  end if;
  if p_new_keys is not null then
    insert into meli_private.settings (key, value) values ('vapid_keys', p_new_keys::text)
    on conflict (key) do nothing;
  end if;
  return (select value::jsonb from meli_private.settings where key = 'vapid_keys');
end;
$$;

/** True when a reminder or tonight's summary is waiting, so the scheduler only calls then. */
create function public.meli_notifications_due(p_now timestamptz default now())
returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.appointments a
    where a.reminder_sent_at is null
      and public.appointment_start(a.day, a.hour) > p_now
      and public.appointment_start(a.day, a.hour) - interval '1 hour' <= p_now + interval '1 minute'
      and exists (select 1 from public.push_subscriptions s where s.user_id = a.user_id)
  ) or (
    (p_now at time zone 'Europe/Bucharest')::time >= time '21:00'
    and exists (
      select 1
      from public.push_subscriptions s
      where not exists (
        select 1 from public.evening_summaries e
        where e.user_id = s.user_id and e.day = (p_now at time zone 'Europe/Bucharest')::date + 1
      )
    )
  )
$$;

/**
 * Claims what is due now and returns it with the subscriptions to send it to: 1-hour
 * reminders for students still to come, and from 21:00 tomorrow's list (once per evening,
 * and only when tomorrow has students). Claimed items are never returned again.
 */
create function public.meli_claim_due_notifications(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Europe/Bucharest';
  v_tomorrow date := (p_now at time zone 'Europe/Bucharest')::date + 1;
  v_reminders jsonb;
  v_summaries jsonb := '[]';
  v_messages jsonb;
begin
  with due as (
    update public.appointments a
       set reminder_sent_at = p_now
     where a.reminder_sent_at is null
       and public.appointment_start(a.day, a.hour) > p_now
       and public.appointment_start(a.day, a.hour) - interval '1 hour' <= p_now + interval '1 minute'
       and exists (select 1 from public.push_subscriptions s where s.user_id = a.user_id)
    returning a.id, a.user_id, a.day, a.hour, a.name, a.note,
      ceil(extract(epoch from public.appointment_start(a.day, a.hour) - p_now) / 60)::integer as minutes_left
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'reminder', 'user_id', user_id, 'id', id, 'day', day, 'hour', hour,
      'name', name, 'note', note, 'minutes_left', minutes_left) order by day, hour), '[]')
    into v_reminders
    from due;

  if v_local::time >= time '21:00' then
    with decided as (
      insert into public.evening_summaries (user_id, day, student_count)
      select s.user_id, v_tomorrow,
        (select count(*) from public.appointments a where a.user_id = s.user_id and a.day = v_tomorrow)
      from (select distinct user_id from public.push_subscriptions) s
      on conflict (user_id, day) do nothing
      returning user_id, day, student_count
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', 'summary', 'user_id', d.user_id, 'day', d.day,
        'items', (select jsonb_agg(jsonb_build_object('hour', a.hour, 'name', a.name, 'note', a.note) order by a.hour)
                  from public.appointments a where a.user_id = d.user_id and a.day = d.day))), '[]')
      into v_summaries
      from decided d
      where d.student_count > 0;
  end if;

  v_messages := v_reminders || v_summaries;
  return jsonb_build_object(
    'messages', v_messages,
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth))
      from public.push_subscriptions s
      where s.user_id in (select (m ->> 'user_id')::uuid from jsonb_array_elements(v_messages) m)
    ), '[]'));
end;
$$;

/** Drops a subscription the push service no longer knows (the phone turned it off). */
create function public.meli_forget_push_subscription(p_endpoint text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.push_subscriptions where endpoint = p_endpoint
$$;

revoke execute on function public.meli_push_config(text, jsonb) from public, anon, authenticated;
revoke execute on function public.meli_notifications_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.meli_claim_due_notifications(timestamptz) from public, anon, authenticated;
revoke execute on function public.meli_forget_push_subscription(text) from public, anon, authenticated;
grant execute on function public.meli_push_config(text, jsonb) to service_role;
grant execute on function public.meli_notifications_due(timestamptz) to service_role;
grant execute on function public.meli_claim_due_notifications(timestamptz) to service_role;
grant execute on function public.meli_forget_push_subscription(text) to service_role;
