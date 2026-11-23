# Multi-stage static build for Kay v2 documentation.
# Build from the repository root:
#   docker build -f docs/Dockerfile --build-arg SITE_URL=https://v2.kayjs.kaynooo.fr -t kay-v2-docs .

FROM oven/bun:1.4.5-alpine AS builder
RUN apk add --no-cache imagemagick imagemagick-webp imagemagick-heic imagemagick-svg ttf-freefont

WORKDIR /repo
COPY package.json bun.lock ./
COPY packages ./packages
COPY llms.txt ./
COPY docs ./docs

RUN bun install --frozen-lockfile --silent
WORKDIR /repo/docs
RUN bun install --silent

ARG SITE_URL=https://v2.kayjs.kaynooo.fr
ENV SITE_URL=${SITE_URL}
RUN bun run build

FROM caddy:2-alpine
COPY docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=builder /repo/docs/dist/static /srv

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
