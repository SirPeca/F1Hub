-- =========================================
-- F1 Hub — migrations/0008_poll_votes_fix_constraint.sql
--
-- BUG REAL CONFIRMADO: la tabla original (migración 0001) tenía
-- UNIQUE(poll_id, identity_id) — un voto por NAVEGADOR. La migración
-- 0006 agregó user_id y un índice único parcial (poll_id, user_id) —
-- un voto por CUENTA — pero la restricción VIEJA por identity_id
-- seguía viva al mismo tiempo. Resultado: alguien que ya había votado
-- de forma anónima (antes de exigir cuenta) y después se logueaba con
-- ese mismo navegador chocaba contra la restricción vieja al intentar
-- votar de nuevo, y el intento de "actualizar en vez de insertar" caía
-- buscando por user_id — que no existía en esa fila vieja (tenía
-- identity_id pero no user_id) — así que no actualizaba nada, pero la
-- función igual respondía éxito.
--
-- SQLite no permite borrar una constraint UNIQUE con ALTER TABLE, así
-- que se reconstruye la tabla sin esa restricción vieja, conservando
-- los datos (con deduplicación: para cada poll_id+user_id ya asociado
-- a una cuenta, nos quedamos con el voto más reciente).
-- =========================================

CREATE TABLE gp_poll_votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id INTEGER NOT NULL REFERENCES gp_polls(id) ON DELETE CASCADE,
  identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  driver_id TEXT NOT NULL,
  voted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Copiar: los votos ya asociados a una cuenta (user_id no nulo) se
-- deduplican quedándose con el más reciente por poll_id+user_id; los
-- que quedaron puramente anónimos (nunca se logueó esa identidad) se
-- copian tal cual — no se pierden, simplemente no cuentan para ninguna
-- cuenta específica.
INSERT INTO gp_poll_votes_new (poll_id, identity_id, user_id, driver_id, voted_at)
SELECT poll_id, identity_id, user_id, driver_id, voted_at
FROM gp_poll_votes v
WHERE user_id IS NULL
   OR id = (SELECT MAX(id) FROM gp_poll_votes v2 WHERE v2.poll_id = v.poll_id AND v2.user_id = v.user_id);

DROP TABLE gp_poll_votes;
ALTER TABLE gp_poll_votes_new RENAME TO gp_poll_votes;

-- Única restricción real de ahora en más: un voto por CUENTA por encuesta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_votes_one_per_user
  ON gp_poll_votes(poll_id, user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON gp_poll_votes(poll_id);
