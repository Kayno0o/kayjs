import type { Setup } from './template-shared'
import { NGINX_IMAGE, POSTGRES_IMAGE, RUNTIME_IMAGE } from './template-pins'
import { notFoundPage } from './template-starter'

// Run by the database image once, as it creates the database: a second role that reads and writes rows but changes no schema, and the default privileges that hand it every table, sequence and schema the owner creates later.
// It is idempotent, so an existing database adopts it by running this same file once (see the upgrading guide).
export const APP_ROLES_SCRIPT = `#!/bin/sh
# Run by the database image when it first creates the database, and by hand on an existing one: docker compose exec -T db sh /docker-entrypoint-initdb.d/roles.sh
# The role the app connects with, so a SQL injection or a compromised app process cannot drop or alter a table; $POSTGRES_USER, the owner, stays with the migrations.
# Tables, sequences and schemas the owner creates later reach it through default privileges, so a migration needs no GRANT.
set -e
[ -n "$APP_DB_PASSWORD" ] || { echo 'set APP_DB_PASSWORD, the password of the app_rw role' >&2; exit 1; }

psql -v ON_ERROR_STOP=1 -v owner="$POSTGRES_USER" -v password="$APP_DB_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE ROLE app_rw LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') \\gexec
-- Creating an event trigger and changing the SUPERUSER, REPLICATION and BYPASSRLS attributes take a superuser: on a managed Postgres the owner is not one, and the script finishes without them (a role it creates has none of them anyway).
SELECT rolsuper AS is_super FROM pg_roles WHERE rolname = current_user \\gset
\\if :is_super
SELECT format('ALTER ROLE app_rw NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'password') \\gexec
\\else
SELECT format('ALTER ROLE app_rw PASSWORD %L', :'password') \\gexec
\\endif
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT USAGE ON SEQUENCES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" GRANT USAGE ON SCHEMAS TO app_rw;

-- pg-orm's migration history table is created after this script, so the default privileges reach it: the revoke below covers one that exists already, and an event trigger takes the writes back from one created later.
SELECT format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', oid::regclass) FROM pg_class WHERE relname = '_pgorm_migrations' AND relkind = 'r' \\gexec
\\if :is_super
CREATE OR REPLACE FUNCTION public.kay_protect_migrations() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE created record;
BEGIN
  FOR created IN SELECT object_identity FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE' AND object_identity ~ '\\._pgorm_migrations$' AND EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM app_rw', created.object_identity);
  END LOOP;
END
$$;
DROP EVENT TRIGGER IF EXISTS kay_protect_migrations;
CREATE EVENT TRIGGER kay_protect_migrations ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.kay_protect_migrations();
\\else
\\warn 'db/roles.sh: the owner is not a superuser, so the event trigger that keeps app_rw from writing _pgorm_migrations is skipped: revoke INSERT, UPDATE, DELETE on it after the first migrate.'
\\endif
SQL
`

// An app's database, and a one-shot service applying the migrations before the app starts.
// The app connects as app_rw, which reads and writes rows; the owner role stays with the migrations.
const APP_COMPOSE = `services:
  db:
    image: ${POSTGRES_IMAGE}
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      # Letters and digits only: it goes into DATABASE_URL below as it is.
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
      POSTGRES_DB: app
      # The password of app_rw, the role the app connects with: a different secret from the owner's, letters and digits only as well.
      APP_DB_PASSWORD: \${APP_DB_PASSWORD:?set APP_DB_PASSWORD}
    volumes:
      - db:/var/lib/postgresql
      # Creates app_rw when the database is first created; db/roles.sh says how to run it on an existing one.
      - ./db/roles.sh:/docker-entrypoint-initdb.d/roles.sh:ro
    healthcheck:
      test: [CMD-SHELL, pg_isready -h 127.0.0.1 -U app]
      interval: 5s
      retries: 10

  # Applies the pending migrations before the app starts, from the build stage, which holds them and the pg-orm command.
  migrate:
    build:
      context: .
      target: build
    command: [bun, run, db:migrate]
    environment:
      # The owner: only the migrations change the schema.
      MIGRATE_DATABASE_URL: postgres://app:\${POSTGRES_PASSWORD}@db:5432/app
    depends_on:
      db:
        condition: service_healthy

  app:
    build: .
    restart: unless-stopped
    # The app needs no capability nor a privilege gain: it listens above 1024 as an unprivileged user.
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    # This machine alone: the reverse proxy in front serves the site over HTTPS.
    ports:
      - 127.0.0.1:3000:3000
    environment:
      # At least 32 characters, kept out of the repository: it seals the sessions.
      KAY_SECRET: \${KAY_SECRET:?set KAY_SECRET}
      DATABASE_URL: postgres://app_rw:\${APP_DB_PASSWORD}@db:5432/app
      # The public origin of the site, which the mailed links and the OAuth callbacks start from.
      SITE_URL: \${SITE_URL:?set SITE_URL}
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  db:
`

// An app on SQLite: kayjs-auth's file lives on a volume, which the app creates its tables in when it starts.
const SQLITE_COMPOSE = `services:
  app:
    build: .
    restart: unless-stopped
    # The app needs no capability nor a privilege gain: it listens above 1024 as an unprivileged user.
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    # This machine alone: the reverse proxy in front serves the site over HTTPS.
    ports:
      - 127.0.0.1:3000:3000
    environment:
      # At least 32 characters, kept out of the repository: it seals the sessions.
      KAY_SECRET: \${KAY_SECRET:?set KAY_SECRET}
      # The public origin of the site, which the mailed links and the OAuth callbacks start from.
      SITE_URL: \${SITE_URL:?set SITE_URL}
    volumes:
      - data:/app/data

volumes:
  data:
`

function databaseCompose(postgres: boolean): string {
  return postgres ? APP_COMPOSE : SQLITE_COMPOSE
}

// The binary `kay build --compile` makes carries the pages, their assets and the browser build, so the image holds it alone.
export function serverContainerFiles({ has }: Setup): Record<string, string> {
  // kayjs-auth's SQLite file is written under `data`, which the image holds for the volume compose mounts there.
  const data = has('auth') && !has('postgres')

  return {
    'Dockerfile': `FROM oven/bun:${Bun.version} AS build
WORKDIR /app
COPY package.json bun.lock* .npmrc ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run compile

FROM ${RUNTIME_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/server ./server
${data ? 'RUN mkdir data && chown nobody data\n' : ''}ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER nobody
HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]
CMD ["./server"]
`,
    '.dockerignore': `node_modules\n.kay\nserver\n.git\n.env\n.env.*\n${data ? 'data\n' : ''}`,
    'compose.prod.yaml': has('auth')
      ? databaseCompose(has('postgres'))
      : `services:
  app:
    build: .
    restart: unless-stopped
    # The app needs no capability nor a privilege gain: it listens above 1024 as an unprivileged user.
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
    # This machine alone: the reverse proxy in front serves the site over HTTPS.
    ports:
      - 127.0.0.1:3000:3000
    environment:
      # The public origin of the site: https sends HSTS, and the canonical URLs and the sitemap start from it.
      SITE_URL: \${SITE_URL:?set SITE_URL}
`,
    ...!has('auth') && { '.env.example': '# What production sets, for compose.prod.yaml.\nSITE_URL=\n' },
  }
}

// The static site's container: the same files, served by nginx with the compressed copies the build wrote, and a 404 page for a path it lacks.
export function staticContainerFiles(setup: Setup): Record<string, string> {
  const { has } = setup

  return {
    // The 404 page nginx serves is the one the export writes from this file.
    ...!has('starter') && { 'src/routes/_404.kay': notFoundPage(setup) },
    'Dockerfile': `FROM oven/bun:${Bun.version} AS build
WORKDIR /app
COPY . .
# The stock nginx image cannot send brotli, so only the gzip copies are kept; the headers the build wrote go where nginx.conf includes them from, out of the served folder.
RUN bun install --frozen-lockfile && bun run build && find dist -name '*.br' -delete && mv dist/headers.nginx.conf kay-headers.conf && rm -f dist/_headers

# The unprivileged build runs as a user of its own and listens on 8080, so the container needs no root nor a port below 1024.
FROM ${NGINX_IMAGE}
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/kay-headers.conf /etc/nginx/kay-headers.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
`,
    'nginx.conf': `server {
  listen 8080;
  root /usr/share/nginx/html;
  server_tokens off;
  gzip_static on;
  gzip_vary on;
  add_header Strict-Transport-Security "max-age=31536000" always;
  include /etc/nginx/kay-headers.conf;

  # Hashed files, immutable; the search manifest and the notices keep their name between builds, so they revalidate.
  location ^~ /_kay/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location = /_kay/search.json {
    add_header Cache-Control "no-cache";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location = /_kay/THIRD-PARTY-LICENSES.txt {
    add_header Cache-Control "no-cache";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location ~* \\.(?:woff2?|ttf|otf|eot)$ {
    add_header Cache-Control "public, max-age=2592000";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location ~* \\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$ {
    add_header Cache-Control "public, max-age=86400";
    add_header Strict-Transport-Security "max-age=31536000" always;
    include /etc/nginx/kay-headers.conf;
  }

  location / {
    try_files $uri $uri.html $uri/index.html =404;
  }

  error_page 404 /404.html;
}
`,
    '.dockerignore': 'node_modules\n.kay\ndist\n.git\n.env\n.env.*\n',
  }
}
