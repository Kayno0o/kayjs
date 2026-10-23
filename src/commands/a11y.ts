import type { Standard } from '../a11y/standards'
import type { Command } from './command'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { A11yRefusedError, auditSite } from '../a11y/audit'
import { declaration, failed, formatReport, reportOf, tally } from '../a11y/report'
import { KAY_DIR } from '../build/assets'
import { loadConfig } from '../config'
import { buildingWithoutEnv } from '../server/env-state'
import { count, formatOption, printDocument, printFailure, projectRoot, withStdoutOnStderr } from './command'
import { USAGES } from './usages'

const STANDARDS = new Set(['rgaa', 'wcag'])
const FRENCH = /^fr(?:-|$)/i

// Opens every page of the site in a headless Chrome, runs axe-core on it, and drafts the accessibility statement from what it found. Exits 1 on any finding, for CI.
export const a11y: Command = {
  usage: USAGES.a11y,
  options: { 'standard': { type: 'string' }, 'declaration': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'format': { type: 'string' }, 'quiet': { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [path] }, refuse) => {
    const format = formatOption('a11y', values.format)

    if (format === undefined)
      return 1

    if (values.standard !== undefined && !STANDARDS.has(values.standard as string))
      return refuse(`--standard takes rgaa or wcag, not ${String(values.standard)}`)

    const root = projectRoot('a11y', path, format)

    if (root === undefined)
      return 1

    // The machine auditing lacks the server's environment, which a page's module may read when listed; the server booted for the audit has it.
    buildingWithoutEnv()

    try {
      const config = await loadConfig(root)
      const standard = (values.standard as Standard | undefined) ?? (FRENCH.test(config.i18n?.defaultLocale ?? config.lang ?? '') ? 'rgaa' : 'wcag')
      const quiet = values.quiet === true || format === 'json'
      const audit = await withStdoutOnStderr(async () => auditSite(root, config, (page) => {
        if (!quiet)
          console.error(`kay a11y: ${page}`)
      }))
      const report = reportOf(audit, standard)
      const file = typeof values.declaration === 'string' ? resolve(values.declaration) : join(root, KAY_DIR, 'a11y', 'declaration.md')

      const dryRun = values['dry-run'] === true

      if (!dryRun) {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, declaration(report))
      }

      if (format === 'json') {
        printDocument({ ...report, declaration: file, dryRun })
      }
      else {
        const counts = tally(report.criteria)
        const text = formatReport(report)

        if (text !== '')
          console.log(text)

        console.log(`${count(report.audited.length, 'page')} audited, ${report.skipped.length} not audited, ${count(report.violations.length, 'finding')}`)
        console.log(`${standard === 'rgaa' ? 'RGAA' : 'WCAG'}: ${counts.verified} verified, ${counts.failed} failed, ${counts.review} to review by hand`)
        console.log(`${dryRun ? 'Draft statement, not written' : 'Draft statement'}: ${relative(process.cwd(), file) || file}`)

        if (report.audited.length === 0)
          console.log('kay a11y: no page could be audited, which fails the run')
      }

      return failed(report) ? 1 : 0
    }
    catch (error) {
      printFailure('a11y', error instanceof A11yRefusedError ? error.message : error, format)

      return 1
    }
  },
}
