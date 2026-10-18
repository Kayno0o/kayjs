# Built from the root of kay's repository, as the docs run on its checkout: docker build -f docs/Dockerfile .
# Not a `--compile` executable: the chat reads llms.txt, llms/, the docs' pages and the libraries' docs from disk at run time.
FROM oven/bun:1.4.3
# Installed and built as the user that serves, which writes into .kay at startup.
RUN mkdir /kay && chown bun:bun /kay
USER bun
WORKDIR /kay
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile
WORKDIR /kay/docs
RUN mkdir .kay
# The build's cache (compiled components, share cards, compressed copies) is a BuildKit cache mount, so a rebuild after a small change reuses it; the mount is not in the image, so the same step copies it aside and the next one puts it back, as the server compiles from it at start-up.
RUN --mount=type=cache,target=/kay/docs/.kay/cache,uid=1000,gid=1000 bun ../src/cli.ts build && mkdir /kay/docs/.kay/cache-image && cp -a /kay/docs/.kay/cache/. /kay/docs/.kay/cache-image/
RUN cp -a .kay/cache-image/. .kay/cache/ && rm -rf .kay/cache-image
# The chat's counts live in data/, a volume; the build above may have opened its file.
RUN rm -rf data && mkdir data
ENV NODE_ENV=production PORT=3649
EXPOSE 3649
HEALTHCHECK --interval=30s --timeout=6s CMD ["bun", "-e", "process.exit((await fetch('http://127.0.0.1:3649/')).ok ? 0 : 1)"]
CMD ["bun", "../src/cli.ts", "start"]
