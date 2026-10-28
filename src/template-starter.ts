import type { Setup } from './template-shared'
import { fence, lines } from './template-shared'

function header({ has, tw }: Setup): string {
  const links = has('auth') ? '[{ href: \'/\', label: \'Home\' }, { href: \'/auth/account\', label: \'Account\' }]' : '[{ href: \'/\', label: \'Home\' }]'

  return lines(
    '---',
    has('accents') && 'import AccentPicker from \'./accent-picker.kay\'\n',
    `const links = ${links}`,
    '---',
    `header${tw('.border-b-2.border-overlay0.bg-base.px-8.py-3')}`,
    `  nav${tw('.mx-auto.flex.max-w-5xl.items-center.justify-between.gap-4')}(aria-label="Main navigation")`,
    `    a${tw('.text-xl.font-bold.no-underline')}(href="/") __NAME__`,
    `    ul${tw('.flex.gap-4')}`,
    '      for link of links',
    '        li',
    '          a(href={link.href}) {link.label}',
    has('accents') && '    AccentPicker',
  )
}

export function layout({ has, tw }: Setup): string {
  return lines(
    fence('---', has('starter') && 'import Header from \'../components/header.kay\'', (has('starter') || has('tailwind')) && 'import \'../app.css\''),
    has('starter') && 'a.skip-link(href="#main-content") Skip to main content\nHeader',
    `main${has('starter') ? '#main-content' : ''}${tw('.mx-auto.w-full.max-w-5xl.grow.px-8.py-6')}`,
    '  slot',
  )
}

export function home({ has, tw }: Setup): string {
  if (!has('starter')) {
    return lines(
      fence('---', has('ws') && 'import Online from \'../components/online.kay\''),
      'head',
      '  title Home',
      `h1${tw('.text-3xl.font-bold')} __NAME__`,
      has('auth') && 'a(href="/auth/account") Account',
      has('ws') && 'Online',
    )
  }

  return lines(
    '--- server',
    'const greeting = \'Hello from the server\'',
    '--- script',
    'import Rocket from \'~icons/tabler/rocket\'',
    'import Counter from \'../components/counter.kay\'',
    has('ws') && 'import Online from \'../components/online.kay\'',
    '---',
    'head',
    '  title Home',
    `section${tw('.flex.flex-col.items-center.gap-6.py-12')}`,
    `  Rocket${tw('.size-16.text-accent.motion-safe:animate-bounce')}`,
    `  h1${tw('.text-3xl.font-bold')} {greeting}`,
    '  Counter(start={0})',
    has('ws') && '  Online',
  )
}

export function starterFiles(setup: Setup): Record<string, string> {
  return {
    'src/components/header.kay': header(setup),
    'src/components/counter.kay': `---
const { start } = props<{ start: number }>()
const count = signal(start)
---
button(onClick={() => count++}) Clicked {count()} times
`,
    'src/routes/_404.kay': notFoundPage(setup),
  }
}

export function notFoundPage(setup: Setup): string {
  return lines('head', '  title Nothing here', `h1${setup.tw('.text-2xl.font-bold')} Nothing here`, 'a(href="/") Back home')
}

export function homeTest({ has }: Setup): string {
  // kayjs-auth guards every page, so a visitor with no session lands on its sign-in page.
  if (has('auth')) {
    return `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('sends a visitor to sign in', async () => {
  const home = await site.visit('/')

  expect(home.status).toBe(200)
  expect(home.url).toStartWith('/auth/sign-in')
})
`
  }

  return `import { expect, it } from 'bun:test'
import { testSite } from 'kay/test'

const site = await testSite()

it('${has('starter') ? 'greets from the server' : 'renders the home page'}', async () => {
  const home = await site.visit('/')

  expect(home.status).toBe(200)
  expect(home.html).toContain('${has('starter') ? 'Hello from the server' : '__NAME__</h1>'}')
})
`
}
