#!/usr/bin/env node
// =========================================
// F1 Hub — scripts/e2e-smoke-test.mjs
//
// Prueba de humo end-to-end contra un despliegue REAL (Cloudflare
// Pages + D1 + KV), no contra un mock. Corre los flujos críticos:
// config, datos públicos, registro, sesión, favoritos, logout,
// encuesta. Pensado para correr antes de cada release, tal como
// pediste en el punto 10.
//
// Uso:
//   node scripts/e2e-smoke-test.mjs https://tu-sitio.pages.dev
//   (o) BASE_URL=https://tu-sitio.pages.dev node scripts/e2e-smoke-test.mjs
//
// Requiere Node 18+ (fetch nativo). No instala nada.
// =========================================

const BASE_URL = process.argv[2] || process.env.BASE_URL;
if (!BASE_URL) {
  console.error('Uso: node scripts/e2e-smoke-test.mjs https://tu-sitio.pages.dev');
  process.exit(1);
}

// ---------- cookie jar mínimo (Node fetch no maneja cookies solo) ----------
const cookies = new Map();

function cookieHeader() {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const line of raw) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function call(method, path, body) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookieHeader() ? { Cookie: cookieHeader() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  storeCookies(res);
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { /* respuesta no-JSON: la dejamos en null y avisamos abajo */ }
  return { status: res.status, ok: res.ok, data, rawTextIfNotJson: data === null ? text.slice(0, 200) : null };
}

// ---------- runner ----------
let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}`);
    console.log(`   → ${err.message}`);
    failed++;
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const testEmail = `e2e-test-${Date.now()}@example.com`;
const testPassword = 'TestPassword123!';
let config = {};

console.log(`\nF1 Hub — smoke test contra ${BASE_URL}\n`);

await test('GET /api/config responde', async () => {
  const r = await call('GET', '/api/config');
  assert(r.ok, `status ${r.status}, body: ${r.rawTextIfNotJson || JSON.stringify(r.data)}`);
  config = r.data;
});

await test('GET /api/calendar devuelve carreras', async () => {
  const r = await call('GET', '/api/calendar');
  assert(r.ok, `status ${r.status}`);
  assert(r.data.unavailable === false, 'el backend marcó unavailable:true (proveedor externo caído o bug)');
  assert(Array.isArray(r.data.races) && r.data.races.length > 0, 'no vinieron carreras');
});

await test('GET /api/standings?type=drivers devuelve posiciones', async () => {
  const r = await call('GET', '/api/standings?type=drivers');
  assert(r.ok, `status ${r.status}`);
  assert(Array.isArray(r.data.standings) && r.data.standings.length > 0, 'no vinieron pilotos en la tabla');
});

await test('GET /api/search?q=hamilton devuelve resultados', async () => {
  const r = await call('GET', '/api/search?q=hamilton');
  assert(r.ok, `status ${r.status}, body: ${r.rawTextIfNotJson || JSON.stringify(r.data)}`);
  assert(Array.isArray(r.data.drivers) && r.data.drivers.length > 0, 'el buscador no encontró a Hamilton — revisar functions/api/search.js');
});

await test('GET /api/compare funciona con dos pilotos válidos', async () => {
  const r = await call('GET', '/api/compare?a=hamilton&b=max_verstappen');
  assert(r.ok, `status ${r.status}, body: ${r.rawTextIfNotJson || JSON.stringify(r.data)}`);
  assert(r.data.a?.name && r.data.b?.name, 'faltan nombres de piloto en la respuesta del comparador');
});

if (config.accounts) {
  await test('POST /api/auth/register crea una cuenta de prueba', async () => {
    const r = await call('POST', '/api/auth/register', { email: testEmail, password: testPassword, nickname: 'E2E Test' });
    assert(r.ok, `status ${r.status}, body: ${r.rawTextIfNotJson || JSON.stringify(r.data)} — si esto fallla con HTML en vez de JSON, probablemente falta una migración de D1`);
    assert(r.data.user?.email === testEmail, 'la respuesta de registro no trae el usuario esperado');
  });

  await test('GET /api/auth/me refleja la sesión recién creada', async () => {
    const r = await call('GET', '/api/auth/me');
    assert(r.ok, `status ${r.status}`);
    assert(r.data.user?.email === testEmail, 'la sesión no persistió entre requests (revisar cookies/D1 sessions)');
  });

  if (config.likesAndVotesAndFavorites) {
    await test('POST /api/favorites agrega un favorito', async () => {
      const r = await call('POST', '/api/favorites', { kind: 'driver', refId: 'hamilton', label: 'Lewis Hamilton' });
      assert(r.ok, `status ${r.status}, body: ${r.rawTextIfNotJson || JSON.stringify(r.data)} — si falla, revisar que la migración 0003 (columna label) esté aplicada`);
      assert(r.data.favorited === true, 'el favorito no quedó marcado como agregado');
    });

    await test('GET /api/favorites incluye el favorito recién creado', async () => {
      const r = await call('GET', '/api/favorites');
      assert(r.ok, `status ${r.status}`);
      assert(r.data.favorites?.some((f) => f.refId === 'hamilton'), 'el favorito no persistió');
    });

    await test('POST /api/favorites de nuevo lo saca (toggle)', async () => {
      const r = await call('POST', '/api/favorites', { kind: 'driver', refId: 'hamilton', label: 'Lewis Hamilton' });
      assert(r.ok && r.data.favorited === false, 'el toggle no sacó el favorito');
    });

    await test('GET /api/poll responde con forma válida', async () => {
      const r = await call('GET', '/api/poll');
      assert(r.ok, `status ${r.status}`);
      // poll puede ser null si no hay ningún GP próximo — no es un fallo
    });

    await test('POST /api/poll vota estando logueado', async () => {
      const r = await call('GET', '/api/poll');
      if (!r.data.poll || !r.data.poll.isOpen) {
        console.log('   ⚠️  (sin encuesta abierta ahora mismo, se omite el voto — no es un fallo)');
        return;
      }
      assert(r.data.poll.requiresLogin === false, 'el poll dice requiresLogin:true estando logueado — no debería');
      const driverId = r.data.poll.options[0]?.driverId;
      assert(driverId, 'la encuesta está abierta pero no trae opciones de piloto');
      const vote = await call('POST', '/api/poll', { pollId: r.data.poll.id, driverId });
      assert(vote.ok, `status ${vote.status}, body: ${vote.rawTextIfNotJson || JSON.stringify(vote.data)}`);
    });
  }

  await test('POST /api/auth/logout cierra la sesión', async () => {
    const r = await call('POST', '/api/auth/logout');
    assert(r.ok, `status ${r.status}`);
  });

  await test('GET /api/auth/me ya no devuelve usuario tras logout', async () => {
    const r = await call('GET', '/api/auth/me');
    assert(r.ok, `status ${r.status}`);
    assert(r.data.user === null, 'el logout no invalidó la sesión');
  });

  await test('POST /api/poll rechaza el voto sin sesión (integridad)', async () => {
    const r = await call('GET', '/api/poll');
    if (!r.data.poll) { console.log('   ⚠️  (sin encuesta activa, se omite)'); return; }
    assert(r.data.poll.requiresLogin === true, 'sin sesión, el poll debería pedir login (requiresLogin:true)');
    const driverId = r.data.poll.options[0]?.driverId;
    if (!driverId) return;
    const vote = await call('POST', '/api/poll', { pollId: r.data.poll.id, driverId });
    assert(vote.status === 401 && vote.data?.error === 'login_required', `se esperaba 401 login_required, llegó status ${vote.status}`);
  });
} else {
  console.log('⚠️  /api/config dice accounts:false — se omiten las pruebas de cuentas/favoritos/encuesta.');
}

console.log(`\n${passed} OK · ${failed} fallaron\n`);
process.exit(failed > 0 ? 1 : 0);
