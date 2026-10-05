# Füzet for iPhone

A home-screen web app for keeping students' lessons by the hour, 9:00 to 20:00, with a day view
and a week view. It sends a notification an hour before each student and, at 21:00 Romanian time,
tomorrow's list. The Android app with the same name lives in `kertember/AppForMom-`.

- `web/` – the app (plain HTML, CSS and JavaScript, no build step), served by GitHub Pages
- `supabase/migrations/` – tables, row-level security and the notification schedule
- `supabase/functions/notify/` – the Edge Function that sends the Web Push notifications
- `tests/` – database, notification and date tests (`npm ci && npm test`)
- `design/preview.html` – the approved clickable mockup

## Status

Supabase is set up in the **meli-app** project (organization **emlk**, ref
`zdqnpyppxysjezxwcudg`): the migrations are applied, `notify` is deployed and the schedule runs.
Use only that project; the projects in kertember's Org belong to other apps. Still to do:

1. In the meli-app dashboard: add her user, then turn off sign-ups (steps 3 and 4 below).
2. Merge into `main` and turn on GitHub Pages.
3. Set up her iPhone: you sign in for her once; she never sees the sign-in screen again.

## How notifications work

pg_cron checks every minute whether a reminder or the evening summary is due. Only then does it
call the `notify` function, which claims the due items in the database (so nothing is sent twice)
and sends them, encrypted, to the push service of each phone that turned notifications on. A
student booked less than an hour ahead gets no reminder, like in the Android app. The function
creates its own VAPID keys on first use, so no key has to be copied anywhere.

## Setup

### 1. Supabase (the meliapp project)

1. Apply the files in `supabase/migrations/` in order (SQL editor or `supabase db push`).
2. Create an Edge Function named `notify` from the three files in `supabase/functions/notify/`
   (`index.ts`, `webpush.ts`, `messages.ts`), with **Verify JWT turned off**: pg_cron calls it
   without a user token.
3. Authentication → Users → Add user: her e-mail address and a password, with the e-mail
   auto-confirmed.
4. Authentication → Sign In / Providers: turn off **Allow new users to sign up**.
5. `web/config.js` holds the Project URL and publishable key (already filled in).

### 2. GitHub Pages

Merge into `main`, then Settings → Pages → Source: **GitHub Actions**. Every push to `main` runs
the tests and publishes `web/` to <https://kertember.github.io/meli-app/>.

### 3. Her iPhone (iOS 16.4 or newer)

1. Open <https://kertember.github.io/meli-app/> in Safari.
2. Share → Add to Home Screen, then open Füzet from the Home Screen. (A Home Screen web app has
   its own storage, so sign in there, not in Safari.)
3. Sign in with her account (you do this once for her; the app stays signed in), then tap
   **Bekapcsolás** and allow notifications.

The phone needs internet for the notifications to arrive. A free Supabase project can pause after
a week without use; opening the app keeps it active.
