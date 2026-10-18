# Built from the root of kay's repository, as the docs run on its checkout: docker build -f docs/Dockerfile .
# Not a `--compile` executable: the chat on /ask reads llms.txt, llms/, the docs' pages and the libraries' docs from disk at run time.
FROM oven/bun:1.4.3
WORKDIR /kay
COPY . .
RUN bun install --frozen-lockfile
WORKDIR /kay/docs
RUN bun ../src/cli.ts build
# The chat's counts live in data/, a volume the bun user writes; the build above may have made a file there as root.
RUN rm -rf data && mkdir data && chown bun:bun data
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
HEALTHCHECK --interval=30s --timeout=6s CMD ["bun", "-e", "process.exit((await fetch('http://127.0.0.1:3000/')).ok ? 0 : 1)"]
CMD ["bun", "../src/cli.ts", "start"]
