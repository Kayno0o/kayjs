# Built from the root of kay's repository, as the docs run on its checkout: docker build -f docs/Dockerfile .
# Not a `--compile` executable: the chat on /ask reads llms.txt, llms/, the docs' pages and the libraries' docs from disk at run time.
FROM oven/bun:1.4.3
# Installed and built as the user that serves, which writes into .kay at startup.
RUN mkdir /kay && chown bun:bun /kay
USER bun
WORKDIR /kay
COPY --chown=bun:bun . .
RUN bun install --frozen-lockfile
WORKDIR /kay/docs
RUN bun ../src/cli.ts build
# The chat's counts live in data/, a volume; the build above may have opened its file.
RUN rm -rf data && mkdir data
ENV NODE_ENV=production PORT=3649
EXPOSE 3649
HEALTHCHECK --interval=30s --timeout=6s CMD ["bun", "-e", "process.exit((await fetch('http://127.0.0.1:3649/')).ok ? 0 : 1)"]
CMD ["bun", "../src/cli.ts", "start"]
