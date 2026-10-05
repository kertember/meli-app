// Web Push: message encryption (RFC 8291, aes128gcm) and VAPID sender identification
// (RFC 8292), using only Web Crypto so it runs in Edge Functions (Deno) and in Node's tests.

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** `publicKey` is the uncompressed P-256 point, base64url; the browser subscribes with it. */
export type VapidKeys = { publicKey: string; privateKey: JsonWebKey };

export type PushOptions = {
  /** Who runs the server, for the push service: a mailto: or https: URL. */
  subject: string;
  /** How long the push service may hold the message while the phone is offline, in seconds. */
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
};

export type PushResult = { status: number; ok: boolean; gone: boolean };

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: toBase64Url(publicKey), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

/** The Authorization header value that identifies this server to the push service. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', keys.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/** Encrypts [plaintext] for one subscription as a single aes128gcm record. */
export async function encryptPayload(target: PushTarget, plaintext: Uint8Array, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  if (plaintext.length > RECORD_SIZE - 17) throw new Error('push payload too large');
  const receiverPublic = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);

  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const receiverKey = await crypto.subtle.importKey('raw', receiverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverKey }, sender.privateKey, 256));

  const ikm = await hkdf(authSecret, sharedSecret, concat(encoder.encode('WebPush: info\0'), receiverPublic, senderPublic), 32);
  const contentKey = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  // The 0x02 delimiter marks the last (here: only) record.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, concat(plaintext, Uint8Array.of(2))));

  const header = new Uint8Array(16 + 4 + 1 + senderPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = senderPublic.length;
  header.set(senderPublic, 21);
  return concat(header, ciphertext);
}

/** Sends one notification. A 404 or 410 means the subscription is gone for good. */
export async function sendPush(target: PushTarget, payload: string, keys: VapidKeys, options: PushOptions, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  const body = await encryptPayload(target, encoder.encode(payload));
  const response = await fetchImpl(target.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(options.ttl),
      Urgency: options.urgency ?? 'normal',
      Authorization: await vapidAuthorization(target.endpoint, keys, options.subject),
    },
    body,
  });
  await response.body?.cancel();
  return {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    gone: response.status === 404 || response.status === 410,
  };
}
