---
title: Quickstart (60s)
description: Scaffold a Kay v2 app, run the dev server, and ship a static site or single standalone binary on Bun.
section: getting-started
order: 2
---

## Requirements

- **Bun 1.4+** (`bun --version`)

## 1. Create a project

Pick one of the four built-in starter templates:

```bash
bunx @kayjs/kay@beta new my-app --template minimal    # Static route + 1 auto-island
bunx @kayjs/kay@beta new my-app --template fullstack  # Layouts, API route, Standard-Schema action
bunx @kayjs/kay@beta new my-app --template blog       # @kayjs/content + @kayjs/ui + RSS (0 KB JS)
bunx @kayjs/kay@beta new my-app --template app        # @kayjs/auth + @kayjs/ui + guarded /dashboard
```

Install dependencies and start the dev server:

```bash
cd my-app
bun install
bun run dev
```

Your app runs at `http://127.0.0.1:3000` with incremental rebuilds and live reload over SSE.

## 2. Build for production

<Tabs label="Deployment targets">
<Tab group="deploy" label="Bun Server" checked>

```bash
bun run build
bun run start
```

</Tab>
<Tab group="deploy" label="Single Executable (--compile)">

```bash
kay build --compile ./my-app-bin
./my-app-bin
```

</Tab>
<Tab group="deploy" label="Static HTML (--static)">

```bash
kay build --static
# Serve dist/ from nginx, Caddy, Cloudflare Pages, or S3
```

</Tab>
</Tabs>

Pass `--analyze` to `kay build` to print per-route eager JS and CSS weights plus the largest bundled modules.

## 3. Validate before shipping

```bash
kay check
```

`kay check` runs TypeScript checking, Kay compiler guardrails, route conflict checks, and every active plugin's `check` hook. Pass `--no-typecheck` to skip `tsc`/`tsgo` when iterating quickly.
