import type { Shot } from '../dev/screenshot'
import type { Command } from './command'
import { loadConfig } from '../config'
import { screenshot } from '../dev/screenshot'
import { checkSize, MAX_HEIGHT, MAX_WIDTH, ShotRefusedError } from '../dev/screenshot-limits'
import { basePath } from '../server/base'
import { formatOption, printDocument, projectRoot } from './command'
import { USAGES } from './usages'

const WIDTH = /^\d+$/
// eslint-disable-next-line no-control-regex -- control characters are what it finds
const UNSAFE_COOKIE = /[;\s\u0000-\u001F\u007F]/

// Shoots a page of the running `kay dev` in a headless Chrome, for what the page's HTML does not tell: how it lays out at phone width, in the dark.
export const screenshotCommand: Command = {
  usage: USAGES.screenshot,
  options: { 'width': { type: 'string', multiple: true }, 'height': { type: 'string' }, 'scheme': { type: 'string' }, 'full-page': { type: 'boolean' }, 'cookie': { type: 'string', multiple: true }, 'format': { type: 'string' } },
  positionals: 2,
  run: async ({ values, positionals: [path, dir] }, refuse) => {
    const format = formatOption('screenshot', values.format)

    if (format === undefined)
      return 1

    if (path === undefined)
      return refuse('kay screenshot takes the path of the page, such as /about')

    const scheme = values.scheme ?? 'light'

    if (scheme !== 'light' && scheme !== 'dark')
      return refuse(`--scheme takes light or dark, not ${String(scheme)}`)

    const widths = Array.isArray(values.width) ? values.width : []
    const height = typeof values.height === 'string' ? values.height : undefined

    for (const value of [...widths, ...height === undefined ? [] : [height]]) {
      if (!WIDTH.test(value))
        return refuse(`--width and --height take a number of pixels, not ${value}`)
    }

    const cookies: { name: string, value: string }[] = []

    for (const cookie of Array.isArray(values.cookie) ? values.cookie : []) {
      const at = cookie.indexOf('=')
      const name = cookie.slice(0, at)
      const value = cookie.slice(at + 1)

      if (at < 1 || UNSAFE_COOKIE.test(name) || UNSAFE_COOKIE.test(value))
        return refuse(`--cookie takes name=value, with no \`;\`, space or control character in either, not ${JSON.stringify(cookie)}`)

      cookies.push({ name, value })
    }

    const root = projectRoot('screenshot', dir, format)

    if (root === undefined)
      return 1

    try {
      // Refused up front, before the config loads or a browser starts.
      for (const width of widths)
        checkSize('--width', Number(width), MAX_WIDTH)

      if (height !== undefined)
        checkSize('--height', Number(height), MAX_HEIGHT)

      const report = await screenshot(root, path, { widths: widths.length === 0 ? undefined : widths.map(Number), height: height === undefined ? undefined : Number(height), scheme, fullPage: values['full-page'] === true, base: await baseOf(root), cookies })

      if (format === 'json') {
        printDocument(report)

        return 0
      }

      console.log(`${report.url} answered ${report.status}`)

      for (const shot of report.shots) {
        console.log(`${shot.width} px ${shot.scheme}: ${shot.file} (${shot.size.width}x${shot.size.height}${shot.cut ? ', cut' : ''}), ${shot.diffSkipped === true ? 'too large to compare with the last' : changedSince(shot)}`)
      }

      for (const line of report.console)
        console.error(`console: ${line}`)

      for (const problem of report.problems)
        console.error(`kay dev: ${problem.kind}: ${problem.message}`)

      return 0
    }
    catch (error) {
      if (!(error instanceof ShotRefusedError))
        throw error

      console.error(`kay screenshot: ${error.message}`)

      return 1
    }
  },
}

async function baseOf(root: string): Promise<string> {
  try {
    return basePath((await loadConfig(root)).base)
  }
  catch {
    return ''
  }
}

function changedSince({ diff }: Shot): string {
  if (diff === undefined)
    return 'first shot of it'

  return diff.changed === 0 ? 'unchanged since the last' : `${diff.changed} pixels changed (${(diff.ratio * 100).toFixed(2)}%), see ${diff.file}`
}
