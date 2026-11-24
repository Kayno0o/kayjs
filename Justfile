# Kay v2 task runner recipes (`just` or `j`).

# List all available recipes
default:
	@just --list

# Typecheck, run full test suite (including Chromium E2E), and build bench-app
verify:
	bun run verify

# Typecheck all packages, examples, and tests
check:
	bun run check

# Run tests (pass a filename or pattern to filter)
test *args:
	bun test packages/kay/tests {{args}}

# Run the benchmark suite
bench:
	bun run bench

# Start the docs site dev server
docs-dev:
	cd docs && bun run dev

# Export the static docs site (+ .br/.gz sidecars) to docs/dist/static
docs-build:
	cd docs && bun run build

# Build docs and audit layout, contrast, overflow, and tap targets with `page check` (light + dark)
docs-qa: docs-build
	@bun -e 'import { resolve } from "node:path"; const dist = resolve("docs/dist/static"); const srv = Bun.serve({ port: 0, async fetch(req) { const u = new URL(req.url); const p = u.pathname === "/" ? "/index.html" : u.pathname; let f = Bun.file(resolve(dist, "." + p)); if (!(await f.exists())) f = Bun.file(resolve(dist, "." + p + "/index.html")); if (!(await f.exists())) return new Response(Bun.file(resolve(dist, "404.html")), { status: 404 }); if (u.searchParams.get("scheme") === "dark" && f.name?.endsWith(".html")) { const html = (await f.text()).replace("</head>", "<style>:root{color-scheme:dark;--buncss-light: ;--buncss-dark:initial}</style></head>"); return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }); } return new Response(f); } }); const base = `http://127.0.0.1:${srv.port}`; const paths = ["/", "/docs/getting-started/quickstart", "/docs/core/signals-and-reactivity", "/docs/core/server-actions", "/docs/plugins/ui", "/docs/plugins/mcp", "/docs/production/deploy-and-compile", "/grammars", "/404.html"]; const urls = [...paths.map(p => `${base}${p}`), ...paths.map(p => `${base}${p}?scheme=dark`)]; const proc = Bun.spawn(["page", "check", "-w", "1440,1024,400", ...urls], { stdout: "inherit", stderr: "inherit" }); const code = await proc.exited; srv.stop(true); process.exit(code);'

# Build and start the docs Caddy container on 127.0.0.1:3650
docs-up:
	docker compose -f docs/compose.yaml up -d --build

# Stop the docs Caddy container
docs-down:
	docker compose -f docs/compose.yaml down

# Start the @kayjs/ui Grammar Switcher showcase example
showcase:
	cd examples/showcase && bun run dev

# Start the full-stack real-time Noticeboard example
noticeboard:
	cd examples/noticeboard && bun run dev

# Dry-run pack all 12 workspace packages
pack:
	@for dir in packages/*/; do echo "=== $dir ==="; (cd "$dir" && bun pm pack --dry-run) || exit 1; done

# Show recent Forgejo CI runs
runs:
	ft runs

# Wait for Forgejo CI on the current branch (default: v2)
ci sha="":
	ft ci {{sha}} -b "$(git branch --show-current)" --workflow test.yml

# Cut next alpha prerelease (v2.0.0-alpha.X)
alpha: (release "alpha")

# Cut next beta prerelease (v2.0.0-beta.X)
beta: (release "beta")

# Cut next release candidate (v2.0.0-rc.X)
rc: (release "rc")

# Cut next patch or graduate prerelease to stable (v2.0.X)
patch: (release "patch")

# Cut next minor release (v2.X.0)
minor: (release "minor")

# Cut next major release (vX.0.0)
major: (release "major")

# Bump all 12 packages in lockstep, verify, tag, push atomically, and watch Forgejo CI
release level:
	#!/usr/bin/env bash
	set -euo pipefail
	branch="$(git branch --show-current)"
	[ "$branch" = "v2" ] || [ "$branch" = "main" ] || { echo "release runs on v2 or main, not $branch" >&2; exit 1; }
	[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; commit or stash first" >&2; exit 1; }
	git fetch -q origin "$branch"
	[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$branch")" ] || { echo "$branch differs from origin/$branch: pull or push first" >&2; exit 1; }
	ft ci -b "$branch" --workflow test.yml
	tag="$(bun scripts/version.ts {{level}} | tail -n 1)"
	if ! bun run verify; then
	  git tag -d "$tag"
	  git reset --keep HEAD~1
	  exit 1
	fi
	if ! git push --atomic origin "$branch" "$tag"; then
	  if [ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
	    git tag -d "$tag"
	    git reset --keep HEAD~1
	  fi
	  exit 1
	fi
	ft watch
