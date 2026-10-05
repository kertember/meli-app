// The notify Edge Function.
//
// GET  returns the VAPID public key the app subscribes with (creating the keys on first use).
// POST sends what is due: called every minute by pg_cron while a reminder or tonight's summary
//      is waiting. Due items are claimed in the database first, so a repeated call sends nothing
//      twice; anyone may call it, it never sends anything early.
//
// Deploy with verify_jwt = false: pg_cron calls it without a user token.

import { generateVapidKeys, sendPush } from './webpush.ts';
import type { PushTarget, VapidKeys } from './webpush.ts';
import { notificationFor } from './messages.ts';
import type { Message } from './messages.ts';

const SUBJECT = 'https://kertember.github.io/meli-app/';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Env = { url: string; secretKey: string };
type Due = { messages: Message[]; subscriptions: (PushTarget & { user_id: string })[] };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export function createHandler(env: Env, fetchImpl: typeof fetch = fetch) {
  // Secret keys (sb_secret_…) go on the apikey header only; a legacy service_role JWT also as a bearer token.
  const authHeaders: Record<string, string> = { apikey: env.secretKey };
  if (env.secretKey.startsWith('eyJ')) authHeaders.Authorization = `Bearer ${env.secretKey}`;

  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const response = await fetchImpl(`${env.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${name} failed: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async function vapidKeys(): Promise<VapidKeys> {
    const stored = await rpc('meli_push_config', { p_project_url: env.url });
    if (stored) return stored;
    return await rpc('meli_push_config', { p_project_url: env.url, p_new_keys: await generateVapidKeys() });
  }

  async function sendDue(keys: VapidKeys) {
    const due: Due = await rpc('meli_claim_due_notifications', {});
    let sent = 0;
    let failed = 0;
    for (const message of due.messages) {
      const payload = JSON.stringify(notificationFor(message));
      for (const target of due.subscriptions.filter((s) => s.user_id === message.user_id)) {
        try {
          const result = await sendPush(target, payload, keys, {
            subject: SUBJECT,
            ttl: message.kind === 'reminder' ? 60 * 60 : 3 * 60 * 60,
            urgency: 'high',
          }, fetchImpl);
          if (result.ok) {
            sent++;
            continue;
          }
          failed++;
          if (result.gone) await rpc('meli_forget_push_subscription', { p_endpoint: target.endpoint });
          else console.error(`push to ${new URL(target.endpoint).host} failed: ${result.status}`);
        } catch (error) {
          failed++;
          console.error('push failed:', error);
        }
      }
    }
    return { sent, failed };
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      const keys = await vapidKeys();
      if (request.method === 'GET') return json({ publicKey: keys.publicKey });
      if (request.method === 'POST') return json(await sendDue(keys));
      return json({ error: 'method not allowed' }, 405);
    } catch (error) {
      console.error(error);
      return json({ error: 'internal error' }, 500);
    }
  };
}

declare const Deno: any;

/** The project's default secret key, or the legacy service_role key on projects without one. */
function serverKey(): string {
  try {
    const key = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default;
    if (key) return key;
  } catch {
    // Fall through to the legacy key.
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

if (typeof Deno !== 'undefined') {
  Deno.serve(createHandler({ url: Deno.env.get('SUPABASE_URL'), secretKey: serverKey() }));
}
