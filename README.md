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

## ⚠️ Sobre el deploy: por qué CLI y no el botón del dashboard

Si venís de una versión anterior de este proyecto: el botón **"Add
binding"** del dashboard de Cloudflare (Settings → Bindings) puede
aparecer inutilizable — confirmado en cuentas donde falla incluso en
un proyecto de Pages recién creado, en varios navegadores, en modo
incógnito. Es un problema del lado de Cloudflare, no de este proyecto,
pero mientras no lo resuelvan por soporte, la forma confiable de
bindear D1/KV es **desplegar por línea de comandos con Wrangler**, que
sí lee los bindings de `wrangler.toml` — evita el botón roto por
completo. Si en tu cuenta el botón del dashboard SÍ funciona, podés
saltear esta sección y bindear ahí normalmente; el resultado final es
el mismo.

## Setup completo — deploy por CLI (recomendado)

### 1) Preparación (una sola vez)

```bash
cd f1hub
npx wrangler login
```

Esto abre el navegador para autorizar Wrangler contra tu cuenta.

### 2) Crear D1 y KV (si todavía no existen)

```bash
npx wrangler d1 create f1hub-db
npx wrangler kv namespace create F1_KV
```

Cada comando te devuelve un ID. **Si ya los habías creado antes, no
hace falta repetir esto** — solo copiá los IDs existentes desde el
dashboard (Storage & Databases → D1 / KV, click en el recurso, el ID
aparece en Overview).

### 3) Completar `wrangler.toml` con esos IDs

Abrí `wrangler.toml` y confirmá que `database_id` y el `id` del KV
coincidan con los tuyos:

```toml
[[d1_databases]]
binding = "F1_DB"
database_name = "f1hub-db"
database_id = "TU_DATABASE_ID"

[[kv_namespaces]]
binding = "F1_KV"
id = "TU_KV_ID"
```

### 4) Aplicar las migraciones (una sola vez, o cuando agregues una nueva)

```bash
npx wrangler d1 execute f1hub-db --file=migrations/0001_init.sql --remote
npx wrangler d1 execute f1hub-db --file=migrations/0002_auth_extras.sql --remote
npx wrangler d1 execute f1hub-db --file=migrations/0003_favorites_label.sql --remote
npx wrangler d1 execute f1hub-db --file=migrations/0004_push_subscriptions.sql --remote
```

### 5) Cargar el secret de identidad (una sola vez)

```bash
npx wrangler pages secret put IDENTITY_SECRET --project-name=f1hub
# cualquier string largo y random, ej: openssl rand -hex 32
```

### 6) Desplegar

```bash
npx wrangler pages deploy web --project-name=f1hub
```

Este comando sube el contenido de `web/` + las funciones de
`functions/`, **con los bindings de D1/KV ya incluidos**, sin pasar
por el botón roto del dashboard en ningún momento. Te va a devolver una
URL — esa es tu sitio actualizado.

**A partir de ahora, este es el comando que corrés cada vez que querés
publicar cambios** (en vez de, o además de, hacer push a GitHub).

### 7) Importante: evitar que el deploy automático de GitHub pise este

Si tu proyecto todavía tiene conectado el repo de GitHub con deploy
automático, **cada push va a disparar OTRO deploy que no tiene los
bindings** (porque ese camino ignora `wrangler.toml`), y podría
pisar el deploy bueno que acabás de hacer por CLI.

Para evitarlo — dashboard → proyecto `f1hub` → **Settings → Builds &
deployments** → **Automatic deployments** → **desactivalo**. Github
sigue sirviendo como respaldo de tu código, simplemente ya no dispara
deploys solo; el deploy real pasa a ser siempre el comando del paso 6.

*(Alternativa más avanzada, opcional: automatizar el paso 6 con GitHub
Actions para que siga siendo "push y listo" pero usando Wrangler en vez
del integración nativa — preguntame si querés armar eso.)*

### 8) Hacerte administrador

Una vez que te registrás desde el sitio (botón 👤 → Crear cuenta
nueva):

```bash
npx wrangler d1 execute f1hub-db --remote --command="UPDATE users SET is_admin = 1 WHERE email = 'tu@mail.com'"
```

Después entrá a `/admin.html`.

### 9) Notificaciones push + campeonatos precalculados (opcional)

Dependen de un Worker aparte (`cron-worker/`) — ver su propio README.
Mismo criterio: `wrangler deploy` desde esa carpeta, sin pasar por el
dashboard para los bindings.

### 10) Opcional — Login con Google/GitHub, email de recuperación

Igual que antes: registrar las apps OAuth y/o Resend, cargar los
secrets correspondientes con `wrangler pages secret put`. Ver
`cron-worker/README.md` y los comentarios en `functions/api/auth/`
para el detalle exacto de cada secret.

## Verificar que todo quedó bien

```bash
node scripts/e2e-smoke-test.mjs https://TU-SITIO.pages.dev
```

Si `GET /api/config` devuelve `accounts:true` y el resto de los tests
pasan, los bindings están funcionando.

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
