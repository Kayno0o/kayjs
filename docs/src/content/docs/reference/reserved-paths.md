---
title: Reserved paths
order: 5
description: The files, folders and routes kay reads or serves by name, and the rule their names follow.
---
kay reads some files and folders of a project by name, and serves some routes under `/_kay/`. A reserved name is part of your layout, so a rename is a breaking change, shipped in a minor with the old name working for three minors.

## Naming rule

A file kay reads for one thing is singular: `server.ts`, `auth.ts`, `mail.ts`, `ui.ts`, `context.ts`, `env.ts`, `theme.ts`. A folder holding one file per page, plugin, template, matcher or catalog is plural: `routes/`, `plugins/`, `mails/`, `messages/`, `params/`. A mass noun or an acronym stays as it is: `api/`, `content/`, `db/`. A file inside a plural folder is named after what it holds, as `plugins/jobs.ts` or `mails/welcome.kay`.

A route follows the same rule. An endpoint is `/_kay/<noun>`, such as `/_kay/card`, and a folder of files is `/_kay/<nouns>/`, such as `/_kay/assets/`. The image resizer sits beside its variants under one prefix, `/_kay/images` for the endpoint and `/_kay/images/<file>` for the files `kay build` wrote.

## Files and folders

| Path | Holds |
| --- | --- |
| `src/routes/` | pages, layouts, endpoints and guards |
| `kay.config.ts` | the project's settings |
| `public/` | files served as they are, from the site root |
| `data/` | the SQLite files and stored files of the default stores, ignored by git and docker |
| `src/api/` | API modules |
| `src/plugins/` | server plugins, one per file; `plugins/jobs.ts` is the one home of queues, workflows and schedules |
| `src/messages/` | one catalog per locale, `<locale>.ts` |
| `src/params/` | route param matchers, `<name>.ts` |
| `src/content/` and `src/content.config.ts` | Markdown collections and their schemas |
| `src/mails/` and `src/mail.ts` | kayjs-mail templates, `<name>.kay` with a `<name>.preview.ts` beside each, and the mailer they send through |
| `src/db/` | the database, `index.ts` and `tables.ts` |
| `src/server.ts` | the server entry |
| `src/auth.ts` | kayjs-auth hooks |
| `src/ui.ts` | `defineUi` settings for components |
| `src/context.ts` | `defineContext` request values |
| `src/env.ts` | `defineEnv` variables |
| `src/theme.ts`, `src/app.css` | the theme and the stylesheet |
| `src/logo.svg` | the card logo, where `card.logo` points at it |

## Routes

| Route | Serves |
| --- | --- |
| `/_kay/assets/` | the browser build and imported files |
| `/_kay/images` and `/_kay/images/` | the resizer, and the variants `kay build` wrote |
| `/_kay/card` | share cards |
| `/_kay/files/` | stored files |
| `/_kay/action/` | actions |
| `/_kay/fields/` | the honeypot and stamp of a form an island builds |
| `/_kay/live` | live values |
| `/_kay/health` | the health check |
| `/_kay/jobs` | the jobs page, with `jobs: { guard }` |
| `/_kay/error`, `/_kay/csp`, `/_kay/vitals`, `/_kay/analytics`, `/_kay/push` | reports and beacons |
| `/_kay/search.json`, `/_kay/search/` | the site search index |
| `/_kay/preview`, `/_kay/draft` | preview mode |
| `/_kay/env.js` | the public environment |

`kay routes` lists what a project serves.
