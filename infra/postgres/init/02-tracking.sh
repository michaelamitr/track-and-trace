#!/bin/sh
# Creates the tracking database and its roles.
#
# The Postgres image runs scripts in /docker-entrypoint-initdb.d only on the
# first start with an empty data volume. On a volume that already has
# shipment_db, run this script once by hand; the existing data is kept:
#
#   docker compose up -d --wait postgres
#   docker compose exec postgres sh /docker-entrypoint-initdb.d/02-tracking.sh
#
# The first command recreates the container with the new password variables
# from .env (the volume stays).
#
# Roles:
#   tracking_owner   owns tracking_db and schema public, runs migrations.
#   tracking_service reads and writes data only, never changes the structure.
#
# Passwords are read from the environment into psql variables with \getenv,
# so they never appear on a command line or in the output.
set -eu

: "${TRACKING_OWNER_PASSWORD:?TRACKING_OWNER_PASSWORD is not set}"
: "${TRACKING_SERVICE_PASSWORD:?TRACKING_SERVICE_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname postgres <<'SQL'
\getenv owner_password TRACKING_OWNER_PASSWORD
\getenv service_password TRACKING_SERVICE_PASSWORD

CREATE ROLE tracking_owner LOGIN PASSWORD :'owner_password';
CREATE ROLE tracking_service LOGIN PASSWORD :'service_password';

CREATE DATABASE tracking_db OWNER tracking_owner;

REVOKE CONNECT ON DATABASE tracking_db FROM PUBLIC;
GRANT CONNECT ON DATABASE tracking_db TO tracking_owner, tracking_service;
SQL

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname tracking_db <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tracking_service;

ALTER DEFAULT PRIVILEGES FOR ROLE tracking_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tracking_service;
ALTER DEFAULT PRIVILEGES FOR ROLE tracking_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tracking_service;
SQL
