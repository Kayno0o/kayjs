#!/usr/bin/env bun
// Kay v2 coding-agent eval harness: init task workspaces, grade solutions, and aggregate friction reports.

import type { Cli, Commands } from '@kaynooo/cli-kit'
import type { TaskGrade } from './lib/types'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { badUsage, fail, parse, runCli } from '@kaynooo/cli-kit'
import { buildEvalReport, formatEvalReport, formatGradeSummary } from './lib/report'
import { gradeTask } from './lib/verify'
import { initTaskWorkspace } from './lib/workspace'
import { getTask, listTasks } from './tasks/index'

function readGradeFiles(inputs: readonly string[]): TaskGrade[] {
  const grades: TaskGrade[] = []
  for (const input of inputs) {
    const abs = resolve(input)
    if (!existsSync(abs))
      throw new Error(`evals: path not found: ${abs}`)
    const st = statSync(abs)
    const files = st.isDirectory()
      ? readdirSync(abs).filter(f => f.endsWith('.json')).sort().map(f => join(abs, f))
      : [abs]
    for (const file of files) {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (Array.isArray(parsed)) {
        for (const item of parsed)
          grades.push(item as TaskGrade)
      }
      else if (parsed !== null && typeof parsed === 'object' && 'results' in parsed && Array.isArray((parsed as { results: unknown }).results)) {
        for (const item of (parsed as { results: TaskGrade[] }).results)
          grades.push(item)
      }
      else {
        grades.push(parsed as TaskGrade)
      }
    }
  }
  return grades
}

const commands: Commands = {
  list: {
    summary: 'list all available agent eval tasks',
    run: async (args) => {
      const { values } = parse(args, 'bun evals/run.ts list [options]: lists all eval tasks', {
        json: { type: 'boolean', description: 'print task metadata as JSON' },
      }, { exits: [[0, 'tasks listed'], [2, 'a usage error']] })

      const tasks = listTasks()
      if (values.json === true) {
        console.log(JSON.stringify(tasks.map(t => t.spec), null, 2))
        return 0
      }

      console.log('Kay v2 Agent Eval Tasks:\n')
      for (const { spec } of tasks) {
        const budget = spec.maxJs ?? 'none'
        console.log(`  ${spec.id.padEnd(24)} ${spec.title} (template: ${spec.template}, max-js: ${budget})`)
      }
      return 0
    },
  },

  init: {
    summary: 'scaffold a clean task workspace linked to local @kayjs/* packages',
    run: async (args) => {
      const { values, positionals } = parse(
        args,
        'bun evals/run.ts init [options] <taskId> <destDir>: scaffolds a clean workspace for an eval task',
        {
          force: { type: 'boolean', description: 'overwrite into a non-empty destination directory' },
          json: { type: 'boolean', description: 'print scaffold result as JSON' },
        },
        {
          positionals: ['<taskId>', '<destDir>'],
          exits: [[0, 'workspace initialized'], [1, 'initialization failed'], [2, 'a usage error']],
        },
      )
      const [taskId, destDir] = positionals
      if (taskId === undefined || destDir === undefined)
        return badUsage('provide <taskId> and <destDir>')

      try {
        const task = getTask(taskId)
        const result = initTaskWorkspace(task, destDir, { force: values.force === true })
        if (values.json === true) {
          console.log(JSON.stringify(result, null, 2))
        }
        else {
          console.log(`Initialized ${result.task.id} in ${result.dir} (${result.files.length} files)`)
          console.log(`Prompt: ${result.promptPath}`)
          console.log(`Next: run your coding agent in ${result.dir}, then grade with:`)
          console.log(`  bun evals/run.ts grade ${result.task.id} ${result.dir}`)
        }
        return 0
      }
      catch (err) {
        return fail(err instanceof Error ? err.message : String(err), 1)
      }
    },
  },

  grade: {
    summary: 'grade a task workspace with kay check, kay build, bun test, and functional assertions',
    run: async (args) => {
      const { values, positionals } = parse(
        args,
        'bun evals/run.ts grade [options] <taskId> <dir>: grades a completed task directory',
        {
          'transcript': { type: 'string', description: 'optional path to an agent session transcript (.jsonl) to extract friction metrics' },
          'json': { type: 'boolean', description: 'print structured TaskGrade JSON on stdout' },
          'skip-tests': { type: 'boolean', description: 'skip running bun test inside the task workspace' },
        },
        {
          positionals: ['<taskId>', '<dir>'],
          exits: [[0, 'all checks, build budget, tests, and assertions passed'], [1, 'one or more checks or assertions failed'], [2, 'a usage error']],
        },
      )
      const [taskId, dir] = positionals
      if (taskId === undefined || dir === undefined)
        return badUsage('provide <taskId> and <dir>')

      try {
        const task = getTask(taskId)
        const grade = await gradeTask(task, dir, {
          ...(values.transcript !== undefined ? { transcriptPath: resolve(values.transcript) } : {}),
          skipTests: values['skip-tests'] === true,
        })
        if (values.json === true)
          console.log(JSON.stringify(grade, null, 2))
        else
          console.log(formatGradeSummary(grade))
        return grade.ok ? 0 : 1
      }
      catch (err) {
        return fail(err instanceof Error ? err.message : String(err), 1)
      }
    },
  },

  report: {
    summary: 'combine saved TaskGrade JSON files into a compact friction summary table',
    run: async (args) => {
      const { values, positionals } = parse(
        args,
        'bun evals/run.ts report [options] <path...>: aggregates TaskGrade JSON files or directories into a summary report',
        {
          json: { type: 'boolean', description: 'print aggregated EvalReport JSON' },
        },
        {
          positionals: ['<path...>'],
          exits: [[0, 'report generated'], [1, 'failed to read grade files'], [2, 'a usage error']],
        },
      )
      if (positionals.length === 0)
        return badUsage('provide at least one TaskGrade JSON file or directory')

      try {
        const grades = readGradeFiles(positionals)
        const report = buildEvalReport(grades)
        if (values.json === true)
          console.log(JSON.stringify(report, null, 2))
        else
          console.log(formatEvalReport(report))
        return 0
      }
      catch (err) {
        return fail(err instanceof Error ? err.message : String(err), 1)
      }
    },
  },
}

const cli: Cli = {
  name: 'kay-evals',
  about: 'coding-agent friction evaluation suite for kay v2',
  commands,
  usage: false,
}

if (import.meta.main) {
  const code = await runCli(cli, Bun.argv.slice(2))
  if (code !== 0)
    process.exit(code)
}
