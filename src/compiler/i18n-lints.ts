import type { Lint } from './lints'

// The lints of the `i18n` group, with the other lints in `LINTS`.
export const I18N_LINTS = {
  'draft-message': {
    level: 'warn',
    group: 'i18n',
    site: true,
    summary: 'With `i18n`, a message whose own line in its locale\'s file ends on a `// draft` comment (a group\'s opening brace marks none), as a machine translation is written: it is served as any message, and waits for a person to check it. Delete the comment once checked, or run `kay i18n accept <locale>` for every draft of the locale; `lints: { \'draft-message\': \'deny\' }` holds a release until they are.',
    wrong: '// src/messages/fr.ts\nexport default defineMessages({\n  nav: { about: \'À propos\' }, // draft\n})',
    right: '// src/messages/fr.ts\nexport default defineMessages({\n  nav: { about: \'À propos\' },\n})',
  },
  'draft-entry': {
    level: 'warn',
    group: 'i18n',
    site: true,
    summary: 'With `i18n`, an entry of a localized collection whose YAML (or Markdown frontmatter) opens on a `# draft` line, as `kay i18n translate` marks a machine translation in a collection with no `draft` field: it is served as any entry, and waits for a person to read it. Delete the line once checked, or save the entry from a CMS; `lints: { \'draft-entry\': \'deny\' }` holds a release until they are. A collection with `draft: \'field\'` holds its drafts back instead.',
    wrong: '# src/content/news/fr/launch.yaml\n# draft\ntitle: Lancement',
    right: '# src/content/news/fr/launch.yaml\ntitle: Lancement',
  },
  'default-locale-path': {
    level: 'warn',
    group: 'i18n',
    site: true,
    summary: 'With `i18n`, an `i18n.paths` entry that translates a pattern for the default locale: the default locale\'s path is the pattern itself, so the translation is accepted but links to it never localize. Name the page the default locale\'s way and translate it for the other locales.',
    wrong: '// kay.config.ts, defaultLocale: \'fr\'\ni18n: { paths: { \'/about\': { fr: \'/a-propos\', en: \'/about\' } } }',
    right: '// kay.config.ts, defaultLocale: \'fr\', the page named src/routes/a-propos.kay\ni18n: { paths: { \'/a-propos\': { en: \'/about\' } } }',
  },
} as const satisfies Record<string, Lint>
