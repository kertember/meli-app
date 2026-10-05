// The notify Edge Function, run in Node with a fake PostgREST and a fake push service. The fake
// push service decrypts what it receives the way a phone would, so these tests check the
// encryption and the VAPID signature end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/notify/index.ts';
import { encryptPayload, fromBase64Url, generateVapidKeys, toBase64Url, vapidAuthorization } from '../supabase/functions/notify/webpush.ts';
import { notificationFor } from '../supabase/functions/notify/messages.ts';

const subtle = crypto.subtle;
const encoder = new TextEncoder();

async function hkdf(salt, ikm, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** A browser's push subscription: its keys, and how it decrypts a message. */
async function fakeBrowser(endpoint) {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return {
    target: { endpoint, p256dh: toBase64Url(publicKey), auth: toBase64Url(authSecret) },
    async decrypt(body) {
      const salt = body.slice(0, 16);
      const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
      const idLength = body[20];
      const senderPublic = body.slice(21, 21 + idLength);
      const ciphertext = body.slice(21 + idLength);
      assert.equal(recordSize, 4096);
      const senderKey = await subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: senderKey }, pair.privateKey, 256));
      const info = new Uint8Array([...encoder.encode('WebPush: info\0'), ...publicKey, ...senderPublic]);
      const ikm = await hkdf(authSecret, shared, info, 32);
      const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
      const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext));
      assert.equal(padded.at(-1), 2, 'last-record delimiter');
      return new TextDecoder().decode(padded.slice(0, -1));
    },
  };
}

async function verifyVapid(header, keys, endpoint) {
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match, header);
  const [, head, claims, signature, k] = match;
  assert.equal(k, keys.publicKey);
  const publicKey = await subtle.importKey('raw', fromBase64Url(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, fromBase64Url(signature), encoder.encode(`${head}.${claims}`));
  assert.ok(valid, 'VAPID signature verifies');
  const body = JSON.parse(new TextDecoder().decode(fromBase64Url(claims)));
  assert.equal(body.aud, new URL(endpoint).origin);
  assert.equal(body.sub, 'https://kertember.github.io/meli-app/');
  assert.ok(body.exp > Date.now() / 1000 && body.exp <= Date.now() / 1000 + 24 * 3600);
}

test('a payload decrypts back to what was sent', async () => {
  const browser = await fakeBrowser('https://push.example/1');
  const body = await encryptPayload(browser.target, encoder.encode('Szia! ő ű'));
  assert.equal(await browser.decrypt(body), 'Szia! ő ű');
});

test('the VAPID header is signed with the server key', async () => {
  const keys = await generateVapidKeys();
  assert.equal(fromBase64Url(keys.publicKey).length, 65);
  await verifyVapid(await vapidAuthorization('https://web.push.apple.com/abc', keys, 'https://kertember.github.io/meli-app/'), keys, 'https://web.push.apple.com/abc');
});

test('reminder and summary texts', () => {
  assert.deepEqual(notificationFor({ kind: 'reminder', user_id: 'u', id: 7, day: '2026-10-07', hour: 11, name: 'Kovács Anna', note: 'online', minutes_left: 61 }), {
    title: '1 óra múlva: Kovács Anna', body: '11:00 · online', tag: 'reminder-7', url: './?nap=2026-10-07',
  });
  assert.equal(notificationFor({ kind: 'reminder', user_id: 'u', id: 7, day: '2026-10-07', hour: 11, name: 'Anna', note: '', minutes_left: 20 }).title, '20 perc múlva: Anna');
  assert.deepEqual(notificationFor({
    kind: 'summary', user_id: 'u', day: '2026-10-07',
    items: [{ hour: 9, name: 'Lakatos Erika', note: 'első óra' }, { hour: 16, name: 'Németh Zita', note: '' }],
  }), {
    title: 'Itt vannak a holnapi diákjaid.',
    body: '9:00 Lakatos Erika – első óra\n16:00 Németh Zita',
    tag: 'summary-2026-10-07',
    url: './?nap=2026-10-07',
  });
});

/** PostgREST and two push services, with the database part reduced to what the function sees. */
function fakeServer({ due, pushStatus = {} }) {
  const calls = [];
  const delivered = [];
  let stored = null;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (u.host === 'ref.supabase.co') {
      const name = u.pathname.replace('/rest/v1/rpc/', '');
      const args = JSON.parse(init.body);
      calls.push({ name, args, headers: init.headers });
      if (name === 'meli_push_config') {
        if (args.p_new_keys && !stored) stored = args.p_new_keys;
        return Response.json(stored);
      }
      if (name === 'meli_claim_due_notifications') return Response.json(due);
      if (name === 'meli_forget_push_subscription') return new Response(null, { status: 204 });
      return new Response('unknown rpc', { status: 404 });
    }
    delivered.push({ url, init });
    return new Response(null, { status: pushStatus[url] ?? 201 });
  };
  return { fetchImpl, calls, delivered, keys: () => stored };
}

test('GET creates the VAPID keys once and returns the public key', async () => {
  const server = fakeServer({ due: { messages: [], subscriptions: [] } });
  const handler = createHandler({ url: 'https://ref.supabase.co', secretKey: 'sb_secret_x' }, server.fetchImpl);
  const first = await (await handler(new Request('https://ref.supabase.co/functions/v1/notify'))).json();
  const second = await (await handler(new Request('https://ref.supabase.co/functions/v1/notify'))).json();
  assert.equal(first.publicKey, server.keys().publicKey);
  assert.equal(second.publicKey, first.publicKey);
  assert.equal(server.calls[0].args.p_project_url, 'https://ref.supabase.co');
  assert.equal(server.calls[0].headers.apikey, 'sb_secret_x');
  assert.equal(server.calls[0].headers.Authorization, undefined);
});

test('POST sends each due message to that user’s phones and forgets a dropped one', async () => {
  const phone = await fakeBrowser('https://web.push.apple.com/phone');
  const old = await fakeBrowser('https://web.push.apple.com/old');
  const other = await fakeBrowser('https://fcm.googleapis.com/other');
  const server = fakeServer({
    due: {
      messages: [{ kind: 'reminder', user_id: 'mom', id: 3, day: '2026-10-06', hour: 11, name: 'Kovács Anna', note: 'online', minutes_left: 60 }],
      subscriptions: [{ user_id: 'mom', ...phone.target }, { user_id: 'mom', ...old.target }, { user_id: 'someone', ...other.target }],
    },
    pushStatus: { 'https://web.push.apple.com/old': 410 },
  });
  const handler = createHandler({ url: 'https://ref.supabase.co', secretKey: 'sb_secret_x' }, server.fetchImpl);
  const response = await handler(new Request('https://ref.supabase.co/functions/v1/notify', { method: 'POST', body: '{}' }));
  assert.deepEqual(await response.json(), { sent: 1, failed: 1 });

  assert.deepEqual(server.delivered.map((d) => d.url), ['https://web.push.apple.com/phone', 'https://web.push.apple.com/old']);
  const toPhone = server.delivered[0];
  assert.equal(toPhone.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(toPhone.init.headers.TTL, '3600');
  await verifyVapid(toPhone.init.headers.Authorization, server.keys(), toPhone.url);
  assert.deepEqual(JSON.parse(await phone.decrypt(toPhone.init.body)), {
    title: '1 óra múlva: Kovács Anna', body: '11:00 · online', tag: 'reminder-3', url: './?nap=2026-10-06',
  });

  const forgotten = server.calls.filter((c) => c.name === 'meli_forget_push_subscription');
  assert.deepEqual(forgotten.map((c) => c.args), [{ p_endpoint: 'https://web.push.apple.com/old' }]);
});

test('a legacy service_role key is also sent as a bearer token', async () => {
  const server = fakeServer({ due: { messages: [], subscriptions: [] } });
  const handler = createHandler({ url: 'https://ref.supabase.co', secretKey: 'eyJhbGciOi.legacy' }, server.fetchImpl);
  await handler(new Request('https://ref.supabase.co/functions/v1/notify', { method: 'POST', body: '{}' }));
  assert.equal(server.calls[0].headers.Authorization, 'Bearer eyJhbGciOi.legacy');
});
