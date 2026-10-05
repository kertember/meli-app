-- Covers the foreign key to auth.users and the per-user lookups in the notification functions.
create index push_subscriptions_user_id on public.push_subscriptions (user_id);
