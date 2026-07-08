-- =========================================
-- F1 Hub — migrations/0007_session_remember.sql
-- Agrega el flag "Recordarme" a las sesiones — determina qué política
-- de expiración aplica (corta por defecto, larga si se marcó el
-- checkbox al loguearse). Default 0 es una constante literal, así que
-- esta sí es una ALTER TABLE ADD COLUMN válida (a diferencia de la
-- 0005, que necesitó el patrón de dos pasos por el default con función).
-- =========================================

ALTER TABLE sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 0;
