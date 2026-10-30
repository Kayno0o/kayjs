import type { Host, Setup } from './template-shared'
import { CHECKOUT, DEPLOY_PAGES, GH_PAGES, POSTGRES_IMAGE, SETUP_BUN_V1, SETUP_BUN_V2, UPLOAD_PAGES_ARTIFACT } from './template-pins'
import { blocks } from './template-shared'

// A Forgejo runner image may be Debian without unzip or git, or Alpine with bun and git baked in: the step installs only what is missing, with whichever package manager the image has, and tells the Setup Bun step when bun is already there.
function workflowSetup(host: Host): string {
  return `${host === 'forgejo'
    ? `      - name: Install unzip and git
        id: tools
        run: |
          if command -v bun >/dev/null; then echo "bun=true" >> "$GITHUB_OUTPUT"; fi
          missing=""
          command -v git >/dev/null || missing="$missing git"
          command -v bun >/dev/null || command -v unzip >/dev/null || missing="$missing unzip"
          if [ -z "$missing" ]; then exit 0; fi
          if command -v apt-get >/dev/null; then apt-get update && apt-get install -y $missing; else apk add --no-cache $missing; fi

`
    : ''}      - name: Checkout
        uses: actions/checkout@${CHECKOUT}

      - name: Setup Bun
${host === 'forgejo' ? '        if: steps.tools.outputs.bun != \'true\'\n' : ''}        uses: oven-sh/setup-bun@${host === 'forgejo' ? SETUP_BUN_V1 : SETUP_BUN_V2}
        with:
          bun-version: ${Bun.version}

      - name: Install dependencies
        run: bun install --frozen-lockfile`
}

// Every push is checked and tested before anything deploys it; the container build checks again, as `kay build` does. With `postgres`, the tests copy a database per test file on a Postgres service.
export function testWorkflow({ has, host, runner }: Setup): string {
  const database = has('postgres') && has('tests')

  return blocks(
    `name: ${has('tests') ? 'Tests' : 'Checks'}

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ${runner}${database
      ? `
    services:
      postgres:
        image: ${POSTGRES_IMAGE}
        env:
          POSTGRES_USER: app
          POSTGRES_PASSWORD: app
          POSTGRES_DB: app_test${host === 'github'
            ? `
        ports:
          - 5432:5432`
            : ''}
        options: --health-cmd "pg_isready -h 127.0.0.1 -U app" --health-interval 2s --health-retries 15`
      : ''}
    steps:
${workflowSetup(host)}`,
    `      # Each problem shows on the diff.
      - name: Check
        run: bun run check --format github`,
    has('eslint') && `      - name: Lint
        run: bun run lint`,
    has('tests') && `      - name: Test
        run: bun run test${database
          ? `
        env:
          DATABASE_URL: postgres://app:app@${host === 'forgejo' ? 'postgres' : 'localhost'}:5432/app_test`
          : ''}`,
  )
}

// A site with no server: `kay build --static` writes it to `dist`, which this workflow publishes to Forgejo Pages, or to GitHub Pages.
export function pagesWorkflow({ has, host, runner }: Setup): string {
  const github = host === 'github'

  return blocks(
    `name: Publish to Pages

on:
  push:
    branches:
      - main

${github
  ? `permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ${runner}
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}`
  : `permissions:
  contents: write

jobs:
  publish:
    runs-on: ${runner}`}
    steps:
${workflowSetup(host)}`,
    has('tests') && `      # A failing test publishes nothing; the build checks the project itself.
      - name: Test
        run: bun run test`,
    `${has('tests') ? '' : '      # The build checks the project itself.\n'}      - name: Build the site
        env:${github
          ? `
          SITE_URL: https://\${{ github.repository_owner }}.github.io
          SITE_BASE: /\${{ github.event.repository.name }}`
          : `
          # The host your Forgejo instance publishes Pages on: replace it with yours.
          SITE_URL: https://pages.example.com
          SITE_BASE: /\${{ github.repository }}`}
        run: bun run build`,
    has('eslint') && `      - name: Lint
        run: bun run lint`,
    github
      ? `      # Set Pages to deploy from GitHub Actions in the repository's settings; a site named <owner>.github.io is served from the root, so empty SITE_BASE.
      - name: Upload the site
        uses: actions/upload-pages-artifact@${UPLOAD_PAGES_ARTIFACT}
        with:
          path: dist

      - name: Publish to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@${DEPLOY_PAGES}`
      : `      - name: Publish to the gitea-pages branch
        uses: peaceiris/actions-gh-pages@${GH_PAGES}
        with:
          github_token: \${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
          publish_branch: gitea-pages
          force_orphan: true`,
  )
}
