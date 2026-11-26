import type { EvalReport, TaskGrade } from './types'

export function formatBytes(bytes: number): string {
  if (bytes === 0)
    return '0 B'
  if (bytes < 1024)
    return `${bytes} B`
  return `${(bytes / 1024).toFixed(2)} KB`
}

export function buildEvalReport(results: readonly TaskGrade[]): EvalReport {
  const passed = results.filter(r => r.ok).length
  const failed = results.length - passed
  const maxEagerJsBytes = results.reduce((max, r) => Math.max(max, r.build.maxEagerJsBytes), 0)
  const totalSourceReads = results.reduce((sum, r) => sum + (r.metrics?.sourceReads.count ?? 0), 0)
  const totalLlmsReads = results.reduce((sum, r) => sum + (r.metrics?.llmsReads.count ?? 0), 0)
  const totalRepeatedFailures = results.reduce((sum, r) => sum + (r.metrics?.repeatedFailures.length ?? 0), 0)

  return {
    generatedAt: new Date().toISOString(),
    results: [...results],
    summary: {
      total: results.length,
      passed,
      failed,
      maxEagerJsBytes,
      totalSourceReads,
      totalLlmsReads,
      totalRepeatedFailures,
    },
  }
}

export function formatGradeSummary(grade: TaskGrade): string {
  const status = grade.ok ? 'PASS' : 'FAIL'
  const passedAssertions = grade.assertions.filter(a => a.ok).length
  const budgetStr = grade.maxJs !== undefined ? ` / ${grade.maxJs}` : ''
  const lines: string[] = [
    `[${status}] ${grade.taskId} — ${grade.title} (${grade.durationMs} ms)`,
    `  kay check : ${grade.check.ok ? 'ok' : 'FAIL'} (${grade.check.errorCount} errors, ${grade.check.warningCount} warnings, ${grade.check.checkedFiles} files)`,
    `  kay build : ${grade.build.ok ? 'ok' : 'FAIL'} (max eager JS: ${formatBytes(grade.build.maxEagerJsBytes)}${budgetStr}${grade.build.budgetExceeded ? ' [OVER BUDGET]' : ''})`,
    `  bun test  : ${grade.tests.ran ? (grade.tests.ok ? 'ok' : `FAIL (exit ${grade.tests.exitCode})`) : 'none'}`,
    `  assertions: ${passedAssertions}/${grade.assertions.length} passed`,
  ]

  for (const a of grade.assertions) {
    if (!a.ok)
      lines.push(`    ✗ ${a.name}${a.detail !== undefined ? `: ${a.detail}` : ''}`)
  }

  if (!grade.check.ok && grade.check.errors.length > 0) {
    lines.push('  check errors:')
    for (const err of grade.check.errors.slice(0, 5)) {
      const loc = err.file !== undefined ? `${err.file}:${err.line ?? 1}:${err.col ?? 1}: ` : ''
      lines.push(`    - ${loc}${err.message}`)
    }
  }

  if (!grade.build.ok && grade.build.error !== undefined)
    lines.push(`  build error: ${grade.build.error.split('\n')[0]}`)

  if (grade.metrics !== undefined) {
    const m = grade.metrics
    const turns = m.turnsToGreen !== null ? `${m.turnsToGreen}/${m.totalTurns}` : `fail (${m.totalTurns})`
    lines.push(
      `  friction  : turns=${turns}, llms.txt reads=${m.llmsReads.count}, src/ reads=${m.sourceReads.count}, repeated failures=${m.repeatedFailures.length}`,
    )
    if (m.sourceReads.files.length > 0)
      lines.push(`    doc-gap src/ reads: ${m.sourceReads.files.join(', ')}`)
    for (const rf of m.repeatedFailures)
      lines.push(`    repeated (${rf.count}x): ${rf.category}`)
  }

  return lines.join('\n')
}

export function formatEvalReport(report: EvalReport): string {
  const lines: string[] = [
    '# Kay v2 Agent Eval Report',
    '',
    `Summary: **${report.summary.passed}/${report.summary.total} passed** | Max eager JS: **${formatBytes(report.summary.maxEagerJsBytes)}** | Doc-gap \`src/\` reads: **${report.summary.totalSourceReads}** | Repeated diagnostic stalls: **${report.summary.totalRepeatedFailures}**`,
    '',
    '| Task | Status | Eager JS | Budget | Check | Tests | Assertions | Turns | `llms.txt` | `src/` Reads | Repeats |',
    '| --- | --- | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ]

  for (const r of report.results) {
    const status = r.ok ? 'PASS' : 'FAIL'
    const eagerJs = formatBytes(r.build.maxEagerJsBytes)
    const budget = r.maxJs ?? '—'
    const check = r.check.ok ? 'ok' : `${r.check.errorCount} err`
    const tests = r.tests.ran ? (r.tests.ok ? 'ok' : 'FAIL') : '—'
    const passedA = r.assertions.filter(a => a.ok).length
    const assertions = `${passedA}/${r.assertions.length}`
    const turns = r.metrics === undefined
      ? '—'
      : r.metrics.turnsToGreen !== null
        ? String(r.metrics.turnsToGreen)
        : `>${r.metrics.totalTurns}`
    const llms = r.metrics === undefined ? '—' : String(r.metrics.llmsReads.count)
    const srcReads = r.metrics === undefined ? '—' : String(r.metrics.sourceReads.count)
    const repeats = r.metrics === undefined ? '—' : String(r.metrics.repeatedFailures.length)

    lines.push(`| \`${r.taskId}\` | ${status} | ${eagerJs} | ${budget} | ${check} | ${tests} | ${assertions} | ${turns} | ${llms} | ${srcReads} | ${repeats} |`)
  }

  const frictionNotes: string[] = []
  for (const r of report.results) {
    if (r.metrics !== undefined && r.metrics.sourceReads.files.length > 0)
      frictionNotes.push(`- **${r.taskId}** read internal source (potential \`llms.txt\` gap): ${r.metrics.sourceReads.files.map(f => `\`${f}\``).join(', ')}`)
    if (r.metrics !== undefined) {
      for (const rf of r.metrics.repeatedFailures)
        frictionNotes.push(`- **${r.taskId}** stalled ${rf.count}x on \`${rf.category}\``)
    }
    if (!r.ok) {
      const failedA = r.assertions.filter(a => !a.ok).map(a => a.name)
      const reasons: string[] = []
      if (!r.check.ok)
        reasons.push(`kay check (${r.check.errorCount} errors)`)
      if (!r.build.ok)
        reasons.push(r.build.budgetExceeded ? 'over --max-js budget' : 'build failed')
      if (r.tests.ran && !r.tests.ok)
        reasons.push('bun test failed')
      if (failedA.length > 0)
        reasons.push(`failed assertions: ${failedA.join(', ')}`)
      frictionNotes.push(`- **${r.taskId}** FAILED: ${reasons.join('; ')}`)
    }
  }

  if (frictionNotes.length > 0) {
    lines.push('', '## Friction & Failure Notes', '', ...frictionNotes)
  }

  return lines.join('\n')
}
