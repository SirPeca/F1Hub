# F1 Hub

Calendario, en vivo, posiciones, historia, comparador, favoritos,
votaciones por GP, cuentas de usuario y noticias de Fórmula 1. Sin
publicidad, sin apps que rastrean. PWA instalable sobre Cloudflare
Pages + Functions + D1 + KV.

## Stack

- **Frontend**: HTML/CSS/JS vanilla (sin build step), PWA instalable.
- **Backend**: Cloudflare Pages Functions (`/functions/api/*`).
- **Persistencia**:
  - **D1** (`F1_DB`): usuarios, sesiones, identidades anónimas, likes,
    votaciones por GP, favoritos.
  - **KV** (`F1_KV`): caché de respaldo ante caídas de Jolpica, y rate
    limiting de endpoints sensibles (login/registro).
- **Datos externos**:
  - [Jolpica-F1](https://github.com/jolpica/jolpica-f1) — calendario,
    resultados, posiciones, historia, comparador.
  - [OpenF1](https://openf1.org) — estado de sesión en vivo (el modo
    en vivo real requiere cuenta *supporter* de pago; ver `live.js`).
  - RSS de Autosport, Motorsport.com y RaceFans — noticias.
  - Wikipedia REST API — fotos e info con licencia libre (Wikimedia
    Commons) de pilotos/equipos, NO fotos con copyright de agencias.

## Setup completo (orden recomendado)

### 1) Deploy base (ya lo tenías de v1)

```bash
cd f1hub
git init && git add -A && git commit -m "F1 Hub v2"
git remote add origin https://github.com/TU_USUARIO/f1-hub.git
git push -u origin main
```

Conectar en Cloudflare Pages: **Build command**: vacío · **Build output
directory**: `web`.

### 2) D1 — base de datos (necesaria para likes, votos, favoritos, cuentas)

**Importante:** como este proyecto se despliega vía integración Git
(push a GitHub → Cloudflare hace el build), los bindings de D1/KV se
configuran **solo desde el dashboard**, nunca desde `wrangler.toml`
(Cloudflare Pages ignora esos bloques del archivo en este modo de
deploy — es un comportamiento documentado de Cloudflare, no un bug
nuestro, pero mezclar los dos métodos genera confusión y bindings que
"desaparecen"). Los comandos de `wrangler d1 create` y `wrangler d1
execute` sí funcionan siempre por CLI porque solo crean/modifican la
base de datos en sí, no la bindean a un proyecto.

**Paso a paso (una sola vez):**

1. Crear la base de datos (necesitás Node.js instalado):
   ```bash
   npx wrangler d1 create f1hub-db
   ```
   Guardá el `database_id` que te devuelve, lo vas a necesitar en el paso 3.

2. Aplicar las 4 migraciones en orden:
   ```bash
   npx wrangler d1 execute f1hub-db --file=migrations/0001_init.sql --remote
   npx wrangler d1 execute f1hub-db --file=migrations/0002_auth_extras.sql --remote
   npx wrangler d1 execute f1hub-db --file=migrations/0003_favorites_label.sql --remote
   npx wrangler d1 execute f1hub-db --file=migrations/0004_push_subscriptions.sql --remote
   ```

3. **Bindear desde el dashboard** (esto es lo que realmente conecta la
   base de datos a tu sitio):
   - Cloudflare dashboard → **Workers & Pages**.
   - Click en **`f1hub`** — el que dice **Pages** al lado (no el que
     dice Worker, ese es `f1hub-cron` y es otra cosa).
   - **Settings** → **Bindings** → **Add binding**.
   - Tipo: **D1 database**.
   - Variable name (tiene que ser EXACTO, mayúsculas incluidas): `F1_DB`
   - D1 database: elegí `f1hub-db` de la lista.
   - Fijate que el selector de entorno arriba diga **Production**
     (algunos dashboards piden repetir el mismo paso para "Preview"
     también — si tenés la opción, agregalo en los dos).
   - **Save**.

4. **Redeploy**: los bindings nuevos no aplican solos, necesitás un
   deploy nuevo. Alcanza con: dashboard → pestaña **Deployments** →
   en el último deploy, menú (···) → **Retry deployment**. (O hacer
   cualquier `git push`, lo que sea más cómodo.)

### 3) KV — caché de respaldo + rate limiting

Mismo criterio que D1: crear por CLI, bindear por dashboard.

1. ```bash
   npx wrangler kv namespace create F1_KV
   ```
2. Dashboard → `f1hub` (Pages) → **Settings** → **Bindings** → **Add binding**
   → tipo **KV namespace** → variable name **`F1_KV`** → elegí el
   namespace creado → confirmá que esté en **Production** → **Save**.
3. Redeploy (mismo paso que arriba).

Sin esto, el sitio funciona igual pero pierde el amortiguador ante
caídas de Jolpica y el rate-limit de login/registro.

### 4) Secret de identidad (obligatorio para que las cookies anónimas sean seguras)

A diferencia de D1/KV, los **secrets sí son consistentes** entre CLI y
dashboard — cualquiera de los dos métodos funciona:

```bash
npx wrangler pages secret put IDENTITY_SECRET --project-name=f1-hub
# cualquier string largo y random, ej: openssl rand -hex 32
```
(o desde el dashboard: Settings → Environment variables → Add → tildar "Encrypt").

### 5) Convertirte en administrador

Una vez que te registrás desde el sitio (botón 👤 > Crear cuenta), corré:

```bash
npx wrangler d1 execute f1hub-db --remote --command="UPDATE users SET is_admin = 1 WHERE email = 'tu@mail.com'"
```

Después entrá a `/admin.html`.

### 6) Opcional — Login con Google/GitHub

**Google**: [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
→ Create Credentials → OAuth Client ID → tipo "Web application" →
Authorized redirect URI: `https://TU_DOMINIO/api/auth/oauth/google-callback`.

**GitHub**: Settings → Developer settings → OAuth Apps → New OAuth App
→ Authorization callback URL: `https://TU_DOMINIO/api/auth/oauth/github-callback`.

Cargá los 4 secrets:
```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=f1-hub
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=f1-hub
npx wrangler pages secret put GITHUB_CLIENT_ID --project-name=f1-hub
npx wrangler pages secret put GITHUB_CLIENT_SECRET --project-name=f1-hub
```
Sin esto, los botones de Google/GitHub responden 503 con un mensaje
claro — el login con email/contraseña funciona igual sin esto.

### 7) Opcional — Email transaccional (verificación / reset de contraseña)

Hoy las cuentas quedan **auto-verificadas** (no hay envío de mail
todavía). Para activarlo: creá cuenta en [Resend](https://resend.com),
verificá tu dominio, y:
```bash
npx wrangler pages secret put RESEND_API_KEY --project-name=f1-hub
```
En cuanto ese secret exista, `register.js` deja de auto-verificar y
falta cablear el envío del mail (marcado con `TODO` en el archivo) —
avisame cuando tengas la cuenta de Resend y lo termino.

### 8) Cloudflare Web Analytics (opcional, recomendado)

Dashboard del proyecto de Pages → Analytics & Logs → Web Analytics →
activar. Te da visitas, países, dispositivos y navegadores sin cookies
y sin tocar código — es lo que usa el punto 6 del pedido original en
vez de reinventar tracking propio.

### 9) Notificaciones push + campeonatos precalculados

Ambos dependen de un Worker aparte (Pages no soporta Cron Triggers).
Ver `cron-worker/README.md` — son ~5 minutos de setup, las claves
VAPID ya están generadas.

## Pruebas end-to-end contra el sitio real (antes de cada release)

```bash
node scripts/e2e-smoke-test.mjs https://tu-sitio.pages.dev
```

Corre contra tu despliegue real (Pages + D1 + KV reales, no un mock):
config, calendario, posiciones, buscador, comparador, y si las cuentas
están activadas, registro → sesión → favoritos (agregar/sacar) →
encuesta → logout, con un usuario de prueba descartable. Requiere
Node 18+, no instala nada. Si algo falla, el mensaje de error apunta a
qué archivo/migración revisar — por ejemplo, un fallo en el registro
con una respuesta no-JSON casi siempre significa una migración de D1
faltante.

## Estructura

```
f1hub/
├── migrations/                 (4 archivos SQL, aplicar en orden)
├── cron-worker/                 Worker aparte: push + precálculo (ver su README)
├── web/
│   ├── index.html / admin.html
│   ├── styles.css / app.js / sw.js
│   ├── manifest.json / robots.txt / sitemap.xml
│   └── icon-192.png / icon-512.png
└── functions/
    ├── _lib/                   (código compartido, no genera rutas)
    │   ├── upstream.js          fetch con reintentos + fallback KV
    │   ├── identity.js          cookie anónima firmada (HMAC)
    │   ├── session.js           sesiones de usuario logueado
    │   ├── password.js          hashing PBKDF2
    │   └── ratelimit.js         rate limiting sobre KV
    └── api/
        ├── _middleware.js       resuelve la identidad en cada request
        ├── calendar.js / standings.js / history.js / live.js / news.js
        ├── likes.js / poll.js / favorites.js / search.js / compare.js / media.js
        ├── push/subscribe.js / unsubscribe.js
        ├── auth/
        │   ├── register.js / login.js / logout.js / me.js
        │   └── oauth/google.js, google-callback.js, github.js, github-callback.js
        └── admin/
            ├── stats.js
            └── poll-result.js
```

## Qué falta para el roadmap original (y por qué)

- **Notificaciones push**: código completo (`cron-worker/`, VAPID
  generadas, botón 🔔 en el sitio) pero **sin probar contra un push
  service real** — ver `cron-worker/README.md` para el motivo y cómo
  validarlo vos.
- **Campeonatos en el comparador**: ya se calculan, pero dependen de
  que despliegues `cron-worker/` (corre 1 vez por día). Hasta el primer
  deploy de ese Worker, el comparador muestra "se calculan con un
  proceso diario aparte" en vez de un número.
- **Resúmenes con IA / asistente de reglas**: no implementado en esta
  entrega — implica costos por request y merece su propio diseño
  (cache de respuestas, límites de uso) para no salir caro apenas
  tenga tráfico. Se puede armar como `functions/api/ai/*` llamando a la
  API de Claude con la key de Anthropic como secret.
- **Verificación de email real**: el código está, falta conectar
  Resend (ver punto 7 arriba).
- **Login OAuth**: el código está completo y funcional, falta que
  registres las apps en Google/GitHub y cargues los secrets.

## Caché (resumen)

| Endpoint | TTL |
|---|---|
| `/api/calendar`, `/api/poll` (calendario interno) | 15 min |
| `/api/standings` | 10 min |
| `/api/history` (pasado / actual) | 24h / 15 min |
| `/api/search` (listas completas) | 24h |
| `/api/media` | 7 días |
| `/api/live` (activo / inactivo) | 15 s / 5 min |
| `/api/news` | 10 min |
| `/api/likes`, `/api/favorites`, `/api/auth/*` | sin caché (siempre en vivo) |
