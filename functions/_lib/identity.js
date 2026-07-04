// =========================================
// F1 Hub — functions/_lib/identity.js
//
// Cookie anónima firmada (HMAC-SHA256, Web Crypto nativo — sin libs).
// Identifica a un visitante sin pedirle registro. El id es un uuid v4
// generado en el borde; la firma evita que alguien fabrique o pise el
// id de otra persona a mano.
// =========================================

export async function signValue(value, secret) {
  const key = await hmacKey(secret);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64url(sigBuf);
}

export async function verifyValue(value, signature, secret) {
  const expected = await signValue(value, secret);
  return timingSafeEqual(expected, signature);
}

export function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    if (p.slice(0, idx) === name) return decodeURIComponent(p.slice(idx + 1));
  }
  return null;
}

export function serializeCookie(name, value, { maxAgeSeconds } = {}) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ];
  if (maxAgeSeconds) attrs.push(`Max-Age=${maxAgeSeconds}`);
  return attrs.join('; ');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function base64url(buf) {
  let str = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
