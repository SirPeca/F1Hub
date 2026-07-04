-- =========================================
-- F1 Hub — migrations/0002_auth_extras.sql
-- Campos y tablas necesarias para Fase D (cuentas + admin) que no
-- entraban en el esquema inicial.
-- =========================================

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Para convertir el primer usuario administrador manualmente:
--   UPDATE users SET is_admin = 1 WHERE email = 'tu@mail.com';
