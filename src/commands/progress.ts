import type { BuildProgress } from '../build/pipeline'
import process from 'node:process'
import { createColors } from '@kaynooo/utils/tools/colors'

interface ProgressStream {
  isTTY?: boolean
  columns?: number | undefined
  write: (text: string) => unknown
}

export interface ProgressLine {
  update: (progress: BuildProgress) => void
  stop: () => void
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_MS = 80
const BAR_WIDTH = 20
// Back to the start of the line, then erases it.
const CLEAR_LINE = '\r\x1B[2K'
// What the console writes with, to the terminal the line is drawn on or the other.
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug', 'dir', 'dirxml', 'table', 'trace', 'group', 'groupCollapsed', 'groupEnd', 'count', 'countReset', 'time', 'timeEnd', 'timeLog', 'assert'] as const

// One line on `stream`, redrawn in place while a build runs: a spinner, the step, a bar where its total is known, and the time since it began.
// Only on a terminal that takes control codes, so a log, CI or `NO_COLOR` gets the lines it always did; whatever else is printed meanwhile clears the line first, and the next frame draws it again under it.
export function progressLine(stream: ProgressStream = process.stderr, env: Record<string, string | undefined> = process.env): ProgressLine | undefined {
  if (stream.isTTY !== true || env.NO_COLOR !== undefined || env.NODE_DISABLE_COLORS !== undefined || env.TERM === 'dumb')
    return undefined

  const paint = createColors({ stream })
  // Its own write, taken before the line clears itself ahead of every other.
  const write = stream.write.bind(stream)
  const started = performance.now()
  let current: BuildProgress | undefined
  let frame = 0
  let drawn = false
  const clear = () => {
    if (drawn)
      write(CLEAR_LINE)

    drawn = false
  }
  const draw = () => {
    if (current === undefined)
      return

    const text = progressText(current, FRAMES[frame++ % FRAMES.length]!, performance.now() - started)
    // A terminal that does not say its width, as a pseudo-terminal may, answers 0.
    const width = (stream.columns === undefined || stream.columns === 0 ? 80 : stream.columns) - 1

    write(`${CLEAR_LINE}${paint.cyan(text.slice(0, 1))}${text.slice(1, width)}`)
    drawn = true
  }
  const timer = setInterval(draw, FRAME_MS)
  const restore = interceptOutput(clear)
  const onExit = () => clear()

  timer.unref()
  process.on('exit', onExit)

  return {
    update: (progress) => {
      current = progress
      draw()
    },
    stop: () => {
      clearInterval(timer)
      clear()
      restore()
      process.off('exit', onExit)
    },
  }
}

// `⠹ prerendering ████████░░░░░░░░░░░░ 8/20 routes 4.2s`; a step with no total has no bar.
export function progressText({ step, done, total, unit }: BuildProgress, spinner: string, ms: number): string {
  const counted = total !== undefined && total > 0 ? ` ${bar(Math.min(done ?? 0, total) / total)} ${Math.min(done ?? 0, total)}/${total}${unit === undefined ? '' : ` ${unit}`}` : ''

  return `${spinner} ${step}${counted} ${(ms / 1000).toFixed(1)}s`
}

function bar(share: number): string {
  const filled = Math.round(share * BAR_WIDTH)

  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
}

// Clears the line before anything the console or a stream writes, the app's code during the build included, and answers how to put them back.
function interceptOutput(clear: () => void): () => void {
  const saved = CONSOLE_METHODS.map(name => [name, Reflect.get(console, name)] as const)
  const writes = [process.stdout, process.stderr].map(stream => [stream, Reflect.get(stream, 'write')] as const)

  for (const [name, method] of saved) {
    Reflect.set(console, name, (...args: unknown[]) => {
      clear()

      return (method as (...args: unknown[]) => unknown).apply(console, args)
    })
  }

  for (const [stream, write] of writes) {
    Reflect.set(stream, 'write', (...args: unknown[]) => {
      clear()

      return (write as (...args: unknown[]) => unknown).apply(stream, args)
    })
  }

  return () => {
    for (const [name, method] of saved)
      Reflect.set(console, name, method)

    for (const [stream, write] of writes)
      Reflect.set(stream, 'write', write)
  }
}
