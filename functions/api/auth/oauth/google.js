// =========================================
// F1 Hub — functions/api/auth/oauth/google.js
//
// GET /api/auth/oauth/google -> redirige a la pantalla de consentimiento
// de Google. Requiere los secrets GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET
// (ver README, sección OAuth). Sin ellos, responde 503 explicando qué
// falta en vez de redirigir a una URL rota.
// =========================================

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.GOOGLE_CLIENT_ID) {
    return new Response('Login con Google no está configurado todavía (falta GOOGLE_CLIENT_ID).', { status: 503 });
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/oauth/google-callback`;
  const state = crypto.randomUUID();

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      // Cookie corta solo para validar el `state` al volver (anti-CSRF)
      'Set-Cookie': `f1oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
