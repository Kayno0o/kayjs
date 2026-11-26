import type { BundleReport } from '../../packages/kay/src/build/report'
import type { CheckDiagnostic } from '../../packages/kay/src/cli/check'
import type { ScaffoldTemplate } from '../../packages/kay/src/cli/new'
import type { TestApp } from '../../packages/kay/src/test/index'

export interface TaskSpec {
  id: string
  title: string
  description: string
  template: ScaffoldTemplate
  maxJs?: string
  packages: string[]
  tags: string[]
}

export interface AssertionResult {
  name: string
  ok: boolean
  detail?: string
}

export interface VerifyContext {
  dir: string
  task: TaskSpec
  app: TestApp
  bundleReport?: BundleReport
}

export type TaskVerifier = (ctx: VerifyContext) => Promise<AssertionResult[]>

export interface TaskDefinition {
  spec: TaskSpec
  promptPath: string
  prompt: string
  verify: TaskVerifier
}

export interface CheckSummary {
  ok: boolean
  checkedFiles: number
  errorCount: number
  warningCount: number
  errors: CheckDiagnostic[]
  warnings: CheckDiagnostic[]
  rawOutput?: string
}

export interface RouteWeightSummary {
  path: string
  jsGzip: number
  cssGzip: number
  firstLoad: number
  islands: number
}

export interface BuildSummary {
  ok: boolean
  maxEagerJsBytes: number
  routeWeights: RouteWeightSummary[]
  budgetExceeded: boolean
  error?: string
}

export interface TestRunSummary {
  ran: boolean
  ok: boolean
  exitCode: number
  output: string
}

export interface RepeatedFailure {
  category: string
  count: number
  sample: string
}

export interface TranscriptMetrics {
  totalTurns: number
  turnsToGreen: number | null
  sourceReads: {
    count: number
    files: string[]
  }
  llmsReads: {
    count: number
    files: string[]
  }
  repeatedFailures: RepeatedFailure[]
  totalToolCalls: number
  formatDetected: string
}

export interface TaskGrade {
  taskId: string
  title: string
  dir: string
  ok: boolean
  durationMs: number
  maxJs?: string
  maxJsBytes?: number
  check: CheckSummary
  build: BuildSummary
  tests: TestRunSummary
  assertions: AssertionResult[]
  metrics?: TranscriptMetrics
}

export interface EvalReport {
  generatedAt: string
  results: TaskGrade[]
  summary: {
    total: number
    passed: number
    failed: number
    maxEagerJsBytes: number
    totalSourceReads: number
    totalLlmsReads: number
    totalRepeatedFailures: number
  }
}
