// Base images by tag and digest, so a build gets the bytes reviewed here whatever the tag moves to; `bun scripts/image-digests.ts` checks they still resolve and prints the refresh. The Bun build stage stays on `oven/bun:<version>`, which tracks the Bun that scaffolded the project.
const POSTGRES_IMAGE = 'postgres:18-alpine@sha256:898c60cb390d1085bc97bdd6a1ae968757421df394b071848b52b1c09c89d6a5'
const RUNTIME_IMAGE = 'debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad'
const NGINX_IMAGE = 'nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e'

// Actions are pinned to a commit with the release it is, so a moved tag cannot change what a workflow runs; each SHA is the commit its tag names in the action's repository.
const CHECKOUT = '11d5960a326750d5838078e36cf38b85af677262 # v4.4.0'
const SETUP_BUN_V1 = 'f4d14e03ff726c06358e5557344e1da148b56cf7 # v1.2.2'
const SETUP_BUN_V2 = '0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0'
const UPLOAD_PAGES_ARTIFACT = '56afc609e74202658d3ffba0e8f6dda462b719fa # v3.0.1'
const DEPLOY_PAGES = 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4.0.5'
const GH_PAGES = '373f7f263a76c20808c831209c920827a82a2847 # v3.9.3'

export { CHECKOUT, DEPLOY_PAGES, GH_PAGES, NGINX_IMAGE, POSTGRES_IMAGE, RUNTIME_IMAGE, SETUP_BUN_V1, SETUP_BUN_V2, UPLOAD_PAGES_ARTIFACT }
