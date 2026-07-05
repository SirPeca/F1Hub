// =========================================
// F1 Hub — functions/_lib/password.js
//
// Hashing de contraseñas con PBKDF2-SHA256 vía Web Crypto nativo
// (Cloudflare Workers no trae bcrypt, y sumar una dependencia externa
// con WASM solo para esto no vale la pena). 210,000 iteraciones sigue
// la recomendación 2023+ de OWASP para PBKDF2-HMAC-SHA256.
//
// Formato de hash almacenado: "pbkdf2:{iteraciones}:{saltB64}:{hashB64}"
// para poder subir las iteraciones en el futuro sin romper los hashes
// existentes.
// =========================================

// Cloudflare Workers/Pages impone un tope DURO de 100,000 iteraciones
// para PBKDF2 (hardcodeado en su runtime, workerd, para evitar abuso de
// CPU en un entorno multi-tenant) — pedir más no lo ajusta, tira una
// excepción. OWASP recomienda 600,000 para PBKDF2-SHA256, así que este
// es un techo de la plataforma, no una elección de seguridad ideal.
// Documentado acá para que quede claro por qué el número es "raro":
// https://github.com/cloudflare/workerd/issues/1346
const ITERATIONS = 100_000;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashBuf = await derive(password, salt, ITERATIONS);
  return `pbkdf2:${ITERATIONS}:${toB64(salt)}:${toB64(hashBuf)}`;
}

export async function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = fromB64(parts[2]);
  const expectedHash = parts[3];
  const hashBuf = await derive(password, salt, iterations);
  return timingSafeEqual(toB64(hashBuf), expectedHash);
}

async function derive(password, salt, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256,
  );
}

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
