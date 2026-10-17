---
title: messages/
order: 15
description: One file of translated messages per locale.
path: src/messages/
---

`src/messages/` holds one file per locale, exporting its messages through `defineMessages`. This is `src/messages/fr.ts`.

```ts
import { defineMessages } from 'kay/i18n'

export default defineMessages({
  nav: { home: 'Accueil' },
  greeting: 'Bonjour {name}',
})
```

The default locale's file is the reference. `kay check` holds the others to it, and a key a locale lacks falls back to its text. The locales themselves are declared in [`kay.config.ts`](/structure/kay-config).

A message whose line ends on a `// draft` comment is a draft, such as a machine translation. The comment goes on the message's own line, not on the opening brace of a group. It shows like any other message. `kay check` warns of it until you delete the comment, or run `kay i18n accept fr` for every draft of the locale. `kay i18n missing` lists the keys each locale still lacks.

A library listed in `extensions`, such as kayjs-auth's pages, can bring its own messages. A key the app's file gives wins over the library's.

A site without `i18n` still renders a library's texts in its `lang`. A `src/messages/<lang>.ts`, when there is one, overrides them key by key.

<ReadMore href="/guides/i18n#messages">Messages, plurals and formatting in the i18n guide.</ReadMore>
