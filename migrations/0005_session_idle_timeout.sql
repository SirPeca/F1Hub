-- =========================================
-- F1 Hub — migrations/0005_session_idle_timeout.sql
--
-- Agrega el campo que permite expirar sesiones por INACTIVIDAD, no solo
-- por antigüedad absoluta (idle timeout).
--
-- Nota técnica: SQLite no permite `ALTER TABLE ADD COLUMN` con un
-- default que sea el resultado de una función (como datetime('now')) —
-- solo acepta constantes literales para esa operación puntual. Por eso
-- el patrón acá es: 1) agregar la columna con una constante vacía,
-- 2) rellenar las filas existentes con la fecha actual. Las sesiones
-- NUEVAS de acá en más reciben el valor real al crearse explícitamente
-- desde el código (functions/_lib/session.js), no del default de la
-- columna.
-- =========================================

ALTER TABLE sessions ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';

UPDATE sessions SET last_seen_at = datetime('now') WHERE last_seen_at = '';
