#!/bin/sh
# Creates the shipment database and its roles.
#
# The Postgres image runs scripts in /docker-entrypoint-initdb.d only on the
# first start with an empty data volume. Later edits to this script have no
# effect on an existing volume. To re-run it, remove only the postgres volume:
#
#   docker compose stop postgres && docker compose rm -f postgres
#   docker volume rm track-and-trace_postgres-data
#
# Do not use `docker compose down -v`: it also deletes the NATS volume.
#
# Roles:
#   shipment_owner   owns shipment_db and schema public, runs migrations.
#   shipment_service reads and writes data only, never changes the structure.
#
# Passwords are read from the environment into psql variables with \getenv,
# so they never appear on a command line or in the output.
set -eu

: "${SHIPMENT_OWNER_PASSWORD:?SHIPMENT_OWNER_PASSWORD is not set}"
: "${SHIPMENT_SERVICE_PASSWORD:?SHIPMENT_SERVICE_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv owner_password SHIPMENT_OWNER_PASSWORD
\getenv service_password SHIPMENT_SERVICE_PASSWORD

CREATE ROLE shipment_owner LOGIN PASSWORD :'owner_password';
CREATE ROLE shipment_service LOGIN PASSWORD :'service_password';

CREATE DATABASE shipment_db OWNER shipment_owner;

REVOKE CONNECT ON DATABASE shipment_db FROM PUBLIC;
GRANT CONNECT ON DATABASE shipment_db TO shipment_owner, shipment_service;
SQL

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname shipment_db <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO shipment_service;

ALTER DEFAULT PRIVILEGES FOR ROLE shipment_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shipment_service;
ALTER DEFAULT PRIVILEGES FOR ROLE shipment_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO shipment_service;
SQL
