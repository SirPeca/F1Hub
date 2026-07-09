# f1hub-cron

Worker aparte (Cloudflare Pages Functions no soporta Cron Triggers —
confirmado en la documentación oficial de Cloudflare, hace falta un
Worker). Corre dos tareas programadas, comparte D1 y KV con el
proyecto de Pages.

## Setup

```bash
cd cron-worker
npm install
```

1. **Bindings**: en `wrangler.toml`, descomentá `[[d1_databases]]` y
   `[[kv_namespaces]]` con los **mismos IDs** que usaste en el proyecto
   de Pages (`f1hub`). Si no coinciden, este Worker no va a ver ni las
   suscripciones push ni compartir el caché de respaldo.

2. **Claves VAPID** — ya generé un par válido para que arranques sin
   depender de ninguna cuenta externa (Web Push no necesita una: es un
   estándar abierto). Cargalas como secrets de este Worker:

   ```bash
   npx wrangler secret put VAPID_PUBLIC_KEY
   # BLz0gv6C_2sAzmsbf_YA8x3OD9P50O9GdjV_Tsy72QgNmZe1niqotskk_ZkSEGpHPrB8onSFWI7cYpjn6Ss7wfA

   npx wrangler secret put VAPID_PRIVATE_KEY
   # 0yga2CcouQfSeqDKs8BzWdi8Fwi88jSNE04XcKSFNY4

   npx wrangler secret put VAPID_SUBJECT
   # mailto:tu@mail.com  (contacto que ven los navegadores/servicios push si algo falla)
   ```

   La clave pública ya está hardcodeada en `web/app.js` (`VAPID_PUBLIC_KEY`)
   del lado de Pages — **si regenerás el par, actualizala ahí también**,
   sino las suscripciones nuevas no van a matchear con lo que firma este
   Worker.

3. **Deploy**:
   ```bash
   npx wrangler deploy
   ```

4. **Verificar que corre**: dashboard de Cloudflare → Workers & Pages →
   `f1hub-cron` → Settings → Triggers → Cron Triggers, deberías ver los
   dos schedules. "Past Cron Events" tarda hasta 30 min en poblarse la
   primera vez.

## Qué hace cada schedule

- **`*/15 * * * *`**: busca sesiones que arrancan en los próximos 15
  minutos y manda un push a todas las suscripciones activas. Usa KV
  para no mandar el mismo aviso dos veces (`notified:{carrera}:{sesión}`,
  TTL 6h).
- **`0 4 * * *`**: recorre todas las temporadas desde 1950 hasta hoy
  (una request liviana por temporada a Jolpica, con 250ms de pausa
  entre cada una para no saturar su rate limit) y guarda en KV cuántos
  campeonatos tiene cada piloto. `functions/api/compare.js` (del lado
  de Pages) lee ese resultado.
- **`30 4 * * *`** (NUEVO): precalcula victorias/podios/poles/temporadas
  completas para ~45 pilotos (grid actual + leyendas de alta demanda
  como Schumacher, Senna, Vettel, Alonso) y las deja en KV bajo
  `precomputed:driverstats`. Esto es lo que hace que Comparar y
  Favoritos dejen de depender de calcular en vivo cada vez — antes
  cualquier hipo de Jolpica en el momento exacto de la consulta hacía
  fallar la comparación; ahora, para estos ~45 pilotos, ni siquiera se
  toca la red en el momento — es una simple lectura de KV.

## Importante: esto no lo pude probar en vivo

Escribí este Worker usando la librería estándar `web-push` (la misma
que usa la mayoría de sitios en producción) y con `nodejs_compat`
activado, que es el patrón recomendado por Cloudflare para correrla
en Workers. Pero no tengo forma de mandarme un push de prueba a mí
mismo desde este entorno — así que apenas lo despliegues, probalo con
un dispositivo real (activá el 🔔 en el sitio y esperá a que haya una
sesión dentro de 15 minutos, o simulá con `wrangler dev --test-scheduled`)
y avisame si algo no llega — es la pieza menos probada de todo el
proyecto y la que más me gustaría revisar con datos reales.
