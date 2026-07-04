-- =========================================
-- F1 Hub — migrations/0003_favorites_label.sql
-- Guarda el nombre visible junto al favorito (denormalizado a propósito:
-- los nombres de pilotos/equipos/circuitos casi no cambian, y así la
-- pestaña "Favoritos" no necesita una consulta extra a Jolpica solo
-- para mostrar la lista).
-- =========================================

ALTER TABLE favorites ADD COLUMN label TEXT;
