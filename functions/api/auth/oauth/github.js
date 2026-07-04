// =========================================
// F1 Hub — functions/api/auth/oauth/github.js
// Requiere secrets GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET.
// =========================================

export async function onRequestGet(context) {
  const { request, env } = context;
  if (!env.GITHUB_CLIENT_ID) {
    return new Response('Login con GitHub no está configurado todavía (falta GITHUB_CLIENT_ID).', { status: 503 });
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/oauth/github-callback`;
  const state = crypto.randomUUID();

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'read:user user:email');
  authUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      'Set-Cookie': `f1oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
