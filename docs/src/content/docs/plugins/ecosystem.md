---
title: "@kayjs/i18n · mail · spa · tailwind · icons"
description: Composable plugins for localization, email delivery, opt-in SPA swaps, Tailwind v4, and inline SVG icon sets.
section: plugins
order: 6
---

Every remaining capability is an opt-in package built strictly on `KayPlugin`.

## `@kayjs/i18n`

Prefix-free default locale + prefixed secondary locales (`/fr/...`), automatic `<html lang>` + internal link rewriting, `prerenderPaths` expansion across locales, `hreflang` alternate links, and `Intl` helpers (`localizePath`, `alternateLinks`, `formatDate`, `formatNumber`):

```ts
import { i18n } from '@kayjs/i18n'

i18n({
  locales: ['en', 'fr'],
  defaultLocale: 'en',
  site: 'https://example.com',
  messages: { en, fr },
})
```

## `@kayjs/mail`

Send transactional email via Resend or any custom transport, with a zero-config dev outbox UI at `/_kay/mail`:

```ts
import { createMail, mailPlugin, resendTransport } from '@kayjs/mail'

export const mail = createMail({
  from: 'hello@example.com',
  transport: process.env.RESEND_API_KEY ? resendTransport(process.env.RESEND_API_KEY) : undefined,
})
```

## `@kayjs/icons`

Zero-runtime inline SVGs from any `@iconify-json/*` icon pack:

```tsx
import { Icon } from '@kayjs/icons'
import arrowRight from '~icons/tabler/arrow-right'

<Icon icon={arrowRight} class="size-4" />
```

## `@kayjs/tailwind`

Opt-in Tailwind CSS v4 via `bun-plugin-tailwind`:

```ts
import { tailwind } from '@kayjs/tailwind'
import tailwindPlugin from 'bun-plugin-tailwind'

tailwind({ css: 'src/app.css', bunPlugin: tailwindPlugin })
```

## `@kayjs/spa`

MPA navigation (`0 KB` JS) is the default. Add `spa()` to opt into client-side HTML swaps with persistent islands across navigations.
