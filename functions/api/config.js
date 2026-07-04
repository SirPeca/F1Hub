// =========================================
// F1 Hub — functions/api/config.js
//
// GET /api/config
//
// El frontend usa esto para decidir qué mostrar como funcional y qué
// marcar "Próximamente" — nunca mostrar un botón que no hace nada.
// No expone secrets, solo booleanos de "¿está configurado o no?".
// =========================================

export async function onRequestGet(context) {
  const { env } = context;
  return new Response(JSON.stringify({
    accounts: Boolean(env.F1_DB),
    likesAndVotesAndFavorites: Boolean(env.F1_DB),
    resilientCache: Boolean(env.F1_KV),
    oauthGoogle: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    oauthGithub: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    emailRecovery: Boolean(env.RESEND_API_KEY),
    pushNotifications: Boolean(env.F1_DB), // el envío en sí depende de cron-worker, pero guardar la suscripción necesita D1
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } });
}
