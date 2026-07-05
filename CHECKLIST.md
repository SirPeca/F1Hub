# Checklist previo a cada release

Repetir esto antes de dar una versión por cerrada, no solo la primera vez.

## 1) Funcional
- [ ] Cada botón/link visible hace exactamente lo que promete, o está oculto.
- [ ] Ninguna sección muestra un mensaje que mencione infraestructura interna
      (nombres de proveedores, "base de datos", "API", nombres de tablas, etc.)
      — solo lenguaje orientado al usuario.
- [ ] Probar con `/api/config` devolviendo todo en `false` (sitio recién
      creado, sin D1/KV) — nada debería verse roto, solo oculto.
- [ ] Probar con todo configurado — todo lo oculto antes debería aparecer
      y funcionar.

## 2) Seguridad
- [ ] Todo input de usuario que se renderiza en HTML pasa por `esc()` en
      el frontend (buscar nuevas interpolaciones `${...}` en innerHTML).
- [ ] Todo input que se guarda en D1 se sanitiza/trunca en el backend,
      no se confía en que venga siempre de la UI propia.
- [ ] Nuevos endpoints POST/DELETE tienen rate limiting si pueden ser
      invocados repetidamente por el mismo visitante.
- [ ] Ningún error devuelto al cliente incluye `String(err)`, stack
      traces, ni detalle interno — mensajes genéricos + código corto.
- [ ] Cookies nuevas son HttpOnly + Secure + SameSite (usar `_lib/identity.js`
      o `_lib/session.js`, no inventar cookies sueltas).
- [ ] Endpoints que tocan datos de "otro" (favoritos, push, sesiones)
      filtran por `identity_id`/`user_id` del que hace la request, nunca
      solo por un id que venga en el body.

## 3) Deploy
- [ ] `node --check` sobre todos los `.js` tocados.
- [ ] Balance de tags en cualquier HTML tocado.
- [ ] Si se agregó una tabla nueva: hay una migración numerada nueva
      (nunca editar una migración ya aplicada en producción).
- [ ] `wrangler.toml` actualizado si hay bindings nuevos, con el paso
      documentado en el README.
- [ ] Cache-busting: si cambiaste `sw.js`, confirmá que el nombre de
      `SHELL_CACHE` se haya actualizado (o que el contenido cambió lo
      suficiente para que el navegador lo detecte).

## 4) UX / pulido
- [ ] Todo estado de carga tiene skeleton o mensaje, nunca pantalla en blanco.
- [ ] Todo estado de error tiene acción de reintento cuando aplica.
- [ ] Probado en una pantalla angosta (mobile) y una ancha (desktop).
- [ ] Navegación por teclado (Tab, flechas en tabs, Escape en overlays)
      sigue funcionando.
