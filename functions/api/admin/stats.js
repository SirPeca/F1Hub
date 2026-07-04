// =========================================
// F1 Hub — functions/api/admin/stats.js
// GET /api/admin/stats — requiere sesión de un usuario con is_admin=1
//
// Nota sobre "visitas/países/navegadores/dispositivos" (punto 6 del
// pedido original): en vez de reinventar un sistema de analítica propio
// (que implicaría trackear IPs y sumar peso a cada página), lo correcto
// en el ecosistema Cloudflare es activar **Cloudflare Web Analytics**
// (gratis, sin cookies, sin JS bloqueante) desde el dashboard del sitio
// — Analytics & Logs > Web Analytics. Esta función expone las métricas
// que SÍ son propias de la aplicación (que no puede darte Web Analytics):
// likes, cuentas, identidades, y resultados de las votaciones.
// =========================================

import { getUserFromRequest } from '../../_lib/session.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.F1_DB) return json({ error: 'not_configured' }, 503);

  const user = await getUserFromRequest(request, env.F1_DB);
  if (!user || !user.is_admin) return json({ error: 'forbidden' }, 403);

  const [identities, users, likes, polls] = await Promise.all([
    env.F1_DB.prepare('SELECT COUNT(*) c FROM identities').first(),
    env.F1_DB.prepare('SELECT COUNT(*) c FROM users').first(),
    env.F1_DB.prepare('SELECT COUNT(*) c FROM site_likes').first(),
    env.F1_DB.prepare(`
      SELECT p.id, p.season, p.round, p.session_type, p.opens_at, p.closes_at, p.winner_driver_id,
             COUNT(v.id) as total_votes
      FROM gp_polls p LEFT JOIN gp_poll_votes v ON v.poll_id = p.id
      GROUP BY p.id ORDER BY p.season DESC, p.round DESC LIMIT 20
    `).all(),
  ]);

  return json({
    identitiesTotal: identities?.c ?? 0,
    usersTotal: users?.c ?? 0,
    likesTotal: likes?.c ?? 0,
    recentPolls: polls?.results ?? [],
    note: 'Para visitas/países/dispositivos, ver Cloudflare Web Analytics en el dashboard del proyecto.',
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
