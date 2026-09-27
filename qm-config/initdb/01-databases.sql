-- Runs once, on first start of an empty volume.
-- "ots": the command library (commands, runs). "qm": the QM dev instance (QM migrates it itself).
CREATE DATABASE qm OWNER ots;
\connect ots
CREATE EXTENSION IF NOT EXISTS pg_trgm;
