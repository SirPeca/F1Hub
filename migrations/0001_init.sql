-- =========================================
-- F1 Hub — migrations/0001_init.sql
--
-- Base de datos relacional (Cloudflare D1 / SQLite) para todo lo que
-- necesita persistencia real más allá de un contador simple: identidad
-- de visitantes, cuentas, votaciones por GP, favoritos.
--
-- Diseño clave: TODO cuelga de `identities`, no directamente de un
-- usuario logueado. Un visitante anónimo ya tiene una identidad (cookie
-- firmada, ver functions/_middleware.js) desde el primer segundo, y
-- puede dar like / votar / marcar favoritos sin crear cuenta. Cuando
-- ese visitante se registra (Fase D), su identidad se vincula a un
-- `user_id` y conserva todo su historial — no hay migración de datos
-- ni "empezar de cero" al loguearse.
--
-- Aplicar con:
--   npx wrangler d1 execute f1hub-db --file=migrations/0001_init.sql
--   npx wrangler d1 execute f1hub-db --file=migrations/0001_init.sql --remote
-- =========================================

CREATE TABLE IF NOT EXISTS identities (
  id            TEXT PRIMARY KEY,          -- uuid v4, vive en cookie httpOnly firmada
  user_id       INTEGER,                   -- NULL hasta que se registre/loguee (Fase D)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE,
  password_hash   TEXT,                    -- NULL si es cuenta 100% OAuth
  email_verified  INTEGER NOT NULL DEFAULT 0,
  nickname        TEXT,
  avatar_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google','github')),
  provider_user_id  TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,            -- token aleatorio de sesión (no el de identidad)
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- ---------- Likes del sitio (contador real, sin abuso) ----------
CREATE TABLE IF NOT EXISTS site_likes (
  identity_id  TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  liked_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Votaciones por Gran Premio ----------
CREATE TABLE IF NOT EXISTS gp_polls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season        INTEGER NOT NULL,
  round         INTEGER NOT NULL,
  session_type  TEXT NOT NULL CHECK (session_type IN ('race','sprint')),
  opens_at      TEXT NOT NULL,             -- se habilita al terminar la clasificación previa
  closes_at     TEXT NOT NULL,             -- se cierra al largar la sesión
  winner_driver_id TEXT,                    -- se completa post-carrera (para % de acierto)
  UNIQUE (season, round, session_type)
);

CREATE TABLE IF NOT EXISTS gp_poll_votes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id      INTEGER NOT NULL REFERENCES gp_polls(id) ON DELETE CASCADE,
  identity_id  TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  driver_id    TEXT NOT NULL,
  voted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (poll_id, identity_id)             -- un voto por identidad por encuesta
);

-- ---------- Favoritos ----------
CREATE TABLE IF NOT EXISTS favorites (
  identity_id  TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('driver','constructor','circuit')),
  ref_id       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identity_id, kind, ref_id)
);

-- ---------- Índices ----------
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON gp_poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_favorites_identity ON favorites(identity_id);
