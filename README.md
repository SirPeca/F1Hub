# F1 Hub

Calendario, en vivo, posiciones, historia y noticias de Fórmula 1.
Sin publicidad, sin registro, sin apps que rastrean. Hecho como PWA
(instalable) con Cloudflare Pages + Functions.

## Stack

- **Frontend**: HTML/CSS/JS vanilla (sin build step), PWA instalable.
- **Backend**: Cloudflare Pages Functions (`/functions/api/*`), actúan
  como proxy/caché de las APIs externas — el navegador nunca las llama
  directo (evita CORS, rate limits, y permite cachear en el edge).
- **Datos**:
  - [Jolpica-F1](https://github.com/jolpica/jolpica-f1) — calendario,
    resultados, posiciones, historia. Sucesor directo de Ergast (que
    cerró en 2024), mismo formato de respuesta.
  - [OpenF1](https://openf1.org) — estado de sesión "en vivo". El
    histórico es gratis; el modo en vivo real (posiciones minuto a
    minuto durante la sesión) requiere una cuenta *supporter* de pago
    de OpenF1. Ver sección "En vivo" abajo.
  - RSS de Autosport, Motorsport.com y RaceFans — noticias, parseadas
    server-side, siempre con link a la nota original.

## Estructura

```
f1hub/
├── wrangler.toml
├── web/                    ← se sirve como sitio estático
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── sw.js                (service worker, shell offline)
│   ├── manifest.json
│   ├── _headers              (seguridad + cache headers)
│   ├── icon-192.png
│   └── icon-512.png
└── functions/
    └── api/
        ├── calendar.js       GET /api/calendar
        ├── standings.js      GET /api/standings?type=drivers|constructors&year=YYYY
        ├── history.js        GET /api/history?mode=year|circuit|circuits&...
        ├── live.js           GET /api/live
        └── news.js           GET /api/news
```

## Deploy — GitHub + Cloudflare Pages (CI/CD automático)

1. **Crear el repo en GitHub** (podés llamarlo `f1-hub`) y subir esta
   carpeta tal cual está:
   ```bash
   cd f1hub
   git init
   git add .
   git commit -m "F1 Hub — v1"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/f1-hub.git
   git push -u origin main
   ```

2. **Conectar el repo en Cloudflare Pages**:
   - Dashboard de Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
   - Elegí el repo `f1-hub`.
   - Build settings:
     - **Framework preset**: None
     - **Build command**: (dejar vacío — no hay build step)
     - **Build output directory**: `web`
   - Deploy. Cloudflare va a detectar automáticamente `functions/` y
     desplegar cada archivo como una Function.

3. **Listo.** Desde ese momento, cada `git push` a `main` dispara un
   deploy automático (y cada Pull Request te da un preview URL aparte,
   útil para probar cambios antes de mergear).

4. **Dominio propio** (opcional): en el proyecto de Pages → **Custom
   domains** → agregá tu dominio o subdominio, igual que hiciste con
   tus otros dos proyectos.

## Variables de entorno (opcional)

Si en algún momento pagás una cuenta *supporter* de OpenF1 para tener
datos en vivo reales durante la sesión:

```bash
npx wrangler pages secret put OPENF1_TOKEN --project-name=f1-hub
```

`functions/api/live.js` lo detecta solo (usa `Authorization: Bearer`)
sin que haya que tocar nada más del código.

## "En vivo": qué esperar sin cuenta de pago

OpenF1 separa sus datos en dos franjas:

- **Históricos** (sesión terminada hace más de 30 min): libres, sin
  límite de autenticación.
- **En vivo** (desde 30 min antes de una sesión hasta 30 min después):
  requieren cuenta *supporter* de OpenF1.

Sin esa cuenta, la pestaña "En vivo" va a mostrar igual la sesión
activa (nombre, circuito, horario) y avisa explícitamente que las
posiciones en tiempo real no están disponibles — nunca inventa datos
ni se rompe. En cuanto termina la sesión, esa misma información pasa a
estar disponible como "histórico" gratis (aparece reflejada en
Calendario/Posiciones/Historia con normalidad).

## Caché

Cada función usa la Cache API de Cloudflare (`caches.default`) con TTL
ajustado a qué tan rápido cambia cada dato:

| Endpoint | TTL |
|---|---|
| `/api/calendar` | 15 min |
| `/api/standings` | 10 min |
| `/api/history` (temporadas pasadas) | 24 h |
| `/api/history` (temporada actual) | 15 min |
| `/api/live` (sesión activa) | 15 s |
| `/api/live` (sin sesión activa) | 5 min |
| `/api/news` | 10 min |

Esto además protege el rate limit de Jolpica (200–500 req/hora sin
auth) y de OpenF1 (3 req/s, 30 req/min).

## Roadmap sugerido

- Goleadores → no existe un equivalente directo en F1 (no hay "goles"),
  pero se puede armar un ranking de vueltas rápidas / poles / podios
  por piloto y temporada reusando `/api/history`.
- Push notifications para "faltan 10 min para que arranque" (Web Push
  + Cloudflare Cron Triggers).
- Sección "circuitos" con mapa del trazado (SVG) por Gran Premio.
