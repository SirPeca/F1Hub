-- =========================================
-- F1 Hub — migrations/0006_poll_votes_require_account.sql
--
-- Hasta ahora un voto quedaba atado únicamente a la identidad anónima
-- (cookie del navegador) — borrar cookies, usar otro navegador o modo
-- incógnito permitía votar de nuevo indefinidamente. A partir de esta
-- migración, votar requiere estar logueado, y la unicidad real es
-- (poll_id, user_id), no (poll_id, identity_id).
--
-- user_id nullable a propósito: los votos viejos (de antes de esta
-- migración) quedan como están, con user_id NULL — no se borran, pero
-- tampoco cuentan para la nueva restricción de unicidad. El índice es
-- parcial (WHERE user_id IS NOT NULL) porque SQLite trata cada NULL
-- como distinto en un índice único, así que sin el WHERE, dos filas
-- viejas con user_id NULL no chocarían entre sí de todas formas — pero
-- ser explícitos acá deja claro que el filtro es intencional.
-- =========================================

ALTER TABLE gp_poll_votes ADD COLUMN user_id INTEGER REFERENCES users(id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_one_per_user
  ON gp_poll_votes(poll_id, user_id) WHERE user_id IS NOT NULL;
