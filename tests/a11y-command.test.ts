import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { browserFailure } from '../src/a11y/audit'
import { declaration, failed, formatReport, reportOf } from '../src/a11y/report'
import { RGAA_CRITERIA, WCAG_CRITERIA } from '../src/a11y/rgaa-criteria'
import { judge, RGAA_DECIDED, RGAA_FAILS } from '../src/a11y/standards'
import { browserPath } from '../src/test'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '..', 'src', 'cli.ts')
// CI installs Chromium for these: there, a missing browser fails rather than skips.
const skipBrowser = browserPath() === undefined && (process.env.CI ?? '') === ''
const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

async function run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number, stdout: string, stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, 'a11y', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  return { code: await child.exited, stdout, stderr }
}

// Waits for a process to be gone, as a condition rather than a delay: a zombie awaiting its reaper is gone too. Only the process itself is checked, not the children Chrome spawns.
async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)

      if ((/^\d+ \(.*\) Z/).test(await readFile(`/proc/${pid}/stat`, 'utf8')))
        return true
    }
    catch {
      return true
    }

    await Bun.sleep(50)
  }

  return false
}

async function pids(file: string): Promise<number[]> {
  return existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter(line => line !== '').map(Number) : []
}

async function project(prefix: string, config: string, routes: Record<string, string>): Promise<string> {
  const root = await scratchDir(prefix)

  await mkdir(join(root, 'src/messages'), { recursive: true })
  await Bun.write(join(root, 'tsconfig.json'), tsconfig)
  await Bun.write(join(root, 'kay.config.ts'), config)
  await Bun.write(join(root, 'src/messages/en.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Hello\' })\n')
  await Bun.write(join(root, 'src/messages/fr.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Bonjour\' })\n')

  for (const [name, source] of Object.entries(routes))
    await Bun.write(join(root, 'src/routes', name), source)

  return root
}

describe('the RGAA and WCAG tables', () => {
  it('list the 106 criteria of RGAA 4.1 and the success criteria they refer to', () => {
    expect(RGAA_CRITERIA).toHaveLength(106)
    expect(new Set(RGAA_CRITERIA.map(([id]) => id)).size).toBe(106)
    expect(WCAG_CRITERIA.length).toBeGreaterThan(40)

    for (const [, , wcag] of RGAA_CRITERIA) {
      for (const id of wcag)
        expect(WCAG_CRITERIA.some(([each]) => each === id)).toBe(true)
    }
  })

  it('only name criteria RGAA has', () => {
    const known = new Set(RGAA_CRITERIA.map(([id]) => id))

    for (const ids of [...Object.values(RGAA_FAILS), ...Object.keys(RGAA_DECIDED).map(id => [id])]) {
      for (const id of ids)
        expect(known.has(id)).toBe(true)
    }
  })
})

describe('what a scan decides', () => {
  const violation = { rule: 'image-alt', impact: 'critical', help: 'Images must have alternative text', helpUrl: 'https://example.test/image-alt', tags: ['wcag2a', 'wcag111'], route: '/about', file: 'src/routes/about.kay', nodes: [{ target: 'img', html: '<img src="a.png">', source: 'src/routes/about.kay:4:3' }] }
  const unmapped = { ...violation, rule: 'region', tags: ['best-practice'], nodes: [] }
  const audit = { audited: [{ path: '/about', route: '/about', file: 'src/routes/about.kay', locale: undefined }], skipped: [], violations: [violation, unmapped] }

  it('marks a criterion failed by the rule that breaks it, verified only where rules decide it, and leaves the rest to a person', () => {
    const byId = new Map(judge('rgaa', audit.violations, true).map(each => [each.id, each]))

    expect(byId.get('1.1')).toMatchObject({ status: 'failed', failures: [{ rule: 'image-alt', route: '/about' }] })
    expect(byId.get('8.5')?.status).toBe('verified')
    expect(byId.get('8.3')?.status).toBe('verified')
    expect(byId.get('6.2')?.status).toBe('review')
    expect([...byId.values()].filter(each => each.status === 'verified')).toHaveLength(2)
  })

  it('verifies nothing when a page was left out or none audited', () => {
    expect(judge('rgaa', [], false).every(each => each.status === 'review')).toBe(true)
  })

  it('files a failure under the success criterion its rule is tagged with, for WCAG', () => {
    const byId = new Map(judge('wcag', audit.violations, true).map(each => [each.id, each]))

    expect(byId.get('1.1.1')?.status).toBe('failed')
    expect(byId.get('2.4.2')?.status).toBe('review')
    expect(byId.get('1.4.3')?.status).toBe('review')
  })

  it('drafts the statement in French for RGAA with every criterion, the findings and those no criterion takes in', () => {
    const text = declaration(reportOf(audit, 'rgaa'), '2026-01-02')

    expect(text).toContain('# Déclaration d\'accessibilité (brouillon, RGAA 4.1)')
    expect(text).toContain('le 2026-01-02 sur 1 page')
    expect(text).toContain('| 1.1 ')
    expect(text).toContain('| Non conforme |')
    expect(text).toContain('- `image-alt` on `/about`: Images must have alternative text')
    expect(text).toContain('(src/routes/about.kay:4:3)')
    expect(text).toContain('## Autres constats')
    expect(text.match(/^\| \d+\.\d+ /gm)).toHaveLength(106)
  })

  it('drafts it in English for WCAG', () => {
    const text = declaration(reportOf(audit, 'wcag'), '2026-01-02')

    expect(text).toContain('# Accessibility statement (draft, WCAG 2.1)')
    expect(text).toContain('| Failed |')
  })

  it('fails the run for a finding or a page the site got wrong, not for a page left out', () => {
    const page = { path: '/admin', route: '/admin', file: 'src/routes/admin.kay', why: 'it answers 401', whyFr: 'elle répond 401' }

    expect(failed({ audited: audit.audited, violations: [], skipped: [{ ...page, failed: false }] })).toBe(false)
    expect(failed({ audited: audit.audited, violations: [], skipped: [{ ...page, failed: true }] })).toBe(true)
    expect(failed({ audited: [], violations: [], skipped: [] })).toBe(true)
    expect(failed({ audited: audit.audited, violations: [violation], skipped: [] })).toBe(true)
    expect(formatReport(reportOf(audit, 'rgaa'))).toContain('img  src/routes/about.kay:4:3')
  })
})

describe('the reason a page the browser failed on is left out', () => {
  it('names the first error beside the last when they differ, and once when they are the same', () => {
    expect(browserFailure([new Error('tab crashed'), new Error('timed out')])).toEqual({ why: 'the browser could not check it: tab crashed; then: timed out', whyFr: 'le navigateur n\'a pas pu la vérifier : tab crashed ; puis : timed out' })
    expect(browserFailure([new Error('timed out'), new Error('timed out')]).why).toBe('the browser could not check it: timed out')
    expect(browserFailure(['gone']).why).toBe('the browser could not check it: gone')
  })
})

describe('kay a11y refusing before it builds anything', () => {
  it('says which variable names Chrome when there is none', async () => {
    const root = await project('a11y-nochrome-', 'export default {}\n', { 'index.kay': 'head\n  title Home\nmain\n  h1 Home\n' })

    try {
      const { code, stderr } = await run(root, ['.'], { BUN_CHROME_PATH: '/nowhere/chrome', PATH: '/nonexistent' })

      expect(code).toBe(1)
      expect(stderr).toContain('BUN_CHROME_PATH')
      expect(stderr).toContain('/nowhere/chrome')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a standard it does not know', async () => {
    const { code, stderr } = await run('.', ['--standard', 'section508'])

    expect(code).toBe(1)
    expect(stderr).toContain('--standard takes rgaa or wcag')
  })
})

describe.skipIf(skipBrowser)('kay a11y on a site', () => {
  let root: string
  let clean: string

  beforeAll(async () => {
    root = await project('a11y-site-', 'export default { base: \'/app\', i18n: { locales: [\'fr\', \'en\'], defaultLocale: \'fr\' } }\n', {
      'index.kay': 'head\n  title Accueil\nmain\n  h1 Accueil\n',
      'about.kay': 'head\n  title About\nmain\n  h1 About\n  img(src="/pixel.png")\n',
      'items/[id].kay': '--- server\nexport const page = { prerender: [{ id: \'1\' }, { id: \'2\' }] }\n---\nhead\n  title Item\nmain\n  h1 Item\n',
      'tags/[tag].kay': 'head\n  title Tag\nmain\n  h1 Tag\n',
      'private.kay': '--- server\nctx.redirect(\'/login\')\n---\nmain\n  h1 Private\n',
      'members/_guard.ts': 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => {\n  deny(403, \'Members only\')\n})\n',
      'members/index.kay': 'head\n  title Members\nmain\n  h1 Members\n',
      'boom.kay': '--- server\nthrow new Error(\'server boom\')\n---\nmain\n  h1 Never\n',
    })
    clean = await project('a11y-clean-', 'export default {}\n', { 'index.kay': 'head\n  title Home\nmain\n  h1 Home\n' })
  }, 60_000)

  afterAll(async () => {
    await Promise.all([root, clean].map(async dir => dir && rm(dir, { recursive: true, force: true })))
  })

  it('opens each locale of each page and each prerendered param under the base, finds the broken image with its line, and fails the run', async () => {
    const { code, stdout } = await run(root, ['.', '--format', 'json'])

    expect(code).toBe(1)

    const report = JSON.parse(stdout) as ReturnType<typeof reportOf> & { declaration: string }
    const paths = report.audited.map(page => page.path)
    const browserFailures = report.skipped.filter(page => page.failed && page.why.startsWith('the browser could not'))

    // A page the browser failed on names its reason here, not as a path missing below.
    expect(browserFailures).toEqual([])

    expect(report.standard).toBe('rgaa')
    expect(paths).toEqual(expect.arrayContaining(['/', '/en', '/about', '/en/about', '/items/1', '/items/2', '/en/items/1', '/en/items/2']))
    expect(paths.some(path => path.includes('tags'))).toBe(false)

    const image = report.violations.find(each => each.rule === 'image-alt' && each.route === '/about')

    expect(image?.nodes[0]?.source).toMatch(/^src\/routes\/about\.kay:5:/)
    expect(report.violations.filter(each => each.route === '/' && each.rule === 'image-alt')).toEqual([])

    const left = new Map(report.skipped.map(page => [page.route, page]))

    expect(left.get('/tags/:tag')).toMatchObject({ failed: false })
    expect(left.get('/private')?.why).toContain('redirects to')
    expect(left.get('/private')?.failed).toBe(false)
    expect(left.get('/members')).toMatchObject({ failed: false })
    expect(left.get('/members')?.why).toContain('403')
    expect(left.get('/boom')).toMatchObject({ failed: true })
    expect(left.get('/boom')?.why).toContain('500')

    const drafted = await readFile(report.declaration, 'utf8')

    expect(drafted).toContain('Déclaration d\'accessibilité')
    expect(drafted).toContain('/boom')
    expect(drafted).toContain('elle répond 500')
  }, 180_000)

  it('exits 0 for a site with nothing to report, and drafts its statement where it is asked', async () => {
    const file = join(clean, 'out', 'statement.md')
    const { code, stdout } = await run(clean, ['.', '--standard', 'wcag', '--declaration', file])

    expect(code).toBe(0)
    expect(stdout).toContain('1 page audited, 0 not audited, 0 findings')
    expect(stdout).toContain('WCAG:')
    expect(await readFile(file, 'utf8')).toContain('Accessibility statement')
  }, 120_000)

  it('stops the server and Chrome it started once the run is over', async () => {
    const dir = await scratchDir('a11y-stop-')
    const chrome = join(dir, 'chrome.sh')
    const chromePids = join(dir, 'chrome.pids')
    const serverPids = join(dir, 'server.pids')
    const stopped = await project('a11y-stop-site-', 'export default {}\n', {
      // Only the server booted for the audit has KAY_START_PID; the audit itself lists the page without it.
      'index.kay': `--- server\nif (process.env.KAY_START_PID !== undefined)\n  await Bun.write(${JSON.stringify(serverPids)}, \`\${process.pid}\\n\`)\n---\nhead\n  title Home\nmain\n  h1 Home\n`,
    })

    try {
      await Bun.write(chrome, `#!/bin/sh\necho $$ >> ${JSON.stringify(chromePids)}\nexec ${JSON.stringify(browserPath())} "$@"\n`)
      await chmod(chrome, 0o755)

      const { code } = await run(stopped, ['.', '--dry-run', '--format', 'json'], { BUN_CHROME_PATH: chrome })
      const [server, browser] = await Promise.all([pids(serverPids), pids(chromePids)])

      expect(code).toBe(0)
      expect(server.length).toBeGreaterThan(0)
      expect(browser.length).toBeGreaterThan(0)
      expect(await Promise.all([...server, ...browser].map(gone))).toEqual([...server, ...browser].map(() => true))
    }
    finally {
      await Promise.all([dir, stopped].map(async each => rm(each, { recursive: true, force: true })))
    }
  }, 120_000)

  it('opens the pages at the path trailingSlash gives them', async () => {
    const slashed = await project('a11y-slash-', 'export default { trailingSlash: \'always\' }\n', {
      'index.kay': 'head\n  title Home\nmain\n  h1 Home\n',
      'about.kay': 'head\n  title About\nmain\n  h1 About\n',
    })

    try {
      const { code, stdout } = await run(slashed, ['.', '--format', 'json', '--dry-run'])
      const report = JSON.parse(stdout) as ReturnType<typeof reportOf>

      expect(code).toBe(0)
      expect(report.skipped).toEqual([])
      expect(report.audited.map(page => page.path).toSorted()).toEqual(['/', '/about/'])
    }
    finally {
      await rm(slashed, { recursive: true, force: true })
    }
  }, 120_000)

  it('says in the text and in the JSON why a run that audited no page failed', async () => {
    const empty = await project('a11y-empty-', 'export default {}\n', { 'tags/[tag].kay': 'head\n  title Tag\nmain\n  h1 Tag\n' })

    try {
      const text = await run(empty, ['.', '--dry-run'])
      const json = await run(empty, ['.', '--dry-run', '--format', 'json'])

      expect(text.code).toBe(1)
      expect(text.stdout).toContain('0 pages audited, 1 not audited, 0 findings')
      expect(text.stdout).toContain('kay a11y: no page could be audited, which fails the run')
      expect(json.code).toBe(1)
      expect(JSON.parse(json.stdout)).toMatchObject({ audited: [], failure: 'no page could be audited, which fails the run' })
    }
    finally {
      await rm(empty, { recursive: true, force: true })
    }
  }, 120_000)

  it('audits and prints with --dry-run, and writes no draft', async () => {
    const file = join(clean, 'out', 'dry.md')
    const { code, stdout } = await run(clean, ['.', '--declaration', file, '--dry-run'])

    expect(code).toBe(0)
    expect(stdout).toContain('Draft statement, not written')
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(clean, '.kay', 'a11y', 'declaration.md'))).toBe(false)
  }, 120_000)

  it('says it is a dry run in the JSON, and writes no draft either', async () => {
    const file = join(clean, 'out', 'dry-json.md')
    const { code, stdout } = await run(clean, ['.', '--declaration', file, '--dry-run', '--format', 'json'])
    const report = JSON.parse(stdout) as { dryRun: boolean, declaration: string, failure: string | null }

    expect(code).toBe(0)
    expect(report).toMatchObject({ dryRun: true, declaration: file, failure: null })
    expect(existsSync(file)).toBe(false)
  }, 120_000)
})
