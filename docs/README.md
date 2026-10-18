# kay docs

The documentation site, built with kay itself. It is a server, not a static export: every page is prerendered at build time, and the chat on `/ask` answers through an action.

## Build and run

```sh
bun run docs:build   # kay build docs
bun run docs:start   # kay start docs --port 3000
```

The docs can no longer be exported as static files: the chat page exports an action, which only a server can take.

## Docker

```sh
docker compose -f docs/compose.yaml up -d --build   # from the repository root
```

`docs/Dockerfile` builds the docs on the repository checkout and runs `kay start`, not a compiled executable, as the chat reads `llms.txt`, `llms/` and the pages from disk. Compose publishes it on `127.0.0.1:3649` only, for nginx to proxy.

## Environment

The server reads `docs/.env`, which git ignores, with `bun run docs:start` and in Docker alike (compose passes it as `env_file`, and the image is built without it). Copy `docs/.env.example` there and fill in the key.

`KAY_SECRET`, at least 32 random characters (`openssl rand -base64 32`), signs form stamps and keys the chat's counts: `docs/data/ai.sqlite` keeps each visitor's address only as an HMAC under it, so the file alone cannot be checked against a guessed address. Changing it starts every count afresh.

## The chat

`/ask` answers questions about kay from `llms.txt`, and reads more through two actions it is offered as tools: `search_docs` and `read_page`. Its code is `src/routes/(docs)/ask.kay` and `src/chat-corpus.ts`.

Environment variables of the server, Mistral Small 4 pinned to a dated model:

- `OPENAI_API_KEY`: the Mistral API key.
- `AI_BASE_URL=https://api.mistral.ai/v1`
- `AI_MODEL=mistral-small-2603`

Without them the site builds, prerenders and serves as usual, and the chat answers that it is not available. Behind nginx, `proxy: true` in `kay.config.ts` reads the visitor's address from `X-Forwarded-For`, so nginx must set it (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) and the server must not be reachable except through nginx.

Limits, in `kay.config.ts`: 4 questions a minute per visitor, 60,000 tokens a day per visitor (about a dozen full answers) and 1,500,000 a day in all. They are kept in `docs/data/ai.sqlite`, which the compose file mounts as a volume, so a restart keeps them. Mistral accounts have low rate limits, about a request a second, and one question makes up to five requests.
