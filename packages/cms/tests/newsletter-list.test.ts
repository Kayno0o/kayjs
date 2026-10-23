import type { CmsOptions } from '../src/settings'
import { mailer } from '@kaynooo/kayjs-mail'
import { expect, test } from 'bun:test'
import { configure, settings } from '../src/settings'

const mail = mailer({ fromName: 'Test' })

// Assigning the real list to the option is the type test: `kay check` fails here when `mail.list()` drifts from what the cms calls.
const newsletter: CmsOptions['newsletter'] = { posts: { list: mail.list('news'), message: entry => ({ subject: String(entry.data?.title) }) } }

test('a real kayjs-mail list is accepted by cms({ newsletter })', () => {
  configure({ newsletter })

  expect(settings().newsletter.get('posts')?.list).toBeDefined()
})
