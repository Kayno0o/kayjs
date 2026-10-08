# Built from the root of kay's repository, whose checkout the example runs on: docker build -f examples/noticeboard/Dockerfile .
# An app of its own installs kay and the libraries from the registry instead, as `kay new --template app` writes it.
FROM oven/bun:1 AS build
WORKDIR /kay
COPY package.json bun.lock .npmrc ./
RUN bun install --frozen-lockfile
COPY . .
WORKDIR /kay/examples/noticeboard
# The checkout's own command, which the install linked before the sources were copied in.
RUN bun ../../src/cli.ts build --compile server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /kay/examples/noticeboard/server ./server
# The queues keep their jobs here, a volume in compose.prod.yaml, so a mail waiting to go survives a restart.
RUN mkdir data && chown nobody data
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER nobody
HEALTHCHECK --interval=30s --timeout=6s CMD ["./server", "--health"]
CMD ["./server"]
