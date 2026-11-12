import type { Lint } from './lints'
import { SERIAL_AWAITS_LINTS } from './serial-awaits'

// The lints of the files under `src/routes`, of the content entries and of a page's server fence, with the other lints in `LINTS`.
export const ROUTE_LINTS = {
  ...SERIAL_AWAITS_LINTS,
  'unguarded-route': {
    level: 'deny',
    group: 'security',
    site: true,
    summary: 'On a site that guards a route of its own, or with `requireGuards`, a page, a layout with actions, an endpoint or an API module of the app that no `_guard.ts` covers and that does not set `guards: false`: the server answers it 403.',
    wrong: '// a site with a _guard.ts, or requireGuards: true\n// src/routes/pricing.kay, with no _guard.ts above it',
    right: '--- server\nexport const page = { guards: false }\n---\nh1 Pricing',
  },
  'endpoint-export': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'An endpoint file exporting a name that is no method: only `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`, in capitals, are served, and `page` holds its settings, so `post` or `handler` is never called.',
    wrong: '// src/routes/hook.json.ts\nexport function post() {\n  return Response.json({ ok: true })\n}',
    right: '// src/routes/hook.json.ts\nexport function POST() {\n  return Response.json({ ok: true })\n}',
  },
  'unused-status-page': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'A status page (`_401.kay`, `_403.kay`, `_429.kay` or `_503.kay`) in a directory with no route: a status page answers for the routes of its directory and below, so no page ever renders it.',
    wrong: '// src/routes/_403.kay, with no route in src/routes/',
    right: '// src/routes/admin/_403.kay, beside the pages it answers for',
  },
  'held-back-reference': {
    level: 'warn',
    group: 'code',
    site: true,
    summary: 'An entry shown on the site whose `reference()` field names an entry its collection holds back from production, a draft or one outside its `publishAt` and `unpublishAt` dates, so the page renders without it. `kay check` only notes it, as publishing the referenced entry fixes it, and the build does not fail.',
    wrong: 'author: ada (in an entry shown, while authors/ada.md has `draft: true`)',
    right: 'publish authors/ada.md, or point the reference at a shown entry',
  },
} as const satisfies Record<string, Lint>
