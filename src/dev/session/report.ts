import type { TypeProblem } from '../refuse'
import { networkInterfaces } from 'node:os'
import process from 'node:process'

// The type errors the terminal lists before it counts the rest.
const MAX_TYPE_LINES = 10
const LINE_BREAK = /\r?\n/
const WS_SCHEME = /^ws:\/\//
// The interfaces of containers, bridges and VPNs, whose address a phone on the network does not reach.
const VIRTUAL_INTERFACE = /^(?:docker|br-|bridge|veth|virbr|vmnet|vboxnet|tun|utun|tap|wg|tailscale|zt|lxc|lxd|cni|flannel)/
const STDERR = 2
// eslint-disable-next-line no-control-regex -- escape sequences are what it strips
const ANSI_STYLE = /\x1B\[[\d;]*m/g

// What kay dev says: the address, each restart and stylesheet swap, the type errors and the processes exiting, as lines of text, or as one JSON object per line under `json`.
export class Reporter {
  readonly json: boolean
  // Leaves out the line per restart and stylesheet swap, and the keys' hint.
  readonly quiet: boolean
  // A rebuild line the one before said already is rewritten with a count, on a terminal only: elsewhere every line stays.
  readonly collapses: boolean
  // Where the servers and the client builder print, which `json` keeps off stdout for its events.
  readonly output: 'inherit' | number
  private print: (line: string) => void
  private color: boolean
  // The last rebuild line, kept to be rewritten when the next is the same; anything printed after it, by kay dev or the app, ends it.
  private repeatable: { key: string, count: number, rows: number } | undefined

  constructor(log: ((line: string) => void) | undefined, format: 'text' | 'json' | undefined, quiet: boolean | undefined) {
    this.print = log ?? console.log
    this.json = format === 'json'
    this.quiet = quiet === true
    this.color = log === undefined && !this.json && process.stdout.isTTY && process.env.NO_COLOR === undefined
    this.collapses = log === undefined && !this.json && process.stdout.isTTY
    this.output = this.json ? STDERR : 'inherit'
  }

  log(line: string) {
    this.repeatable = undefined
    this.print(line)
  }

  // Something else was printed after the last rebuild line, which is no longer the last.
  endRepeat() {
    this.repeatable = undefined
  }

  // One event, as a line of text, or as a JSON object of its fields under `json`.
  say(event: string, fields: object, line: string) {
    this.log(this.json ? JSON.stringify({ event, time: new Date().toISOString(), ...fields }) : line)
  }

  dim(text: string): string {
    return this.color ? `\x1B[2m${text}\x1B[22m` : text
  }

  // The first server listens: its address, the one on the network, and the debugger's.
  ready(url: string, ms: number, inUse: number | undefined, network: string | undefined, debuggerUrl: string | undefined) {
    this.say('ready', { url, ms, ...inUse !== undefined && { inUse }, ...network !== undefined && { network } }, `kay dev: ${url} (ready in ${ms} ms${inUse === undefined ? '' : `, ${inUse} was in use`})`)

    if (network !== undefined && !this.json)
      this.log(`kay dev: ${network} on the network`)

    if (debuggerUrl !== undefined)
      this.say('debugger', { url: debuggerUrl }, `kay dev: debugger on ${debuggerUrl}, https://debug.bun.sh/#${debuggerUrl.replace(WS_SCHEME, '')}`)
  }

  noBrowser(url: string, command: string) {
    this.say('no-browser', { command }, `kay dev: no browser to open ${url} with: ${command} is not installed`)
  }

  keys() {
    this.log(`kay dev: ${this.dim('press o to open it in the browser, r to restart, c to clear the screen, q to quit')}`)
  }

  // A restart or a reload is over; `reloaded` says the running process took the change in, where a restart is a new one. Quiet, a restart is said only when it moved the address.
  restarted(files: string[], changed: string, ms: number, url: string | undefined, moved: boolean, reloaded: boolean) {
    const verb = reloaded ? 'reloaded' : 'restarted'

    if (!this.quiet || moved)
      this.sayRebuild('restart', { changed: files, ms, ...reloaded && { reloaded }, ...url !== undefined && { url } }, `${changed}: ${verb}${moved ? `, now on ${url}` : ''}`, `${this.stamp()} ${changed}: ${verb} in ${ms} ms${moved ? `, now on ${url}` : ''}`)
  }

  styles(files: string[], changed: string, ms: number) {
    if (!this.quiet)
      this.sayRebuild('styles', { changed: files, ms }, `${changed}: stylesheets swapped`, `${this.stamp()} ${changed}: stylesheets swapped in ${ms} ms`)
  }

  // The errors a check ended with, which the caller says only when they changed.
  typeErrors(problems: TypeProblem[]) {
    if (problems.length === 0) {
      if (!this.quiet)
        this.say('types', { errors: [] }, `${this.stamp()} types: no errors`)

      return
    }

    const lines = problems.slice(0, MAX_TYPE_LINES).map(({ file, line, column, code, message }) => `  ${file}:${line}:${column}${code === undefined ? '' : ` ${code}`} ${message.split(LINE_BREAK)[0]}`)
    const more = problems.length - lines.length

    this.say('types', { errors: problems.map(({ report: _report, ...problem }) => problem) }, [`${this.stamp()} types: ${problems.length} type error${problems.length === 1 ? '' : 's'}`, ...lines, ...more > 0 ? [`  and ${more} more`] : []].join('\n'))
  }

  exit(code: number) {
    this.say('exit', { code }, `${this.stamp()} the server exited with code ${code}, waiting for a change`)
  }

  builderExit() {
    this.say('builder-exit', {}, `${this.stamp()} the process building the client exited; each change starts it again, the servers building their own until one build succeeds`)
  }

  private stamp(): string {
    return this.dim(new Date().toLocaleTimeString('en-GB'))
  }

  private sayRebuild(event: string, fields: object, key: string, line: string) {
    if (!this.collapses) {
      this.say(event, fields, line)

      return
    }

    const count = this.repeatable?.key === key ? this.repeatable.count + 1 : 1
    const shown = count > 1 ? `${line} (x${count})` : line

    if (this.repeatable !== undefined && count > 1)
      process.stdout.write(`\x1B[${this.repeatable.rows}A\x1B[J`)

    this.print(shown)
    this.repeatable = { key, count, rows: Math.max(1, Math.ceil(shown.replace(ANSI_STYLE, '').length / (process.stdout.columns || 80))) }
  }
}

// The system's browser, or the command `BROWSER` names.
function browserCommand(): string[] {
  if (process.env.BROWSER !== undefined && process.env.BROWSER !== '')
    return [process.env.BROWSER]

  if (process.platform === 'darwin')
    return ['open']

  return process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open']
}

// `missing` hears of a machine without a browser.
export function openBrowser(url: string, missing: (command: string) => void): void {
  const command = browserCommand()

  try {
    Bun.spawn([...command, url], { stdio: ['ignore', 'ignore', 'ignore'] }).unref()
  }
  catch {
    missing(command[0]!)
  }
}

// The address of this machine others on its network reach it by: the first of an interface no container, bridge or VPN made, else the first.
export function networkAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | undefined {
  const external = Object.entries(interfaces).flatMap(([name, entries]) => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => ({ name, address: entry.address })))

  return (external.find(entry => !VIRTUAL_INTERFACE.test(entry.name)) ?? external[0])?.address
}

// The files a restart came from, as its report names them.
export function describe(files: string[]): string {
  const [first] = files

  if (first === undefined)
    return 'a change'

  return files.length === 1 ? first : `${first} and ${files.length - 1} more`
}
