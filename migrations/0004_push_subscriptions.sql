-- =========================================
-- F1 Hub — migrations/0004_push_subscriptions.sql
-- Suscripciones de notificaciones push (Web Push estándar), asociadas
-- a la identidad anónima/usuario igual que el resto de la app.
-- =========================================

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id  TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  endpoint     TEXT NOT NULL UNIQUE,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_push_identity ON push_subscriptions(identity_id);
