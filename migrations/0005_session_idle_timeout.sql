-- =========================================
-- F1 Hub — migrations/0005_session_idle_timeout.sql
-- Agrega el campo que permite expirar sesiones por INACTIVIDAD, no solo
-- por antigüedad absoluta (pedido de seguridad: buena práctica estándar
-- de idle timeout para reducir el riesgo de sesiones olvidadas en
-- equipos compartidos).
-- =========================================

ALTER TABLE sessions ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT (datetime('now'));
