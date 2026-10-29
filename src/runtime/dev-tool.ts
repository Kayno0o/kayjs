import type { DevRequest, DevResponse } from '../server/dev'
// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevProblem, DevProblems } from './dev-boot'

const HOST = 'kay-dev'
const STATE_KEY = 'kay-dev'
const LAYOUT_KEY = 'kay-dev-layout'
const CHECK_PROBLEMS = 'kay-check-problems'
// The type errors `kay dev` found, in a block of their own that the `types` event it sends rewrites.
const TYPE_PROBLEMS = 'kay-type-problems'
const TYPES_EVENT = 'kay-dev-types'
const REQUEST = 'kay-dev-request'
const HEAD_HEADER = 'x-kay-dev'
const REQUEST_URL = '/_kay/dev/request'
const STACK_URL = '/_kay/dev/stack'
const DATA_TAB_URL = '/_kay/dev/tab/data.js'
const JOBS_TAB_URL = '/_kay/dev/tab/jobs.js'
const STYLES_TAB_URL = '/_kay/dev/tab/styles.js'
const ROUTES_TAB_URL = '/_kay/dev/tab/routes.js'
const HEAD_TAB_URL = '/_kay/dev/tab/head.js'
const READING_TAB_URL = '/_kay/dev/tab/reading.js'
const ENV_TAB_URL = '/_kay/dev/tab/env.js'
const NOT_FOUND_TAB_URL = '/_kay/dev/tab/not-found.js'
const I18N_TAB_URL = '/_kay/dev/tab/i18n.js'
const NETWORK_TAB_URL = '/_kay/dev/tab/network.js'
const IMAGES_TAB_URL = '/_kay/dev/tab/images.js'
const PERFORMANCE_TAB_URL = '/_kay/dev/tab/performance.js'
// The page swaps kept for the Network tab, as many as it lists navigations.
const SWAP_LOG = 10
// A stack frame in a chunk of the browser build, which the server can point at its `.kay` line.
const CHUNK_FRAME = /\/_kay\/[\w.-]+\.js:\d+:\d+/
// The addresses the dev tool fetched itself, which the Network tab leaves out.
const OWN_FETCHES = new Set<string>()
const DEV_PATH = /\/_kay\/dev\//
const ACTION_PATH = /\/_kay\/action\//
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/i
// server-islands.ts's ISLAND_PARAM, copied as this file imports types only.
const ISLAND_PARAM = 'kay_island'
// Shown first among the response headers.
const FIRST_HEADERS = ['content-security-policy', 'content-security-policy-report-only', 'cache-control']
const PRERENDER = { 'page': 'prerendered by kay build', 'listed': 'prerendered by kay build for the paths its setting lists', 'server islands': 'prerendered by kay build, its server islands rendered on request' }
// The most problem texts a tab remembers as dismissed.
const MAX_DISMISSED = 200
// How long a copy button says it copied, or could not.
const COPIED_MS = 1500
// The pending reset of each button saying it copied.
const copyResets = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()
// A path segment, kay's `(group)`, `[param]`, `[[optional]]` and `[...rest]` names included.
const SEGMENT = String.raw`(?:\([\w@.+=-]+\)|\[{1,2}(?:\.{3})?[\w-]+\]{1,2}|[\w@.+=-])+`
const SOURCE_EXTENSION = String.raw`(?:[cm]?[jt]sx?|css)`

// A source file a problem names, with its line and column when it gives them, not one inside a URL nor a URL of kay's own: a `.kay` file named alone, a script or stylesheet once a folder or a line tells it from a word like Node.js, and an absolute one, as a URL path reads, only with a line, as a stack trace gives.
const SOURCE_POSITION = new RegExp(String.raw`(?<![\w@.+=:/\\)\]-])(?![\\/]_kay[\\/])(?:(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.kay|(?:${SEGMENT}[\\/])+${SEGMENT}\.${SOURCE_EXTENSION}|(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.${SOURCE_EXTENSION}(?=:\d))(?::\d+(?::\d+)?)?(?!\.?\w)`, 'g')
const OPENED_POSITION = /^(.+\.\w+)(?::(\d+))?(?::(\d+))?$/
// An entry of the `Server-Timing` header kay sends, one of its phases rather than a single load.
const SERVER_PHASE = /(?:^|,)\s*(guards|import|loads|render)(?:;[^,;]*)*?;dur=(\d+(?:\.\d+)?)/g

type ProblemKind = 'uncaught' | 'kay' | 'policy' | 'a11y' | 'check'

// Each kind of problem under its heading, in the order they show.
const KINDS: Record<ProblemKind, string> = {
  uncaught: 'Uncaught errors',
  kay: 'Recovered by kay',
  policy: 'Blocked by the policy',
  a11y: 'Accessibility',
  check: 'kay check',
}

const STYLE = `
:host { all: initial; --canvas: #f8fafc; --mantle: #e8edf4; --surface: #fff; --line: #e3e8ef; --sub: #566173; --text: #17202e; --accent: #1565a0; --accent-hi: #0f4c7a; --on-accent: #fff; --orange: #9c4a0a; --ok: #2f6b3a; --warn: #7a4f0f; --error: #a63227; --accent-soft: color-mix(in srgb, var(--accent) 11%, transparent); --ok-soft: color-mix(in srgb, var(--ok) 13%, transparent); --warn-soft: color-mix(in srgb, var(--warn) 14%, transparent); --error-soft: color-mix(in srgb, var(--error) 13%, transparent); --shadow: 0 10px 32px rgb(23 32 46 / 18%), 0 1px 3px rgb(23 32 46 / 10%); color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :host { --canvas: #17202e; --mantle: #121a26; --surface: #1c2737; --line: #23314a; --sub: #9ba6b5; --text: #eef2f7; --accent: #4cb3ea; --accent-hi: #8fd0f5; --on-accent: #17202e; --orange: #f0954a; --ok: #8fd19e; --warn: #e8b46a; --error: #f2968c; --shadow: 0 10px 32px rgb(0 0 0 / 50%), 0 1px 3px rgb(0 0 0 / 40%); color-scheme: dark; }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
button:focus-visible, a:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ui { font: 13px/1.45 system-ui, sans-serif; color: var(--text); text-align: left; }
.mono { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
svg.i { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.bar { position: fixed; bottom: calc(12px + var(--kay-panel-bottom, 0px)); left: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); box-shadow: var(--shadow); max-width: calc(100vw - 24px - var(--kay-panel-right, 0px)); }
.right .bar { left: auto; right: calc(12px + var(--kay-panel-right, 0px)); }
.bar > button { display: flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
.bar > button:hover { background: var(--mantle); }
.bar > button[aria-pressed=true], .bar > button[aria-expanded=true] { background: var(--accent-soft); }
.bar > button[aria-pressed=true] { color: var(--accent-hi); }
.mark { font-weight: 700; letter-spacing: .01em; padding-left: 5px !important; touch-action: none; }
.mark svg { width: 20px; height: 20px; flex: none; }
.pill { display: inline-flex; align-items: center; gap: 4px; padding: 0 7px; border-radius: 999px; font: 600 11px/18px system-ui, sans-serif; font-variant-numeric: tabular-nums; background: var(--mantle); color: var(--sub); white-space: nowrap; }
.pill.error { background: var(--error-soft); color: var(--error); }
.pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.accent { background: var(--accent-soft); color: var(--accent-hi); }
/* The rail is darker than the panels, so its tinted pills sit on the panel colour, which their text is measured on. */
.tabs .pill.error { background: linear-gradient(var(--error-soft), var(--error-soft)), var(--surface); }
.tabs .pill.warn { background: linear-gradient(var(--warn-soft), var(--warn-soft)), var(--surface); }
.pill svg.i { width: 12px; height: 12px; }
.bar .pill { font-size: 12px; }
.error { color: var(--error); }
.warn { color: var(--warn); }
.drawer { position: fixed; bottom: calc(56px + var(--kay-panel-bottom, 0px)); left: 12px; z-index: 2147483647; display: flex; flex-direction: column; width: min(36rem, calc(100vw - 24px - var(--kay-panel-right, 0px))); height: min(28rem, 60vh); border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); overflow: hidden; container: drawer / inline-size; }
.ui:not(.floating, .dock-bottom, .dock-right) .drawer { max-height: calc(100vh - 68px - var(--kay-panel-bottom, 0px)); }
.right .drawer { left: auto; right: calc(12px + var(--kay-panel-right, 0px)); }
.max .drawer { width: calc(100vw - 24px - var(--kay-panel-right, 0px)); height: calc(100vh - 68px - var(--kay-panel-bottom, 0px)); }
.top .bar { bottom: auto; top: 12px; }
.top .drawer { bottom: auto; top: 56px; }
.ui.dock-bottom .drawer { inset: auto 0 0; width: auto; height: var(--dock); border-width: 1px 0 0; border-radius: 0; }
.ui.dock-right .drawer { inset: 0 0 0 auto; width: min(var(--dock), 100vw); height: auto; border-width: 0 0 0 1px; border-radius: 0; }
.dock-bottom.open:not(.top) .bar { bottom: calc(var(--dock) + 12px + var(--kay-panel-bottom, 0px)); }
.dock-right.open.right .bar { right: calc(var(--dock) + 12px + var(--kay-panel-right, 0px)); }
.floating .head { cursor: move; touch-action: none; }
.grip { position: absolute; z-index: 1; touch-action: none; }
.grip.n, .grip.s { left: 8px; right: 8px; height: 5px; cursor: ns-resize; }
.grip.e, .grip.w { top: 8px; bottom: 8px; width: 5px; cursor: ew-resize; }
.grip.n, .grip.ne, .grip.nw { top: 0; }
.grip.s, .grip.se, .grip.sw { bottom: 0; }
.grip.e, .grip.ne, .grip.se { right: 0; }
.grip.w, .grip.nw, .grip.sw { left: 0; }
.grip.ne, .grip.nw, .grip.se, .grip.sw { width: 8px; height: 8px; }
.grip.ne, .grip.sw { cursor: nesw-resize; }
.grip.nw, .grip.se { cursor: nwse-resize; }
.grip:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.dock { display: flex; gap: 2px; padding-right: 6px; margin-right: 2px; border-right: 1px solid var(--line); }
.dock .icon[aria-pressed=true] { background: var(--accent-soft); color: var(--accent-hi); }
.head { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 10px; border-bottom: 1px solid var(--line); background: var(--mantle); }
.title { display: flex; align-items: center; gap: 8px; font-weight: 650; min-width: 0; white-space: nowrap; }
.title svg { width: 20px; height: 20px; flex: none; }
.where { flex: 1; min-width: 0; color: var(--sub); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; color: var(--sub); }
.icon:hover { background: var(--surface); color: var(--text); }
.body { display: flex; flex: 1; min-height: 0; }
.tabs { display: flex; flex-direction: column; gap: 1px; flex: none; width: 10.5rem; padding: 6px; border-right: 1px solid var(--line); background: var(--mantle); overflow-y: auto; }
.tabs button { display: grid; grid-template-columns: 16px 1fr auto; align-items: center; gap: 9px; padding: 5px 8px; border-radius: 7px; color: var(--sub); white-space: nowrap; }
.tabs button:hover { background: color-mix(in srgb, var(--surface) 60%, transparent); color: var(--text); }
.tabs button[aria-selected=true] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 0 0 1px var(--line); }
.tabs button[aria-selected=true] svg { color: var(--accent); }
.tabs .sep { flex: none; height: 1px; margin: 5px 4px; background: var(--line); }
@container drawer (max-width: 30rem) {
  .tabs { width: auto; }
  .tabs button { grid-template-columns: 16px; position: relative; padding: 7px; }
  .tabs .name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .tabs .pill { position: absolute; top: -1px; right: -3px; padding: 0 4px; font-size: 10px; line-height: 14px; }
  .tabs .sep { display: none; }
}
@container drawer (max-width: 24rem) {
  .title .words { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
.content { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.panel { flex: 1; min-width: 0; overflow: auto; padding: 12px 14px 16px; display: grid; align-content: start; gap: 16px; }
.panel > * { min-width: 0; }
.group { display: grid; gap: 8px; }
.group[data-filtered] { display: none; }
.heading { display: flex; align-items: center; gap: 8px; margin: 0; font: 650 11px/1.4 system-ui, sans-serif; letter-spacing: .07em; text-transform: uppercase; color: var(--sub); }
.grow { flex: 1; }
.actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tool { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--text); font-size: 12px; }
.tool:hover { border-color: var(--accent); color: var(--accent-hi); }
.tool:disabled { opacity: .6; cursor: default; }
.position { overflow-wrap: anywhere; color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent); text-underline-offset: 2px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.position:hover { text-decoration-color: currentColor; }
.position:disabled { color: inherit; text-decoration: none; cursor: text; }
.empty { color: var(--sub); padding: 6px 0; }
.note { color: var(--sub); }
.link { color: var(--accent); text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--accent) 45%, transparent); text-underline-offset: 2px; }
.link:hover { text-decoration-color: currentColor; }
.good { color: var(--ok); }
.value { white-space: pre-wrap; word-break: break-all; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 7px 16px; margin: 0; }
.facts dt { color: var(--sub); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; display: grid; gap: 3px; justify-items: start; }
.facts .meter { justify-self: stretch; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chip { font: 11.5px/18px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 6px; border-radius: 5px; border: 1px solid var(--line); color: var(--sub); max-width: 100%; overflow-wrap: anywhere; }
.row { padding: 8px 0; border-top: 1px solid var(--line); }
.row:first-child { border-top: 0; }
.problem { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 4px 10px; padding: 9px 8px 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--canvas); }
.problem > svg { margin-top: 2px; }
.problem.error, .problem.warn { color: var(--text); }
.problem.error > svg { color: var(--error); }
.problem.warn > svg { color: var(--warn); }
.problem pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.problem > .pill { grid-column: 2; justify-self: start; }
.problem .dismiss { grid-row: 1; grid-column: 3; width: 24px; height: 24px; margin: -3px -2px 0 0; }
.list { display: grid; gap: 8px; }
.reqline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--canvas); }
.reqline .path { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.method { font: 700 10.5px/18px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; padding: 0 6px; border-radius: 5px; background: var(--accent-soft); color: var(--accent-hi); }
.chain { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.chain li { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 4px 0; }
.chain .k { color: var(--sub); font-size: 12px; }
.chain .d { padding-left: calc(var(--depth, 0) * 14px); display: flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
.chain .d::before { content: ''; width: 8px; height: 8px; border: 1.5px solid var(--accent); border-radius: 2px; flex: none; }
.timing { display: grid; grid-template-columns: minmax(0, max-content) minmax(3rem, 1fr) 4.2rem; align-items: center; gap: 6px 12px; }
.bars { height: 8px; border-radius: 4px; background: var(--mantle); overflow: hidden; }
.bars i { display: block; height: 100%; border-radius: 4px; background: var(--accent); }
.bars.total i { background: var(--orange); }
.v { text-align: right; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; color: var(--sub); }
.headers, .kv { width: 100%; border-collapse: collapse; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.headers td, .kv td { padding: 4px 0; border-top: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
.headers td:first-child, .kv td:first-child { color: var(--sub); white-space: nowrap; padding-right: 14px; width: 1%; }
.headers .directive { display: block; }
.previews { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14rem, 100%), 1fr)); gap: 10px; }
.preview { display: grid; gap: 4px; align-content: start; padding: 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--canvas); min-width: 0; }
.preview .cap { font: 650 10.5px system-ui, sans-serif; letter-spacing: .07em; text-transform: uppercase; color: var(--sub); margin-bottom: 4px; }
.serp .site { font-size: 12px; color: var(--sub); overflow-wrap: anywhere; }
.serp .t { color: var(--accent); font-size: 16px; line-height: 1.3; overflow-wrap: anywhere; }
.serp .d { color: var(--sub); font-size: 12.5px; overflow-wrap: anywhere; }
.card { display: block; max-width: 100%; border: 1px solid var(--line); border-radius: 6px; }
.meter { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 10px; }
.meter .track { height: 5px; border-radius: 3px; background: var(--mantle); overflow: hidden; }
.meter .track i { display: block; height: 100%; border-radius: 3px; background: var(--ok); }
.meter.over .track i { background: var(--warn); }
.meter .n { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--sub); font-variant-numeric: tabular-nums; }
.meter.over .n { color: var(--warn); }
.json summary { cursor: pointer; font-size: 12.5px; }
.json pre, pre.json { margin: 6px 0 0; padding: 10px; border-radius: 8px; background: var(--canvas); border: 1px solid var(--line); white-space: pre-wrap; word-break: break-word; }
.entry { display: flex; gap: 12px; padding: 8px 6px; border-top: 1px solid var(--line); border-radius: 6px; }
.entry .body { flex: 1; min-width: 0; display: grid; gap: 4px; align-content: start; }
.entry .line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.entry .name { min-width: 0; overflow-wrap: anywhere; }
.entry a.name { color: var(--accent); text-decoration: none; }
.entry a.name:hover { text-decoration: underline; }
.entry .accname { min-width: 0; overflow-wrap: anywhere; font-weight: 600; }
.entry .accname.none { color: var(--error); font-weight: 400; font-style: italic; }
.entry .val { min-width: 0; overflow-wrap: anywhere; color: var(--sub); }
.entry .issue { display: flex; gap: 6px; align-items: flex-start; color: var(--warn); font-size: 12.5px; }
.entry .issue.error { color: var(--error); }
.entry .issue svg { flex: none; margin-top: 2px; width: 14px; height: 14px; }
.entry .note { font-size: 12px; }
.entry[aria-current] { background: var(--accent-soft); border-top-color: transparent; }
.entry[tabindex]:hover { background: var(--accent-soft); }
.entry:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.thumb { flex: none; width: 52px; height: 40px; border-radius: 6px; border: 1px solid var(--line); background: var(--mantle); object-fit: contain; }
.vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 10px; }
.vital { display: grid; gap: 6px; padding: 10px 12px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--canvas); align-content: start; }
.vital .top { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.vital .name { font: 650 11px system-ui, sans-serif; letter-spacing: .07em; color: var(--sub); }
.vital .num { font: 600 20px/1.1 system-ui, sans-serif; font-variant-numeric: tabular-nums; }
.vital .num small { font-size: 12px; color: var(--sub); font-weight: 500; margin-left: 2px; }
.scalebox { position: relative; padding-bottom: 14px; margin-top: 4px; }
.scale { display: flex; height: 6px; border-radius: 3px; overflow: hidden; }
.scale i { height: 100%; }
.scale .g { background: color-mix(in srgb, var(--ok) 55%, transparent); }
.scale .n { background: color-mix(in srgb, var(--warn) 55%, transparent); }
.scale .p { background: color-mix(in srgb, var(--error) 55%, transparent); }
.scalebox .mk { position: absolute; top: -1px; width: 3px; height: 8px; margin-left: -1.5px; border-radius: 2px; background: var(--text); box-shadow: 0 0 0 2px var(--canvas); }
.scalebox .tick { position: absolute; bottom: 0; transform: translateX(-50%); font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--sub); }
.vital .note { font-size: 12px; }
.weight { display: grid; grid-template-columns: minmax(0, max-content) minmax(3rem, 1fr) 4.4rem; align-items: center; gap: 6px 12px; }
.weight .files { grid-column: 2 / -1; margin-top: -3px; font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--sub); overflow-wrap: anywhere; }
.weight .total { font-weight: 650; }
.weight .rule { grid-column: 1 / -1; height: 1px; background: var(--line); }
.build { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; padding: 8px 12px; border-radius: 9px; background: var(--accent-soft); font-size: 12.5px; }
.build b { font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.copy { flex: none; display: inline-grid; place-items: center; width: 22px; height: 22px; margin: -2px 0; border-radius: 5px; color: var(--sub); vertical-align: middle; }
.copy:hover { background: var(--mantle); color: var(--text); }
.copy svg { width: 13px; height: 13px; }
td .copy { margin-left: 4px; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.toolbar .search { flex: 1; min-width: min(12rem, 100%); }
.tool[aria-pressed=true] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-hi); }
.stack { display: grid; gap: 16px; align-content: start; min-width: 0; }
.stack > * { min-width: 0; }
.search { position: relative; display: flex; align-items: center; }
.search svg { position: absolute; left: 9px; color: var(--sub); width: 14px; height: 14px; }
.search input { width: 100%; padding: 6px 10px 6px 30px; border: 1px solid var(--line); border-radius: 8px; background: var(--canvas); color: var(--text); font: 13px system-ui, sans-serif; }
.locales { display: flex; flex-wrap: wrap; gap: 6px; }
.locale-chip { font: 12px/24px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--accent); text-decoration: none; }
.locale-chip[aria-current] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.missing { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.missing li { display: flex; align-items: center; gap: 8px; color: var(--error); }
.island { display: grid; gap: 8px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--canvas); }
.island .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.island .name { font: 600 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); }
.grid { width: max-content; min-width: 100%; border-collapse: collapse; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.grid th { position: sticky; top: 0; text-align: left; padding: 3px 12px 3px 0; color: var(--sub); font-weight: 600; background: var(--mantle); white-space: nowrap; }
.grid td { padding: 3px 12px 3px 0; border-top: 1px solid var(--line); vertical-align: top; max-width: 28rem; overflow-wrap: anywhere; white-space: pre-wrap; }
.grid .null { color: var(--sub); font-style: italic; }
.scroll { overflow: auto; max-height: 24rem; }
textarea.query { width: 100%; min-height: 4.5rem; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--canvas); color: var(--text); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; resize: vertical; }
.signals { width: 100%; border-collapse: collapse; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.signals td { padding: 3px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.signals td:first-child { color: var(--sub); width: 2.5rem; }
.signals td:last-child { color: var(--sub); text-align: right; padding-left: 10px; }
.outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--accent); border-radius: 3px; background: var(--accent-soft); }
.tab-order { position: fixed; inset: 0; z-index: 2147483645; pointer-events: none; }
.tab-order svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.tab-order path { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linecap: round; stroke-opacity: .7; }
.tab-order path.jump { stroke: var(--error); stroke-dasharray: 6 4; stroke-opacity: 1; }
.tab-badge { position: absolute; min-width: 20px; padding: 1px 5px; border-radius: 10px; background: var(--accent); color: var(--on-accent); font: 700 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; white-space: nowrap; box-shadow: 0 0 0 2px var(--surface); }
.tab-badge.jump { background: var(--error); }
.tab-badge.hidden-focus { background: var(--warn); color: var(--surface); }
.tab-trap { position: absolute; border: 2px dashed var(--error); border-radius: 3px; background: var(--error-soft); }
.label { position: fixed; z-index: 2147483647; pointer-events: none; padding: 2px 7px; border-radius: 5px; background: var(--accent); color: var(--on-accent); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) {
  .tabs button, .bar > button, .icon { transition: background-color .12s, color .12s; }
}
@media (max-width: 480px) {
  .drawer, .max .drawer { left: 8px; right: 8px; width: auto; }
  .right .drawer { left: 8px; right: calc(8px + var(--kay-panel-right, 0px)); width: auto; }
  .max .drawer { height: calc(100vh - 68px - var(--kay-panel-bottom, 0px)); }
}
`

const SVG = 'http://www.w3.org/2000/svg'

// Icons of Lucide 0.469.0 (https://lucide.dev), under the ISC licence: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT), all other copyright (c) for Lucide are held by Lucide Contributors 2022.
// Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// The portions of Lucide that come from Feather are under the MIT licence: Copyright (c) 2013-2022 Cole Bemis. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
// Each is a 24 by 24 drawing as its nodes, `tag~attribute~value~...` joined by `|`.
const ICONS = {
  'circle-x': 'circle~cx~12~cy~12~r~10|path~d~m15 9-6 6|path~d~m9 9 6 6',
  'triangle-alert': 'path~d~m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3|path~d~M12 9v4|path~d~M12 17h.01',
  'database': 'ellipse~cx~12~cy~5~rx~9~ry~3|path~d~M3 5V19A9 3 0 0 0 21 19V5|path~d~M3 12A9 3 0 0 0 21 12',
  'list-checks': 'path~d~m3 17 2 2 4-4|path~d~m3 7 2 2 4-4|path~d~M13 6h8|path~d~M13 12h8|path~d~M13 18h8',
  'server': 'rect~width~20~height~8~x~2~y~2~rx~2~ry~2|rect~width~20~height~8~x~2~y~14~rx~2~ry~2|line~x1~6~x2~6.01~y1~6~y2~6|line~x1~6~x2~6.01~y1~18~y2~18',
  'list-ordered': 'path~d~M10 12h11|path~d~M10 18h11|path~d~M10 6h11|path~d~M4 10h2|path~d~M4 6h1v4|path~d~M6 18H4c0-1 2-2 2-3s-1-1.5-2-1',
  'scan-search': 'path~d~M3 7V5a2 2 0 0 1 2-2h2|path~d~M17 3h2a2 2 0 0 1 2 2v2|path~d~M21 17v2a2 2 0 0 1-2 2h-2|path~d~M7 21H5a2 2 0 0 1-2-2v-2|circle~cx~12~cy~12~r~3|path~d~m16 16-1.9-1.9',
  'key-round': 'path~d~M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z|circle~cx~16.5~cy~7.5~r~.5~fill~currentColor',
  'image': 'rect~width~18~height~18~x~3~y~3~rx~2~ry~2|circle~cx~9~cy~9~r~2|path~d~m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
  'gauge': 'path~d~m12 14 4-4|path~d~M3.34 19a10 10 0 1 1 17.32 0',
  'route': 'circle~cx~6~cy~19~r~3|path~d~M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15|circle~cx~18~cy~5~r~3',
  'languages': 'path~d~m5 8 6 6|path~d~m4 14 6-6 2-3|path~d~M2 5h12|path~d~M7 2h1|path~d~m22 22-5-10-5 10|path~d~M14 18h6',
  'boxes': 'path~d~M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z|path~d~m7 16.5-4.74-2.85|path~d~m7 16.5 5-3|path~d~M7 16.5v5.17|path~d~M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z|path~d~m17 16.5-5-3|path~d~m17 16.5 4.74-2.85|path~d~M17 16.5v5.17|path~d~M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z|path~d~M12 8 7.26 5.15|path~d~m12 8 4.74-2.85|path~d~M12 13.5V8',
  'mail': 'rect~width~20~height~16~x~2~y~4~rx~2|path~d~m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7',
  'network': 'rect~x~16~y~16~width~6~height~6~rx~1|rect~x~2~y~16~width~6~height~6~rx~1|rect~x~9~y~2~width~6~height~6~rx~1|path~d~M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3|path~d~M12 12V8',
  'crosshair': 'circle~cx~12~cy~12~r~10|line~x1~22~x2~18~y1~12~y2~12|line~x1~6~x2~2~y1~12~y2~12|line~x1~12~x2~12~y1~6~y2~2|line~x1~12~x2~12~y1~22~y2~18',
  'maximize-2': 'polyline~points~15 3 21 3 21 9|polyline~points~9 21 3 21 3 15|line~x1~21~x2~14~y1~3~y2~10|line~x1~3~x2~10~y1~21~y2~14',
  'minimize-2': 'polyline~points~4 14 10 14 10 20|polyline~points~20 10 14 10 14 4|line~x1~14~x2~21~y1~10~y2~3|line~x1~3~x2~10~y1~21~y2~14',
  'panel-right': 'rect~width~18~height~18~x~3~y~3~rx~2|path~d~M15 3v18',
  'panel-left': 'rect~width~18~height~18~x~3~y~3~rx~2|path~d~M9 3v18',
  'panel-bottom': 'rect~width~18~height~18~x~3~y~3~rx~2|path~d~M3 15h18',
  'app-window': 'rect~x~2~y~4~width~20~height~16~rx~2|path~d~M10 4v4|path~d~M2 8h20|path~d~M6 4v4',
  'x': 'path~d~M18 6 6 18|path~d~m6 6 12 12',
  'copy': 'rect~width~14~height~14~x~8~y~8~rx~2~ry~2|path~d~M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  'check': 'path~d~M20 6 9 17l-5-5',
  'clipboard-copy': 'rect~width~8~height~4~x~8~y~2~rx~1~ry~1|path~d~M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2|path~d~M16 4h2a2 2 0 0 1 2 2v4|path~d~M21 14H11|path~d~m15 10-4 4 4 4',
  'lock': 'rect~width~18~height~11~x~3~y~11~rx~2~ry~2|path~d~M7 11V7a5 5 0 0 1 10 0v4',
  'search': 'circle~cx~11~cy~11~r~8|path~d~m21 21-4.3-4.3',
  'user-round': 'circle~cx~12~cy~8~r~5|path~d~M20 21a8 8 0 0 0-16 0',
  'pencil': 'path~d~M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z|path~d~m15 5 4 4',
  'ear': 'path~d~M6 8.5a6.5 6.5 0 1 1 13 0c0 6-6 6-6 10a3.5 3.5 0 1 1-7 0|path~d~M15 8.5a2.5 2.5 0 0 0-5 0v1a2 2 0 1 1 0 4',
  'palette': 'circle~cx~13.5~cy~6.5~r~.5~fill~currentColor|circle~cx~17.5~cy~10.5~r~.5~fill~currentColor|circle~cx~8.5~cy~7.5~r~.5~fill~currentColor|circle~cx~6.5~cy~12.5~r~.5~fill~currentColor|path~d~M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z',
  'puzzle': 'path~d~M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z',
} as const

// The kay mark, the kingfisher without the favicon's tile, on the 54 by 52 box its drawing fills; its beak and eye take the colour of the text around it.
const MARK = 'path~fill~#1f8fd1~d~M21.5 16A9 9 0 0 1 38.5 16L46.1 25.2L55.3 50.2L48.7 47.4L48.7 54.6L29.4 36.2L24 25.7A9 9 0 0 1 22 22.5Z|path~fill~#1670a8~d~M39.8 22.1L46.1 25.2L55.3 50.2L48.7 47.4L40.5 31.3Z|path~fill~#ef7d2a~d~M22 22.5A9 9 0 0 0 24 25.7L29.4 36.2L48.7 54.6L48.7 47.4L36.3 34L29.1 26.8ZM20 18.4L35.5 19.5L20.5 21.2Z|path~fill~currentColor~d~M21.5 16L17.7 19.5L6.7 26.9L18.8 22.7L22 22.5L25.2 19.4Z|circle~cx~36.5~cy~21.5~r~1.6~fill~#eef2f7|circle~cx~27~cy~16~r~1.5~fill~currentColor'

// The name of an icon a tab or a button can wear.
export type DevIconName = keyof typeof ICONS
// What a tab without an icon wears.
const DEFAULT_ICON: DevIconName = 'puzzle'

// A drawing from its nodes, hidden from screen readers: the control it sits in is named.
function drawing(doc: Document, nodes: string, viewBox: string, className: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg')

  svg.setAttribute('viewBox', viewBox)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)

  for (const node of nodes.split('|')) {
    const [tag, ...attributes] = node.split('~')
    const element = doc.createElementNS(SVG, tag!)

    for (let index = 0; index < attributes.length; index += 2)
      element.setAttribute(attributes[index]!, attributes[index + 1]!)

    svg.append(element)
  }

  return svg
}

function iconOf(doc: Document, name: string): SVGSVGElement {
  return drawing(doc, ICONS[name as DevIconName] ?? ICONS[DEFAULT_ICON], '0 0 24 24', 'i')
}

// An icon button: the drawing with its name for screen readers and as the native tooltip.
function setIcon(button: HTMLButtonElement, label: string, name: DevIconName): void {
  button.replaceChildren(iconOf(button.ownerDocument, name))
  button.title = label
  button.setAttribute('aria-label', label)
}

// The icon a count's tone puts in the bar's badge.
const TONE_ICONS = { error: 'circle-x', warn: 'triangle-alert' } as const satisfies Record<'error' | 'warn', DevIconName>

// A guard that did not run is no failure, so it has no tone.
function guardTone(outcome: string): 'ok' | 'error' | undefined {
  if (outcome === 'did not run')
    return undefined

  return outcome === 'passed' ? 'ok' : 'error'
}

// The tabs kay makes itself; those a library adds sit under a line.
const CORE_TABS = new Set(['problems', 'request', 'network', 'head', 'screen-reader', 'env', 'images', 'performance', 'routes', 'i18n', 'islands', 'not-found', 'data', 'jobs', 'styles'])

// A small rounded label, tinted by what it counts or says, with an icon before it when given.
function pill(tool: Pick<DevTool, 'make' | 'icon'>, text: string, tone?: 'error' | 'warn' | 'ok' | 'accent', icon?: DevIconName): HTMLElement {
  const element = tool.make('span', tone === undefined ? 'pill' : `pill ${tone}`)

  if (icon !== undefined)
    element.append(tool.icon(icon))

  element.append(text)

  return element
}

export interface EntryParts {
  // Before the rest, as an image's thumbnail.
  lead?: HTMLElement | undefined
  name: HTMLElement | string
  // What follows the name on its line: pills, a value, a copy button.
  after?: Node[] | undefined
  // Short facts, a string drawn as a chip.
  chips?: (HTMLElement | string)[] | undefined
  // What is wrong, one line each.
  issues?: { text: string, tone: 'error' | 'warn', icon?: DevIconName }[] | undefined
  note?: string | undefined
}

// A row of a list tab, the same in each: its name and what follows it on one line, short facts as chips, what is wrong one line each, then a muted note.
function entry(tool: DevTool, kind: string, parts: EntryParts): HTMLElement {
  const row = tool.make('div', `entry ${kind}`)
  const body = tool.make('div', 'body')
  const line = tool.make('div', 'line')

  line.append(typeof parts.name === 'string' ? tool.make('span', 'name', parts.name) : parts.name, ...parts.after ?? [])
  body.append(line)

  if (parts.chips !== undefined && parts.chips.length > 0) {
    const chips = tool.make('div', 'chips')

    chips.append(...parts.chips.map(chip => typeof chip === 'string' ? tool.make('span', 'chip', chip) : chip))
    body.append(chips)
  }

  for (const issue of parts.issues ?? []) {
    const element = tool.make('div', `issue ${issue.tone}`)

    element.append(tool.icon(issue.icon ?? TONE_ICONS[issue.tone]), tool.make('span', '', issue.text))
    body.append(element)
  }

  if (parts.note !== undefined)
    body.append(tool.make('div', 'note', parts.note))

  if (parts.lead !== undefined)
    row.append(parts.lead)

  row.append(body)

  return row
}

export interface Toolbar {
  element: HTMLElement
  input: HTMLInputElement
  // Shown when the filter hides every row.
  empty: HTMLElement
  // Hides what the filter or the toggle leave out under `within`, and a group left with no row.
  apply: (within: Element) => void
}

// What a filter matches on a row, and whether the "Problems only" toggle keeps it.
function filterable<T extends HTMLElement>(element: T, text: string, problem = false): T {
  element.dataset.filter = text.toLowerCase()

  if (problem)
    element.dataset.problem = ''

  return element
}

// An icon button copying `text`, saying for a moment whether it could.
function copyButton(tool: DevTool, what: string, text: string): HTMLButtonElement {
  const button = tool.make('button', 'copy')
  const label = `Copy ${what}`

  button.type = 'button'
  setIcon(button, label, 'copy')
  button.onclick = async () => copied(button, text, label, 'copy')

  return button
}

// Copies `text` from an icon button, its icon and name saying for a moment whether it worked, without a dialog.
async function copied(button: HTMLButtonElement, text: string, label: string, icon: DevIconName): Promise<void> {
  const worked = await toClipboard(button, text)

  setIcon(button, worked ? 'Copied' : 'Copy failed', worked ? 'check' : 'x')
  announce(button, worked ? 'Copied' : 'Copy failed')
  clearTimeout(copyResets.get(button))
  copyResets.set(button, setTimeout(setIcon, COPIED_MS, button, label, icon))
}

// Says a copy's outcome to a screen reader, which a button's changed name alone does not: the drawer's live region takes it, and empties again for the next copy to be heard.
function announce(button: HTMLElement, text: string): void {
  const region = (button.getRootNode() as ParentNode).querySelector('.copies')

  if (region === null)
    return

  region.textContent = ''
  setTimeout(() => {
    region.textContent = text
  }, 0)
}

// A tab's filter box, and a "Problems only" toggle when `problems` is given, its help text naming what it matches; it applies to the rows marked by `filterable` under the element passed to `apply`, run again on each keystroke and press.
function toolbar(tool: DevTool, help: string, rerun: () => void, problems = false): Toolbar {
  const element = tool.make('div', 'toolbar')
  const search = tool.make('label', 'search')
  const input = tool.make('input', 'filter')
  const toggle = tool.make('button', 'tool', 'Problems only')
  const empty = tool.make('div', 'empty', 'Nothing matches the filter.')

  input.type = 'search'
  input.placeholder = help
  input.setAttribute('aria-label', help)
  input.oninput = rerun
  search.append(tool.icon('search'), input)
  element.append(search)
  empty.hidden = true
  empty.setAttribute('aria-live', 'polite')

  if (problems) {
    toggle.type = 'button'
    toggle.setAttribute('aria-pressed', 'false')
    toggle.onclick = () => {
      toggle.setAttribute('aria-pressed', String(toggle.getAttribute('aria-pressed') !== 'true'))
      rerun()
    }
    element.append(toggle)
  }

  return {
    element,
    input,
    empty,
    apply: (within) => {
      const typed = input.value.trim().toLowerCase()
      const only = toggle.getAttribute('aria-pressed') === 'true'
      const rows = [...within.querySelectorAll<HTMLElement>('[data-filter]')]

      for (const row of rows)
        row.hidden = !row.dataset.filter!.includes(typed) || (only && row.dataset.problem === undefined)

      for (const section of within.querySelectorAll<HTMLElement>('[data-plain]'))
        section.hidden = only

      // A group with no row to match, such as a timing chart, goes while a filter is on; marked rather than hidden, as its tab may hide it for its own reasons.
      for (const group of within.querySelectorAll<HTMLElement>('.group')) {
        const own = [...group.querySelectorAll<HTMLElement>('[data-filter]')]

        if (own.length > 0) {
          group.hidden = own.every(row => row.hidden === true)

          // The heading's count follows the rows shown, and goes back to the whole when nothing filters.
          for (const count of group.querySelectorAll<HTMLElement>(':scope > .heading > .pill')) {
            count.dataset.total ??= count.textContent
            count.textContent = typed === '' && !only ? count.dataset.total : String(own.filter(row => row.hidden === false).length)
          }
        }
        else {
          group.toggleAttribute('data-filtered', typed !== '' || only)
        }
      }

      empty.textContent = only && typed === '' ? 'No problems.' : 'Nothing matches the filter.'
      empty.hidden = rows.length === 0 || rows.some(row => row.hidden === false)
    },
  }
}

interface DevState {
  open: boolean
  tab: string
  dismissed: string[]
}

type Dock = 'float' | 'bottom' | 'right'
type Corner = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'

interface Room {
  width: number
  height: number
}

interface Box {
  left: number
  top: number
  width: number
  height: number
}

// Where the tool sits and how large, kept for the browser rather than the tab.
interface DevLayout {
  dock: Dock
  // The corner of the bar, which a drawer left where it opens follows.
  corner: Corner
  // The floating drawer fills the window.
  max: boolean
  // The floating drawer once moved or resized, else where its corner puts it.
  box?: Box | undefined
  // The docked drawer's height at the bottom and width at the right.
  bottom: number
  right: number
}

const SHOW_TAB_ORDER = 'Show the tab order'
const DOCKS = [['float', 'Float', 'app-window'], ['bottom', 'Dock to the bottom', 'panel-bottom'], ['right', 'Dock to the right', 'panel-right']] as const
const CORNERS = new Set<string>(['bottom-left', 'bottom-right', 'top-left', 'top-right'])
// The edges and corners that resize the drawer.
const GRIPS = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as const
// The grip the keyboard reaches for each dock: the corner of a floating drawer, the inner edge of a docked one.
const KEY_GRIPS: Record<Dock, string> = { float: 'se', bottom: 'n', right: 'w' }
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
const MIN_WIDTH = 280
const MIN_HEIGHT = 180
// What a docked drawer leaves of the page.
const PAGE_LEFT = 80
// How near an edge a moved drawer snaps to it, and how far from it it lands.
const SNAP = 24
const MARGIN = 12
// The bar's height where nothing is laid out to measure, which its room at the bottom edge is then taken from.
const BAR_HEIGHT = 36
// How far the bar's mark moves before a press becomes a drag.
const DRAG_START = 5
const KEY_STEP = 16
// Below this window width the floating drawer spans it, wherever it was left.
const NARROW = 480
const COPY_TAB = 'Copy this tab as Markdown'

export interface DevTabOptions {
  id: string
  label: string
  // The tab's icon, by name from kay's set; a puzzle piece without one.
  icon?: DevIconName
  // What the bar says for a count above zero, as `3 islands`; without it the count shows in the tab only.
  summary?: (count: number) => string
  // Says the bar's text politely to a screen reader as it changes.
  announce?: boolean
  // Called as the tab shows and hides, so it works only while shown.
  shown?: () => void
  hidden?: () => void
}

export interface DevTab {
  panel: HTMLElement
  // The count beside the tab's name and on the bar, `error` or `warn` coloring both; `note` is what the bar says instead of `summary`'s, and shows even at zero.
  count: (count: number, tone?: 'error' | 'warn', note?: string) => void
}

export interface DevKit {
  // Aborted when the tool stops.
  signal: AbortSignal
  entry: (kind: string, parts: EntryParts) => HTMLElement
  toolbar: (help: string, rerun: () => void, problems?: boolean) => Toolbar
  filterable: typeof filterable
  pill: (text: string, tone?: 'error' | 'warn' | 'ok' | 'accent') => HTMLElement
  copyButton: (what: string, text: string) => HTMLButtonElement
  positionButton: (source: string) => HTMLButtonElement
  ownFetch: typeof ownFetch
  withPositions: (text: string) => Node[]
  missing: MissingMessages
  vitals: Vitals
  formatBytes: typeof formatBytes
  fetchKind: typeof fetchKind
  formatMs: typeof formatMs
  // The addresses the tool fetched itself, which the Network tab leaves out.
  ownFetches: ReadonlySet<string>
  // The page swaps from the tool's start, for a tab whose module arrives later to replay.
  swaps: { path: string, log: { busy: boolean, at: number, path: string }[] }
  parseUrl: typeof parseUrl
  walkComposed: typeof walkComposed
}

export interface DevTool {
  root: ShadowRoot
  make: <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => HTMLElementTagNameMap[K]
  tab: (options: DevTabOptions) => DevTab
  // A button of its own on the bar, with an icon by name from kay's set before its text.
  button: (text: string, label: string, icon?: DevIconName) => HTMLButtonElement
  icon: (name: DevIconName) => SVGSVGElement
  // The helpers every list tab shares, for a tab whose code is a module of its own, which the browser loads as it is and so imports nothing from here.
  kit: DevKit
  // Outlines elements of the page, `text` beside the first, until `hideOutline`.
  outline: (targets: Element[], text: string) => void
  hideOutline: () => void
  // Opens `file:line:column` in the editor, giving back why it could not; only once `setOpener` said how, as the inspector does under `kay dev`.
  open: (source: string) => Promise<string | undefined>
  opens: () => boolean
  setOpener: (open: (source: string) => Promise<string | undefined>) => void
  stop: () => void
}

// A module a library's extension names in `devTool`, by the extension's name and where kay serves it.
export interface DevToolModule {
  name: string
  url: string
}

// Calls the default export of each module with the tool, one after another so the tabs keep their order; a module that fails to load, throws or exports no function is logged as a kay problem, naming its extension, and the others still load.
export async function loadDevModules(tool: DevTool, modules: DevToolModule[], load: (url: string) => Promise<unknown> = async url => import(url), log: (message: string) => void = message => console.error(message)): Promise<void> {
  for (const { name, url } of modules) {
    let loaded: { default?: unknown }

    try {
      loaded = await load(url) as { default?: unknown }
    }
    catch (error) {
      log(`[kay] the dev tool module of ${name} failed to load: ${error instanceof Error ? error.message : String(error)}`)

      continue
    }

    if (typeof loaded.default !== 'function') {
      log(`[kay] the dev tool module of ${name} exports no default function`)

      continue
    }

    try {
      await (loaded.default as (tool: DevTool) => unknown)(tool)
    }
    catch (error) {
      log(`[kay] the dev tool module of ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

const importTab: LoadTab = async url => await import(url) as { default: DevTabModule }

export function startDevTool(doc: Document = document, load: LoadTab = importTab): DevTool {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const state = readState(win)
  const layout = readLayout(win)
  const host = doc.createElement(HOST)
  const root = host.attachShadow({ mode: 'open' })
  const sheet = new CSSStyleSheet()
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag)

    element.className = className
    element.textContent = text

    return element
  }
  const ui = make('div', 'ui')
  const bar = make('div', 'bar')
  const mark = make('button', 'mark')
  const drawer = make('div', 'drawer')
  const head = make('div', 'head')
  const title = make('span', 'title')
  const where = make('span', 'where')
  const body = make('div', 'body')
  const tabList = make('div', 'tabs')
  const rule = make('span', 'sep')
  const content = make('div', 'content')
  const dock = make('div', 'dock')
  const docks = DOCKS.map(([value, label, icon]) => {
    const button = make('button', 'icon')

    button.type = 'button'
    setIcon(button, label, icon)
    dock.append(button)

    return { value, button }
  })
  const size = make('button', 'icon size')
  const copyTab = make('button', 'icon')
  const order = make('button', 'icon')
  const close = make('button', 'icon')
  const grips = GRIPS.map((edge) => {
    const grip = make('div', `grip ${edge}`)

    grip.dataset.edge = edge

    return grip
  })
  const status = make('span', 'sr')
  const copies = make('div', 'sr copies')
  const tabs: { options: DevTabOptions, button: HTMLButtonElement, panel: HTMLElement, badge: HTMLButtonElement }[] = []
  // A docked drawer pads the page by its size, so none of the page hides under it, and publishes it as `--kay-dev-inset-<edge>` for a panel of the page to sit beside it, with the room the bar takes at a bottom corner as `--kay-dev-bar-bottom-<side>`. The bar and a floating drawer keep out of what a panel of the page holds, which it publishes as `--kay-panel-right` or `-bottom`.
  const pageSheet = new CSSStyleSheet()
  const save = () => writeState(win, state)
  const saveLayout = () => writeLayout(win, layout)

  sheet.replaceSync(STYLE)
  root.adoptedStyleSheets = [sheet]
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, pageSheet]
  dock.setAttribute('role', 'group')
  dock.setAttribute('aria-label', 'Dock')
  drawer.id = 'kay-dev-drawer'
  drawer.setAttribute('role', 'dialog')
  drawer.setAttribute('aria-label', 'kay dev tools')
  tabList.setAttribute('role', 'tablist')
  tabList.setAttribute('aria-orientation', 'vertical')
  rule.hidden = true
  rule.setAttribute('aria-hidden', 'true')
  tabList.append(rule)
  mark.type = 'button'
  mark.setAttribute('aria-label', 'kay dev tools (Alt+Shift+K)')
  mark.setAttribute('aria-controls', drawer.id)
  mark.append(drawing(doc, MARK, '4 5 54 52', ''), 'kay')
  title.append(drawing(doc, MARK, '4 5 54 52', ''), make('span', 'words', 'kay dev tools'))
  status.setAttribute('role', 'status')
  copies.setAttribute('role', 'status')
  size.type = 'button'
  close.type = 'button'
  setIcon(close, 'Close', 'x')
  setIcon(copyTab, COPY_TAB, 'clipboard-copy')
  copyTab.type = 'button'
  setIcon(order, SHOW_TAB_ORDER, 'list-ordered')
  order.type = 'button'
  order.setAttribute('aria-pressed', 'false')
  head.append(title, where, copyTab, order, dock, size, close)
  body.append(tabList, content)
  drawer.append(head, body, ...grips)
  bar.append(mark, status)
  ui.append(drawer, bar, copies)
  root.append(ui)
  host.setAttribute('data-kay-dev', '')
  doc.documentElement.append(host)

  // The page the tools describe, which a page swap changes without a load.
  const showWhere = () => {
    where.textContent = `${win.location.pathname}${win.location.search}`
  }
  // The window less its scrollbars, which a fixed element's edges stop at.
  const room = (): Room => ({ width: doc.documentElement.clientWidth || win.innerWidth, height: doc.documentElement.clientHeight || win.innerHeight })
  // A narrow window spans the drawer whatever the layout says.
  const dockOf = (): Dock => win.innerWidth > NARROW ? layout.dock : 'float'
  const dockSize = (value: number) => dockOf() === 'bottom' ? clamp(value, MIN_HEIGHT, room().height - PAGE_LEFT) : clamp(value, MIN_WIDTH, room().width - PAGE_LEFT)
  // Lays the bar and drawer out as the layout says, within the window as it is now.
  let padding = ''
  let maxed: boolean | undefined
  const place = () => {
    const current = dockOf()
    const floating = current === 'float'
    const docked = floating ? 0 : dockSize(current === 'bottom' ? layout.bottom : layout.right)
    // A floating drawer the pointer can move and resize, which a narrow window spans instead.
    const free = floating && !layout.max && win.innerWidth > NARROW
    const box = free && layout.box !== undefined ? fitBox(layout.box, room()) : undefined
    const keyGrip = KEY_GRIPS[current]
    // What the bar takes of a bottom corner, its margin and measured height, published as `--kay-dev-bar-bottom-<side>` for the page's own fixed elements at that corner to keep clear of it; nothing is published for a top corner, nor for a corner the bar is not in.
    const corner = layout.corner.startsWith('bottom') ? ` --kay-dev-bar-${layout.corner}: ${MARGIN + (bar.getBoundingClientRect().height || BAR_HEIGHT)}px;` : ''
    const sheet = `html {${corner}${state.open && !floating ? ` padding-${current}: ${docked}px !important; --kay-dev-inset-${current}: ${docked}px;` : ''} }`

    ui.classList.toggle('right', layout.corner.endsWith('right'))
    ui.classList.toggle('top', layout.corner.startsWith('top'))
    ui.classList.toggle('floating', free)
    ui.classList.toggle('max', floating && layout.max)
    ui.classList.toggle('dock-bottom', current === 'bottom')
    ui.classList.toggle('dock-right', current === 'right')
    ui.classList.toggle('open', state.open)
    ui.style.setProperty('--dock', `${docked}px`)
    drawer.style.left = box === undefined ? '' : `${box.left}px`
    drawer.style.top = box === undefined ? '' : `${box.top}px`
    drawer.style.width = box === undefined ? '' : `${box.width}px`
    drawer.style.height = box === undefined ? '' : `${box.height}px`
    drawer.style.right = drawer.style.bottom = box === undefined ? '' : 'auto'
    size.hidden = !floating

    if (sheet !== padding) {
      padding = sheet
      pageSheet.replaceSync(sheet)
    }

    if (layout.max !== maxed) {
      maxed = layout.max
      setIcon(size, layout.max ? 'Restore the size' : 'Fill the window', layout.max ? 'minimize-2' : 'maximize-2')
    }

    for (const { value, button } of docks)
      button.setAttribute('aria-pressed', String(layout.dock === value))

    for (const grip of grips) {
      const edge = grip.dataset.edge!
      const reached = edge === keyGrip

      grip.hidden = floating ? !free : !reached
      grip.tabIndex = reached ? 0 : -1

      if (reached) {
        grip.setAttribute('role', 'separator')
        grip.setAttribute('aria-label', 'Resize the dev tools, arrow keys')
        grip.setAttribute('aria-orientation', edge === 'n' ? 'horizontal' : 'vertical')
        // The height for the top edge, else the width, which the corner's left and right arrows change.
        grip.setAttribute('aria-valuemin', String(edge === 'n' ? MIN_HEIGHT : MIN_WIDTH))
        grip.setAttribute('aria-valuemax', String(edge === 'n' ? room().height : room().width))
        grip.setAttribute('aria-valuenow', String(Math.round(edge === 'n' ? drawer.offsetHeight : drawer.offsetWidth)))
      }
      else {
        for (const name of ['role', 'aria-label', 'aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow'])
          grip.removeAttribute(name)
      }
    }
  }
  const render = () => {
    const current = tabs.find(tab => tab.options.id === state.tab) ?? tabs[0]

    drawer.hidden = !state.open
    mark.setAttribute('aria-expanded', String(state.open))
    place()
    showWhere()

    for (const tab of tabs) {
      const selected = tab === current

      tab.button.setAttribute('aria-selected', String(selected))
      tab.button.tabIndex = selected ? 0 : -1
      tab.badge.setAttribute('aria-expanded', String(selected && state.open))

      if (tab.panel.hidden !== (selected && state.open))
        continue

      tab.panel.hidden = !(selected && state.open)

      if (tab.panel.hidden)
        tab.options.hidden?.()
      else
        tab.options.shown?.()
    }
  }
  const openTab = (id: string | undefined, focus = false) => {
    state.open = true
    state.tab = id ?? state.tab
    save()
    render()

    if (focus)
      (tabs.find(tab => tab.options.id === state.tab) ?? tabs[0])?.button.focus()
  }

  copyTab.onclick = async () => {
    const current = tabs.find(tab => tab.options.id === state.tab) ?? tabs[0]

    if (current !== undefined)
      await copied(copyTab, panelMarkdown(current.panel, `${current.options.label}, ${win.location.href}`), COPY_TAB, 'clipboard-copy')
  }
  const closeDrawer = (focus = false) => {
    state.open = false
    save()
    render()

    if (focus)
      mark.focus()
  }

  const tab = (options: DevTabOptions): DevTab => {
    const button = make('button')
    const count = make('span', 'count pill')
    const panel = make('div', 'panel')
    const badge = make('button')
    const entry = { options, button, panel, badge }
    const library = !CORE_TABS.has(options.id)
    // The tabs of kay come first, then a line, then those of libraries, each in the order they were made.
    const firstLibrary = tabs.findIndex(other => !CORE_TABS.has(other.options.id))
    const at = library || firstLibrary < 0 ? tabs.length : firstLibrary

    button.type = 'button'
    button.id = `kay-dev-tab-${options.id}`
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-controls', `kay-dev-${options.id}`)
    button.onclick = () => openTab(options.id)
    count.hidden = true
    button.append(iconOf(doc, options.icon ?? DEFAULT_ICON), make('span', 'name', options.label), count)
    panel.id = `kay-dev-${options.id}`
    panel.hidden = true
    panel.setAttribute('role', 'tabpanel')
    panel.setAttribute('aria-labelledby', button.id)
    badge.type = 'button'
    badge.hidden = true
    badge.setAttribute('aria-controls', drawer.id)
    badge.onclick = () => state.open && state.tab === options.id ? closeDrawer() : openTab(options.id)

    if (library) {
      rule.hidden = false
      tabList.append(button)
    }
    else {
      tabList.insertBefore(button, tabs[at]?.button ?? rule)
    }

    content.append(panel)
    bar.insertBefore(badge, bar.children[2 + at] ?? null)
    tabs.splice(at, 0, entry)
    // Once the caller is done setting the tab up, as showing it runs its `shown`.
    queueMicrotask(render)

    return {
      panel,
      count: (value, tone, note) => {
        const text = note ?? options.summary?.(value) ?? ''

        count.hidden = value === 0
        count.textContent = String(value)
        count.className = tone === undefined ? 'count pill' : `count pill ${tone}`
        badge.hidden = note === undefined && (value === 0 || options.summary === undefined)
        badge.replaceChildren(pill({ make, icon: name => iconOf(doc, name) }, text, tone, tone === undefined ? undefined : TONE_ICONS[tone]))

        if (options.announce === true)
          status.textContent = value === 0 && note === undefined ? '' : text
      },
    }
  }

  const button = (text: string, label: string, icon?: DevIconName) => {
    const element = make('button')

    element.type = 'button'
    element.setAttribute('aria-label', label)

    if (icon !== undefined)
      element.append(iconOf(doc, icon))

    element.append(text)
    bar.append(element)

    return element
  }

  // A press on the mark that moves past a few pixels drags the bar, landing it in the nearest corner, and opens nothing.
  let dragged = false

  mark.onpointerdown = (event) => {
    if (event.button !== 0)
      return

    const start = bar.getBoundingClientRect()

    dragged = false
    follow(event, mark, (dx, dy) => {
      if (!dragged && Math.hypot(dx, dy) < DRAG_START)
        return

      dragged = true
      bar.style.left = `${start.left + dx}px`
      bar.style.top = `${start.top + dy}px`
      bar.style.right = bar.style.bottom = 'auto'
    }, () => {
      if (!dragged)
        return

      // The click that ends the press comes next, in this same task; a drag ended elsewhere gets none, and must not swallow the next one.
      win.setTimeout(() => {
        dragged = false
      })

      const box = bar.getBoundingClientRect()

      layout.corner = `${box.top + box.height / 2 < room().height / 2 ? 'top' : 'bottom'}-${box.left + box.width / 2 < room().width / 2 ? 'left' : 'right'}`
      bar.style.left = bar.style.top = bar.style.right = bar.style.bottom = ''
      saveLayout()
      place()
    })
  }
  mark.onclick = () => {
    if (dragged)
      return

    if (state.open)
      closeDrawer()
    else
      openTab(undefined)
  }
  close.onclick = () => closeDrawer(true)
  size.onclick = () => {
    layout.max = !layout.max
    saveLayout()
    place()
  }

  // Through the entry, not a destructured binding: tsgo's declaration emit panics on a property assigned to one.
  for (const entry of docks) {
    entry.button.onclick = () => {
      layout.dock = entry.value
      saveLayout()
      place()
    }
  }

  // The head of a floating drawer moves it, snapping it to an edge near where it is let go.
  head.onpointerdown = (event) => {
    if (event.button !== 0 || !ui.classList.contains('floating') || (event.target as Element).closest('button') !== null)
      return

    const start = boxOf(drawer)
    // A press that does not move leaves a drawer that was never moved where its corner puts it.
    let moved = false

    event.preventDefault()
    follow(event, head, (dx, dy) => {
      if (!moved && Math.hypot(dx, dy) < DRAG_START)
        return

      moved = true
      layout.box = fitBox({ ...start, left: start.left + dx, top: start.top + dy }, room())
      place()
    }, () => {
      if (!moved)
        return

      layout.box = snapped(fitBox(layout.box ?? start, room()), room())
      saveLayout()
      place()
    })
  }

  // Each edge and corner resizes the drawer as the pointer moves it; the one the keyboard reaches resizes it by arrow keys.
  const resizeFrom = (edge: string) => {
    const start = boxOf(drawer)

    return (dx: number, dy: number) => {
      const current = dockOf()

      if (current === 'bottom')
        layout.bottom = dockSize(start.height - dy)
      else if (current === 'right')
        layout.right = dockSize(start.width - dx)
      else
        layout.box = fitBox(resized(start, edge, dx, dy, room()), room())

      place()
    }
  }

  for (const grip of grips) {
    grip.onpointerdown = (event) => {
      if (event.button !== 0)
        return

      event.preventDefault()
      follow(event, grip, resizeFrom(grip.dataset.edge!), saveLayout)
    }
    grip.onkeydown = (event) => {
      const arrow = ARROWS[event.key]

      if (arrow === undefined)
        return

      event.preventDefault()
      resizeFrom(grip.dataset.edge!)(arrow[0] * KEY_STEP, arrow[1] * KEY_STEP)
      saveLayout()
    }
  }

  // Up and Down, Home and End move between the tabs, as a vertical tab list's do.
  tabList.onkeydown = (event) => {
    const index = tabs.findIndex(tab => tab.button === root.activeElement)
    const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 }[event.key]

    if (index < 0 || next === undefined)
      return

    event.preventDefault()
    openTab(tabs[(next + tabs.length) % tabs.length]!.options.id, true)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyK') {
      event.preventDefault()

      if (event.repeat)
        return

      if (state.open)
        closeDrawer(true)
      else
        openTab(undefined, true)
    }
    // Only from inside the tool, so the page's own dialogs keep their Escape.
    else if (event.key === 'Escape' && state.open && event.composedPath().includes(host)) {
      closeDrawer(true)
    }
  }

  win.addEventListener('keydown', onKeyDown, true)

  const label = make('div', 'label mono')
  const boxes: HTMLElement[] = []
  let opener: ((source: string) => Promise<string | undefined>) | undefined
  let problems: { stop: () => void } | undefined
  let request: { stop: () => void } | undefined

  label.hidden = true
  root.append(label)

  const outline = (targets: Element[], text: string) => {
    for (const [index, target] of targets.entries()) {
      const box = boundsOf(target)
      const element = boxes[index] ?? root.appendChild(make('div', 'outline'))

      boxes[index] = element
      element.hidden = false
      element.style.left = `${box.left}px`
      element.style.top = `${box.top}px`
      element.style.width = `${box.width}px`
      element.style.height = `${box.height}px`

      if (index === 0) {
        label.hidden = false
        label.textContent = text
        label.style.left = `${Math.max(0, box.left)}px`
        label.style.top = `${box.top > 24 ? box.top - 22 : box.bottom + 2}px`
      }
    }

    for (const box of boxes.slice(targets.length))
      box.hidden = true
  }
  const hideOutline = () => {
    label.hidden = true

    for (const box of boxes)
      box.hidden = true
  }

  const tabOrder = startTabOrder(doc, root, make)

  order.onclick = () => {
    const shown = order.getAttribute('aria-pressed') !== 'true'

    order.setAttribute('aria-pressed', String(shown))
    tabOrder.show(shown)
  }

  // The buttons kay's error pages carry need a script and have no other.
  const listening = new AbortController()
  const here = () => `${win.location.pathname}${win.location.search}`
  const swapLog = { path: here(), log: [] as { busy: boolean, at: number, path: string }[] }
  const swapWatch = new MutationObserver(() => {
    swapLog.log.push({ busy: doc.documentElement.getAttribute('aria-busy') === 'true', at: win.performance.now(), path: here() })

    if (swapLog.log.length > SWAP_LOG)
      swapLog.log.shift()
  })

  swapWatch.observe(doc.documentElement, { attributes: true, attributeFilter: ['aria-busy'] })
  listening.signal.addEventListener('abort', () => swapWatch.disconnect())
  const missing = missingMessages()
  const vitals = watchVitals(doc.defaultView!, listening.signal)
  // A page swap marks the document busy until the new page is in, and a back or forward step moves without one.
  const swaps = new MutationObserver(showWhere)

  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  win.addEventListener('popstate', showWhere, { signal: listening.signal })
  win.addEventListener('resize', place, { signal: listening.signal })
  showWhere()
  listening.signal.addEventListener('abort', () => swaps.disconnect())

  const tool: DevTool = {
    root,
    make,
    tab,
    button,
    icon: name => iconOf(doc, name),
    kit: {
      signal: listening.signal,
      entry: (kind, parts) => entry(tool, kind, parts),
      toolbar: (help, rerun, problems) => toolbar(tool, help, rerun, problems),
      filterable,
      pill: (text, tone) => pill(tool, text, tone),
      copyButton: (what, text) => copyButton(tool, what, text),
      positionButton: source => positionButton(tool, source),
      ownFetch,
      withPositions: text => withPositions(text, tool),
      missing,
      vitals,
      formatBytes,
      fetchKind,
      formatMs,
      ownFetches: OWN_FETCHES,
      swaps: swapLog,
      parseUrl,
      walkComposed,
    },
    outline,
    hideOutline,
    open: async source => opener ? opener(source) : 'no editor here, run kay dev',
    opens: () => opener !== undefined,
    setOpener: (open) => {
      opener = open

      for (const position of root.querySelectorAll<HTMLButtonElement>('button.position'))
        position.disabled = false
    },
    stop: () => {
      problems?.stop()
      request?.stop()
      tabOrder.stop()
      win.removeEventListener('keydown', onKeyDown, true)
      listening.abort()
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(other => other !== pageSheet)
      host.remove()
    },
  }

  problems = problemsTab(doc, tool, state, save, missing)
  request = requestTab(doc, tool)
  lazyTab(tool, { id: 'network', label: 'Network', icon: 'network' }, NETWORK_TAB_URL, load, true)
  lazyTab(tool, { id: 'head', label: 'Head', icon: 'scan-search' }, HEAD_TAB_URL, load, true)
  lazyTab(tool, { id: 'screen-reader', label: 'Screen reader', icon: 'ear', hidden: () => tool.hideOutline() }, READING_TAB_URL, load, true)
  lazyTab(tool, { id: 'env', label: 'Env', icon: 'key-round' }, ENV_TAB_URL, load, true)
  lazyTab(tool, { id: 'images', label: 'Images', icon: 'image' }, IMAGES_TAB_URL, load, true)
  lazyTab(tool, { id: 'performance', label: 'Performance', icon: 'gauge' }, PERFORMANCE_TAB_URL, load, true)
  lazyTab(tool, { id: 'routes', label: 'Routes', icon: 'route' }, ROUTES_TAB_URL, load)

  // Only a site with `i18n` has the tab, whose request block lists the locales.
  if ((JSON.parse(doc.getElementById(REQUEST)?.textContent ?? 'null') as DevRequest | null)?.locales !== undefined)
    lazyTab(tool, { id: 'i18n', label: 'i18n', icon: 'languages' }, I18N_TAB_URL, load, true)

  lazyTab(tool, { id: 'not-found', label: 'Not found', icon: 'circle-x' }, NOT_FOUND_TAB_URL, load, true)
  lazyTab(tool, { id: 'data', label: 'Data', icon: 'database' }, DATA_TAB_URL, load)
  lazyTab(tool, { id: 'jobs', label: 'Jobs', icon: 'list-checks' }, JOBS_TAB_URL, load)
  lazyTab(tool, { id: 'styles', label: 'Styles', icon: 'palette' }, STYLES_TAB_URL, load)
  doc.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-kay-open],button[data-kay-copy]') : null

    if (target)
      void answerErrorPage(tool, target)
  }, { signal: listening.signal })

  return tool
}

// What kay logged, what nothing caught, what the policy blocked, what the accessibility check and `kay check` found, grouped by kind, each listed once with how often it came; those the page logged leave with it on a page swap.
function problemsTab(doc: Document, tool: DevTool, state: DevState, save: () => void, missing: MissingMessages): { stop: () => void } {
  const win = doc.defaultView! as Window & { $kayProblems?: DevProblems }
  const tab = tool.tab({ id: 'problems', label: 'Problems', icon: 'triangle-alert', summary: count => `${count} problem${count === 1 ? '' : 's'}`, announce: true })
  const actions = tool.make('div', 'actions')
  const tally = tool.make('span', 'actions')
  const clear = tool.make('button', 'tool', 'Dismiss all')
  const copy = tool.make('button', 'tool')
  const empty = tool.make('div', 'empty', 'No problems on this page.')
  const groups = new Map(Object.entries(KINDS).map(([kind, label]) => {
    const section = tool.make('section', 'group')
    const heading = tool.make('h3', 'heading', label)
    const total = tool.make('span', 'pill')
    const list = tool.make('div', 'list')

    section.hidden = true
    heading.append(total)
    section.append(heading, list)

    return [kind as ProblemKind, { section, total, list }]
  }))
  const shown = new Map<string, { problem: DevProblem, kind: ProblemKind, element: HTMLElement, times: HTMLElement, count: number }>()
  const dismissed = new Set(state.dismissed)

  clear.type = 'button'
  copy.type = 'button'
  copy.title = 'Copy every problem as plain text, to paste into an LLM'
  copy.append(tool.icon('copy'), tool.make('span', '', 'Copy'))
  actions.append(tally, tool.make('span', 'grow'), copy, clear)
  tab.panel.append(actions, empty, ...[...groups.values()].map(group => group.section))

  const update = () => {
    const counts = new Map<ProblemKind, number>()
    let errors = 0

    for (const { problem, kind } of shown.values()) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)

      if (problem.level === 'error')
        errors++
    }

    const warnings = shown.size - errors

    tab.count(shown.size, errors > 0 ? 'error' : 'warn')
    tally.replaceChildren(
      ...errors > 0 ? [pill(tool, `${errors} error${errors === 1 ? '' : 's'}`, 'error', 'circle-x')] : [],
      ...warnings > 0 ? [pill(tool, `${warnings} warning${warnings === 1 ? '' : 's'}`, 'warn', 'triangle-alert')] : [],
    )
    empty.hidden = shown.size > 0
    actions.hidden = shown.size === 0

    for (const [kind, group] of groups) {
      const count = counts.get(kind) ?? 0

      group.section.hidden = count === 0
      group.total.textContent = String(count)
    }
  }
  const remove = (text: string) => {
    shown.get(text)?.element.remove()
    shown.delete(text)
  }
  const dismiss = (texts: string[]) => {
    for (const text of texts) {
      dismissed.add(text)
      remove(text)
    }

    state.dismissed = [...dismissed].slice(-MAX_DISMISSED)
    save()
    tool.hideOutline()
    update()
  }
  const add = (logged: DevProblem, check = false) => {
    missing.note(logged)

    const problem = { ...logged, text: problemText(logged) }
    const known = shown.get(problem.text)

    // `kay check` is read again after each swap, which is no new occurrence.
    if (known && check)
      return

    if (known) {
      known.count++
      known.times.hidden = false
      known.times.textContent = `${known.count} times`

      return
    }

    if (dismissed.has(problem.text))
      return

    const kind: ProblemKind = check ? 'check' : problem.kind ?? (problem.text.startsWith('a11y ') ? 'a11y' : 'kay')
    const element = tool.make('div', `problem ${problem.level}`)
    const times = tool.make('span', 'pill')
    const close = tool.make('button', 'icon dismiss')
    const text = tool.make('pre', 'mono')

    times.hidden = true
    close.type = 'button'
    setIcon(close, 'Dismiss this problem', 'x')
    const key = problem.text

    close.onclick = () => dismiss([key])
    text.append(...withPositions(problem.text, tool))

    if (CHUNK_FRAME.test(problem.text)) {
      void (async () => {
        const mapped = await onKayLines(doc.defaultView!, problem.text)

        if (mapped !== undefined) {
          problem.text = mapped
          text.replaceChildren(...withPositions(mapped, tool))
        }
      })()
    }

    element.append(tool.icon(problem.level === 'error' ? 'circle-x' : 'triangle-alert'), text, close, times)

    if (kind === 'a11y') {
      element.onpointerenter = () => {
        const targets = a11yTargets(doc, problem.text)
        const colon = problem.text.indexOf(':')

        if (targets.length > 0)
          tool.outline(targets, problem.text.slice(5, colon < 0 ? undefined : colon))
      }
      element.onpointerleave = () => tool.hideOutline()
    }

    shown.set(key, { problem, kind, element, times, count: 1 })
    groups.get(kind)!.list.append(element)
    update()
  }

  clear.onclick = () => dismiss([...shown.keys()])
  copy.onclick = async () => copyText(copy, copiedProblems(win.location.href, [...shown.values()]))

  // What `kay check` finds now, as the page carries it: a swap brings the block of the code the server runs.
  const readChecks = () => {
    const texts = new Set([CHECK_PROBLEMS, TYPE_PROBLEMS].flatMap(id => JSON.parse(doc.getElementById(id)?.textContent ?? '[]') as string[]))

    for (const [text, { kind }] of shown) {
      if (kind === 'check' && !texts.has(text))
        remove(text)
    }

    for (const text of texts)
      add({ level: text.startsWith('error') ? 'error' : 'warn', text }, true)

    update()
  }

  readChecks()

  // The type check beside the server ended: its block is rewritten, so a page swapped in later reads the same, and the tab shows it without a reload.
  const typed = (event: Event) => {
    const block = doc.getElementById(TYPE_PROBLEMS) ?? doc.head.appendChild(Object.assign(doc.createElement('script'), { id: TYPE_PROBLEMS, type: 'application/json' }))

    block.textContent = String((event as CustomEvent<string>).detail)
    readChecks()
  }

  win.addEventListener(TYPES_EVENT, typed)

  // What was logged before this loaded, then each problem as it is logged, a microtask later so a failure here never breaks the call that logged.
  const early = Array.isArray(win.$kayProblems) ? win.$kayProblems as DevProblem[] : []

  win.$kayProblems = {
    push: (problem: DevProblem) => queueMicrotask(() => {
      try {
        add(problem)
      }
      catch {}
    }),
  }

  for (const problem of early)
    add(problem)

  // A page swap marks the document busy until the new page is in: the old page's problems go as it starts, and what `kay check` finds is read again once it ends.
  const swaps = new MutationObserver(() => {
    if (!doc.documentElement.hasAttribute('aria-busy')) {
      readChecks()

      return
    }

    for (const [text, { kind }] of shown) {
      if (kind !== 'check')
        remove(text)
    }

    tool.hideOutline()
    update()
  })

  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  update()

  return {
    stop: () => {
      swaps.disconnect()
      win.removeEventListener(TYPES_EVENT, typed)
      // Problems logged from now on wait for the next tool.
      win.$kayProblems = [] as DevProblem[]
    },
  }
}

const MISSING_MESSAGE = /no locale has the message ("(?:[^"\\]|\\.)*")/

// The message keys the page asked for that no locale has, read off the problems kay logs, which `changed` hears of.
export interface MissingMessages {
  keys: Set<string>
  changed: () => void
  note: (problem: DevProblem) => void
  clear: () => void
}

function missingMessages(): MissingMessages {
  const missing: MissingMessages = {
    keys: new Set(),
    changed: () => undefined,
    note: ({ text }) => {
      const quoted = MISSING_MESSAGE.exec(text)?.[1]
      const key = quoted === undefined ? undefined : JSON.parse(quoted) as string

      if (key !== undefined && !missing.keys.has(key)) {
        missing.keys.add(key)
        missing.changed()
      }
    },
    clear: () => {
      if (missing.keys.size > 0) {
        missing.keys.clear()
        missing.changed()
      }
    },
  }

  return missing
}

// What served the page: the route it matched, the files that rendered it, outermost first, its params and status, and how long each load took on the scale of the whole request; read again after each page swap.
function requestTab(doc: Document, tool: DevTool): { stop: () => void } {
  const tab = tool.tab({ id: 'request', label: 'Request', icon: 'server' })
  const content = tool.make('div', 'stack')
  const bar = toolbar(tool, 'Filter facts and headers', () => bar.apply(content))
  // The block the tab shows now.
  let current: string | undefined
  const section = (heading: string, ...children: Node[]) => {
    const element = tool.make('section', 'group')

    element.append(tool.make('h3', 'heading', heading), ...children)

    return element
  }
  // What the server recorded of the response: asked for once the page is in view, and dropped if another page's block replaced this one while it was out.
  const showResponse = async (id: string, block: string, line: HTMLElement, facts: HTMLElement, timing: (total: number, phases: ServerPhases) => void, panel: HTMLElement) => {
    let recorded: DevResponse | undefined

    try {
      const response = await ownFetch(doc.defaultView!, `${REQUEST_URL}?id=${encodeURIComponent(id)}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store' })

      recorded = response.ok ? await response.json() as DevResponse : undefined
    }
    catch {
      recorded = undefined
    }

    if (current !== block)
      return

    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(filterable(tool.make('dt', '', term), `${term} ${value.textContent}`), filterable(value, `${term} ${value.textContent}`))
    }

    if (recorded === undefined) {
      fact('Response', tool.make('span', 'note', 'not recorded by the server'))
      bar.apply(panel)

      return
    }

    const hops = recorded.redirects.map(hop => tool.make('span', 'mono', `${hop.from} (${hop.status}${hop.by === undefined ? '' : `, by ${hop.by}`})`))
    const rank = (name: string) => !FIRST_HEADERS.includes(name) ? FIRST_HEADERS.length : FIRST_HEADERS.indexOf(name)
    const headers = [...recorded.headers].sort(([a], [b]) => rank(a) - rank(b))
    const table = tool.make('table', 'headers')

    line.append(pill(tool, `${formatMs(recorded.ms)} on the server`))
    fact('Redirected', ...hops.length === 0 ? [tool.make('span', 'note', 'no')] : hops)
    timing(recorded.ms, serverPhases(recorded.headers.find(([name]) => name === 'server-timing')?.[1] ?? ''))

    for (const [name, value] of headers)
      table.append(filterable(headerRow(tool, name, value), `${name}: ${value}`))

    panel.insertBefore(section('Response headers', headers.length === 0 ? tool.make('span', 'note', 'none') : table), bar.empty)
    bar.apply(panel)
  }
  const read = () => {
    // A swap adds the next page's block before it drops this one's.
    const block = [...doc.querySelectorAll(`script#${REQUEST}`)].at(-1)?.textContent

    current = block ?? undefined

    bar.element.hidden = block === undefined || block === null

    if (block === undefined || block === null) {
      tab.count(0)
      content.replaceChildren(tool.make('div', 'empty', 'kay served no request block with this page.'))

      return
    }

    const request = JSON.parse(block) as DevRequest
    const win = doc.defaultView!
    const line = tool.make('div', 'reqline')
    const facts = tool.make('dl', 'facts')
    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(filterable(tool.make('dt', '', term), `${term} ${value.textContent}`), filterable(value, `${term} ${value.textContent}`))
    }
    const params = Object.entries(request.params)
    const chips = tool.make('span', 'chips')
    const chain = tool.make('ul', 'chain')
    const step = (kind: string, file: HTMLElement, depth: number, outcome?: HTMLElement) => {
      const item = tool.make('li')
      const where = tool.make('span', 'd')

      where.style.setProperty('--depth', String(depth))
      where.append(file)
      item.append(tool.make('span', 'k', kind), where, outcome ?? tool.make('span'))
      chain.append(filterable(item, `${kind} ${file.textContent} ${outcome?.textContent ?? ''}`))
    }
    const timing = tool.make('section', 'group')
    const scaled = (total?: number, phases: ServerPhases = {}) => {
      const longest = Math.max(total ?? 0, ...Object.values(phases), ...request.loads.map(load => load.ms ?? 0))
      const grid = tool.make('div', 'timing')
      const bar = (ms: number | undefined, className = 'bars') => {
        const track = tool.make('span', className)
        const fill = tool.make('i')

        fill.style.width = ms === undefined || longest === 0 ? '0' : `${Math.max(1, ms / longest * 100)}%`
        track.append(fill)

        return track
      }

      const phase = (name: keyof ServerPhases, label: string) => {
        const ms = phases[name]

        if (ms !== undefined)
          grid.append(tool.make('span', 'note', label), bar(ms), tool.make('span', 'v', formatMs(ms)))
      }

      phase('guards', 'Guards')
      phase('import', 'Importing modules')
      phase('loads', request.loads.length > 1 ? 'Loads, run at once' : 'Loads')

      for (const load of request.loads)
        grid.append(positionButton(tool, load.file), bar(load.ms), tool.make('span', 'v', load.ms === undefined ? 'not timed' : formatMs(load.ms)))

      phase('render', 'Render, what a stream sends first')

      if (total !== undefined)
        grid.append(tool.make('span', 'note', 'Whole request'), bar(total, 'bars total'), tool.make('span', 'v', formatMs(total)))

      timing.hidden = request.loads.length === 0 && total === undefined
      timing.replaceChildren(tool.make('h3', 'heading', 'Time on the server'), grid)
    }
    // Read off the page once the guards pass, so a request one refused says nothing of it.
    const refusedByGuard = request.guards.some(guard => guard.outcome !== 'passed' && guard.outcome !== 'did not run')
    const rendered = request.prerender === undefined ? 'on request' : `on request here, ${PRERENDER[request.prerender]}`
    const status = pill(tool, request.error === undefined ? String(request.status) : `${request.status} ${request.error}`, request.status >= 400 ? 'error' : 'ok')
    const path = tool.make('span', 'path', `${win.location.pathname}${win.location.search}`)

    line.append(tool.make('span', 'method', 'GET'), path, status)
    tab.count(request.status >= 400 ? 1 : 0, 'error')
    fact('Route', request.route === undefined ? tool.make('span', 'note', 'none matched') : tool.make('span', 'mono', request.route))
    chips.append(...params.map(([name, value]) => tool.make('span', 'chip', `${name} = ${JSON.stringify(value)}`)))
    fact('Params', params.length === 0 ? tool.make('span', 'note', 'none') : chips)

    fact('Locale', request.locale)
    fact('Rendered', refusedByGuard ? 'not known, a guard refused the request' : rendered)

    for (const guard of request.guards)
      step('Guard', positionButton(tool, guard.file), 0, pill(tool, guard.outcome, guardTone(guard.outcome)))

    for (const [depth, layout] of request.layouts.entries())
      step('Layout', positionButton(tool, layout), depth)

    step('Page', positionButton(tool, request.page), request.layouts.length)
    scaled()
    content.replaceChildren(line, section('Matched', facts), section('Files, outermost first', chain), timing, bar.empty)
    bar.apply(content)
    void showResponse(request.id, block, line, facts, scaled, content)
  }
  // A page swap, or the patch a page without one gets, brings the next page's block.
  const swaps = new MutationObserver((records) => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => (node as Element).id === REQUEST)))
      read()
  })

  tab.panel.append(bar.element, content)
  read()
  swaps.observe(doc.head, { childList: true })

  return { stop: () => swaps.disconnect() }
}

// The phases of a page's render its `Server-Timing` header gives, in milliseconds.
type ServerPhases = Partial<Record<'guards' | 'import' | 'loads' | 'render', number>>

function serverPhases(header: string): ServerPhases {
  const phases: ServerPhases = {}

  for (const [, name, ms] of header.matchAll(SERVER_PHASE))
    phases[name as keyof ServerPhases] = Number(ms)

  return phases
}

function parseUrl(src: string, base: string): URL | undefined {
  try {
    return new URL(src, base)
  }
  catch {
    return undefined
  }
}

// What a request was for: an action, a server island, a page a swap or prefetch fetched, another fetch, or the kind of file the page loaded.
function fetchKind(fetched: PerformanceResourceTiming, url: URL): string {
  const type = 'contentType' in fetched && typeof fetched.contentType === 'string' ? fetched.contentType : ''

  if (fetched.entryType === 'navigation')
    return 'document'

  if (ACTION_PATH.test(url.pathname))
    return 'action'

  if (url.searchParams.has(ISLAND_PARAM))
    return 'server island'

  if (fetched.initiatorType === 'fetch' || fetched.initiatorType === 'xmlhttprequest')
    return type.startsWith('text/html') ? 'page' : 'fetch'

  if (fetched.initiatorType === 'script' || url.pathname.endsWith('.js'))
    return 'script'

  if (url.pathname.endsWith('.css') || type.startsWith('text/css'))
    return 'stylesheet'

  if (fetched.initiatorType === 'img' || fetched.initiatorType === 'image' || type.startsWith('image/'))
    return 'image'

  if (FONT_FILE.test(url.pathname) || type.startsWith('font/'))
    return 'font'

  return fetched.initiatorType === '' ? 'other' : fetched.initiatorType
}

// A new window of layout shifts starts after a gap this long, and one never lasts past the second.
const SHIFT_GAP_MS = 1000
const SHIFT_WINDOW_MS = 5000

export type VitalName = 'lcp' | 'cls' | 'inp'

export interface Vitals {
  // The page the browser loaded them for: a link swapping in another page starts no new load.
  path: string
  // The largest paint so far, the element it painted when it is on the page.
  lcp?: { ms: number, element: Element | undefined } | undefined
  cls: number
  inp?: number | undefined
  // Called with the vital that changed.
  changed: ((name: VitalName) => void)[]
}

interface ShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

interface EventEntry extends PerformanceEntry {
  interactionId?: number
  target?: Node | null
}

// The page's LCP, CLS and INP as the browser reports them from the moment the tool loads, earlier entries included; a browser without an entry type leaves that vital out.
function watchVitals(win: Window & typeof globalThis, signal: AbortSignal): Vitals {
  const vitals: Vitals = { path: win.location.pathname, cls: 0, changed: [] }
  const observe = (type: string, handle: (entries: PerformanceEntry[]) => void, options: PerformanceObserverInit & { durationThreshold?: number } = {}) => {
    try {
      const observer = new win.PerformanceObserver(list => handle(list.getEntries()))

      observer.observe({ type, buffered: true, ...options })
      signal.addEventListener('abort', () => observer.disconnect())
    }
    catch {
      // Not every browser reports every type.
    }
  }
  const announce = (name: VitalName) => {
    for (const listener of vitals.changed)
      listener(name)
  }
  // The layout shifts without a recent input, in windows: the vital is the worst window.
  let windowStart = 0
  let windowEnd = 0
  let windowValue = 0
  // The slowest event of each interaction.
  const interactions = new Map<number, number>()

  observe('largest-contentful-paint', (entries) => {
    const entry = entries.at(-1) as (PerformanceEntry & { element?: Element | null, renderTime: number, loadTime: number }) | undefined

    if (entry) {
      vitals.lcp = { ms: entry.renderTime || entry.loadTime || entry.startTime, element: entry.element ?? undefined }
      announce('lcp')
    }
  })
  observe('layout-shift', (entries) => {
    const before = vitals.cls

    for (const entry of entries as ShiftEntry[]) {
      if (entry.hadRecentInput)
        continue

      if (windowValue > 0 && entry.startTime - windowEnd < SHIFT_GAP_MS && entry.startTime - windowStart < SHIFT_WINDOW_MS) {
        windowValue += entry.value
      }
      else {
        windowStart = entry.startTime
        windowValue = entry.value
      }

      windowEnd = entry.startTime
      vitals.cls = Math.max(vitals.cls, windowValue)
    }

    if (vitals.cls !== before)
      announce('cls')
  })
  observe('event', (entries) => {
    const before = vitals.inp

    for (const entry of entries as EventEntry[]) {
      // The tool's own clicks are not the page's.
      if (entry.target instanceof win.Element && entry.target.closest(HOST) !== null)
        continue

      if (entry.interactionId !== undefined && entry.interactionId > 0)
        interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration))
    }

    // The longest interaction, or the 98th percentile of many, as the metric is defined.
    const slowest = [...interactions.values()].sort((a, b) => b - a)

    vitals.inp = slowest[Math.min(slowest.length - 1, Math.floor(slowest.length / 50))]

    if (vitals.inp !== before)
      announce('inp')
  }, { durationThreshold: 16 })

  return vitals
}

// What a lazy tab's module default-exports: it fills the panel and gives back what reads the tab again each time it shows.
export type DevTabModule = (tool: DevTool, tab: DevTab) => (() => void) | void

// How the tool fetches a tab's module, which a test replaces with the module itself.
export type LoadTab = (url: string) => Promise<{ default: DevTabModule }>

// A tab whose code is a module of its own, fetched the first time the tab opens so the tool carries none of it until then; a module that fails to load says so in the panel and is tried again at the next open.
// A tab with `early` shows a badge from the page itself, so its module is fetched at once and sets the badge as it runs, the panel read again if it is open by then.
function lazyTab(tool: DevTool, options: Pick<DevTabOptions, 'id' | 'label' | 'icon' | 'hidden'>, url: string, load: LoadTab, early = false): void {
  let refresh: (() => void) | undefined
  let loading = false
  let open: () => void = () => undefined
  const tab: DevTab = tool.tab({ ...options, shown: () => open() })

  open = () => {
    if (refresh !== undefined)
      return refresh()

    if (loading)
      return

    loading = true
    void (async () => {
      try {
        const loaded = await load(url)

        // The tool stopped while the module was on its way.
        if (tool.kit.signal.aborted)
          return

        refresh = loaded.default(tool, tab) ?? (() => undefined)

        if (!early || tab.panel.hidden === false)
          refresh()
      }
      catch (error) {
        tab.panel.replaceChildren(tool.make('div', 'empty', `Could not load the ${options.label} tab: ${error instanceof Error ? error.message : String(error)}`))
      }
      finally {
        loading = false
      }
    })()
  }

  if (early)
    open()
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

function formatMs(ms: number): string {
  return `${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`
}

// A file, or a position in one, as a button opening it in the editor once the inspector says how; a file named alone opens at its first line.
function positionButton(tool: DevTool, source: string): HTMLButtonElement {
  const position = tool.make('button', 'position', source)

  position.type = 'button'
  position.disabled = !tool.opens()
  position.onclick = async () => {
    const failed = await tool.open(withLine(source))
    const note = position.nextElementSibling?.classList.contains('note') === true ? position.nextElementSibling : undefined

    note?.remove()

    if (failed !== undefined)
      position.after(tool.make('span', 'note', ` (${failed})`))
  }

  return position
}

// A fetch of the dev tool's own, which the Network tab leaves out.
async function ownFetch(win: Window, url: string, init?: RequestInit): Promise<Response> {
  // Its own routes are left out by their path already.
  if (!DEV_PATH.test(url))
    OWN_FETCHES.add(new URL(url, win.location.href).href)

  return win.fetch(url, init)
}

// Whether the text reached the clipboard of the button's window.
async function toClipboard(button: HTMLButtonElement, text: string): Promise<boolean> {
  try {
    await button.ownerDocument.defaultView!.navigator.clipboard.writeText(text)

    return true
  }
  catch {
    return false
  }
}

// Opens the position an error page's button names, saying why it could not, or copies the error, saying so a moment.
async function answerErrorPage(tool: DevTool, target: HTMLButtonElement): Promise<void> {
  const { kayOpen: source, kayCopy: copiedId } = target.dataset

  if (source !== undefined) {
    const failed = await tool.open(withLine(source))

    target.textContent = failed === undefined ? source : `${source} (${failed})`

    return
  }

  await copyText(target, target.ownerDocument.getElementById(copiedId!)?.textContent ?? '')
}

// Writes the text to the clipboard and says so on the button for a moment, or that it failed, without a dialog; the text sits in the button's own span when it has one, beside its icon.
async function copyText(button: HTMLButtonElement, text: string): Promise<void> {
  const label = button.querySelector('span') ?? button

  const worked = await toClipboard(button, text)

  label.textContent = worked ? 'Copied' : 'Copy failed'
  announce(button, label.textContent)

  clearTimeout(copyResets.get(button))
  copyResets.set(button, setTimeout(() => {
    label.textContent = 'Copy'
  }, COPIED_MS))
}

// The stack with its chunk frames on `.kay` lines as the server maps them; none when it cannot.
async function onKayLines(win: Window, stack: string): Promise<string | undefined> {
  try {
    const response = await ownFetch(win, STACK_URL, { method: 'POST', headers: { 'content-type': 'application/json', [HEAD_HEADER]: '1' }, body: JSON.stringify({ stack }), cache: 'no-store' })

    return response.ok ? (await response.json() as { stack: string }).stack : undefined
  }
  catch {
    return undefined
  }
}

// A file named alone or by its line opens at its first line or column.
function withLine(source: string): string {
  const [, file, line = '1', column = '1'] = OPENED_POSITION.exec(source) ?? []

  return file === undefined ? source : `${file}:${line}:${column}`
}

// An error's stack, headed by its name and message where the browser leaves them out, or the text logged with it; the island kay caught it in first.
function problemText({ text, error, island }: DevProblem): string {
  const { name, message, stack } = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown, message?: unknown, stack?: unknown }
  const head = `${String(name)}: ${String(message)}`
  let shown = text

  if (typeof stack === 'string' && stack !== '')
    shown = stack.startsWith(String(name)) ? stack : `${head}\n${stack}`

  const where = island === undefined ? '' : `in island ${island}: `

  return `${where}${text.startsWith('Uncaught (in promise) ') && shown !== text ? `Uncaught (in promise) ${shown}` : shown}`
}

// Every listed problem as plain text for a reader without the page, such as an LLM: the page, then a block per problem in the tab's order, with its kind, level and how often it came, and the message as listed, which names its file and line where it knows them.
function copiedProblems(url: string, listed: { problem: DevProblem & { text: string }, kind: ProblemKind, count: number }[]): string {
  const order = Object.keys(KINDS)
  const blocks = listed.toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).map(({ problem, kind, count }) => `[${KINDS[kind]}] ${problem.level}${count > 1 ? ` (${count} times)` : ''}\n${problem.text}`)

  return [`kay dev problems on ${url}`, ...blocks].join('\n\n')
}

// What the Markdown of a tab leaves out: its controls, drawings, the Head previews that repeat its tags, and what is hidden.
const UNCOPIED = '.toolbar, .actions, .copy, .dismiss, .previews, .scalebox, img, svg, .rule, [hidden], [data-filtered]'
// Elements a line of text runs through, rather than blocks of their own.
const INLINE = new Set(['a', 'b', 'button', 'code', 'i', 'small', 'span', 'strong'])
const BULLET = /^ *- /
const SPACES = /\s+/g

// The text of an element, its parts spaced as they are drawn apart, and what the Markdown leaves out skipped.
function spacedText(element: Element): string {
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '')

      return
    }

    if (node instanceof Element && node.matches(UNCOPIED))
      return

    // An element stands apart from the text around it, as a pill after a heading's words.
    for (const child of node.childNodes) {
      if (child instanceof Element)
        parts.push(' ')

      walk(child)

      if (child instanceof Element)
        parts.push(' ')
    }
  }

  walk(element)

  return parts.join('').replace(SPACES, ' ').trim()
}

function fenced(text: string): string {
  const fence = text.includes('```') ? '````' : '```'

  return `${fence}text\n${text}\n${fence}`
}

// What a tab shows, as Markdown to paste into an issue or an LLM: headings, facts and table rows as bullets, a row of a list with its chips, problems and note, problems and code as fenced blocks; the filter and buttons are left out, and so is what it hides.
function panelMarkdown(panel: Element, title: string): string {
  const lines: string[] = [`# ${title}`]
  const block = (element: Element) => {
    if (element.matches(UNCOPIED))
      return

    const tag = element.localName
    const kind = element.classList

    if (tag === 'h3') {
      lines.push(`## ${spacedText(element)}`)
    }
    else if (tag === 'dl') {
      for (const term of element.querySelectorAll(':scope > dt:not([hidden])'))
        lines.push(`- ${spacedText(term)}: ${term.nextElementSibling === null ? '' : spacedText(term.nextElementSibling)}`)
    }
    else if (tag === 'table') {
      for (const row of element.querySelectorAll('tr:not([hidden])'))
        lines.push(`- ${[...row.children].map(cell => spacedText(cell)).filter(Boolean).join(': ')}`)
    }
    else if (tag === 'ul') {
      for (const item of element.querySelectorAll(':scope > li:not([hidden])'))
        lines.push(`- ${spacedText(item)}`)
    }
    else if (tag === 'pre') {
      lines.push(fenced(element.textContent ?? ''))
    }
    else if (tag === 'details') {
      lines.push(`**${spacedText(element.querySelector('summary') ?? element)}**`, fenced(element.querySelector('pre')?.textContent ?? ''))
    }
    else if (kind.contains('problem')) {
      const level = kind.contains('error') ? 'Error' : 'Warning'
      const told = [...element.querySelectorAll(':scope > .pill')].map(pill => spacedText(pill)).filter(Boolean)

      lines.push(`**${level}**${told.length === 0 ? '' : `, ${told.join(', ')}`}`, fenced(element.querySelector('pre')?.textContent ?? ''))
    }
    else if (kind.contains('entry')) {
      const chips = [...element.querySelectorAll('.chips > *')].map(chip => spacedText(chip)).filter(Boolean)

      lines.push(`- ${spacedText(element.querySelector('.line')!)}`)

      if (chips.length > 0)
        lines.push(`  - ${chips.join(', ')}`)

      for (const issue of element.querySelectorAll('.issue'))
        lines.push(`  - ${issue.classList.contains('error') ? 'Error' : 'Warning'}: ${spacedText(issue)}`)

      for (const note of element.querySelectorAll('.body > .note'))
        lines.push(`  - ${spacedText(note)}`)
    }
    else if (kind.contains('vital')) {
      const rating = element.querySelector('.top .pill')
      const note = element.querySelector(':scope > .note')

      lines.push(`- ${spacedText(element.querySelector('.name')!)}: ${spacedText(element.querySelector('.num')!)}${rating === null ? '' : `, ${spacedText(rating)}`}`)

      if (note !== null)
        lines.push(`  - ${spacedText(note)}`)
    }
    else if (kind.contains('timing') || kind.contains('weight')) {
      // A grid of a name, a bar and a value per row, with a line of files under some.
      let row: string[] = []

      for (const cell of element.children) {
        if (cell.matches(UNCOPIED) || cell.classList.contains('bars') || spacedText(cell) === '') {
          continue
        }
        else if (cell.classList.contains('files')) {
          lines.push(`  - ${spacedText(cell)}`)
        }
        else {
          row.push(spacedText(cell))

          if (row.length === 2) {
            lines.push(`- ${row.join(': ')}`)
            row = []
          }
        }
      }
    }
    else if (element.children.length > 0 && ![...element.children].every(child => INLINE.has(child.localName))) {
      for (const child of element.children)
        block(child)
    }
    else {
      const text = spacedText(element)

      if (text !== '')
        lines.push(text)
    }
  }

  for (const child of panel.children)
    block(child)

  // Bullets run on, anything else stands apart.
  return lines.reduce((text, line, index) => index === 0 ? line : `${text}${BULLET.test(line) && BULLET.test(lines[index - 1]!) ? '\n' : '\n\n'}${line}`, '')
}

// The text with each source file it names, with or without a position, as a button opening it once the inspector says how.
function withPositions(text: string, tool: DevTool): Node[] {
  const nodes: Node[] = []
  let last = 0

  for (const match of text.matchAll(SOURCE_POSITION)) {
    const [source] = match

    nodes.push(textNode(text.slice(last, match.index)), positionButton(tool, source))
    last = match.index + source.length
  }

  nodes.push(textNode(text.slice(last)))

  return nodes

  function textNode(part: string): Node {
    return tool.root.ownerDocument.createTextNode(part)
  }
}

// The elements an accessibility problem names, one selector a line under its first, those inside a shadow root left out.
function a11yTargets(doc: Document, text: string): Element[] {
  const elements: Element[] = []

  for (const line of text.split('\n').slice(1)) {
    const selector = line.startsWith('  ') ? line.trim() : ''

    if (selector === '' || selector.includes(' >>> ') || selector.startsWith('and '))
      continue

    try {
      elements.push(...doc.querySelectorAll(selector))
    }
    catch {}
  }

  return elements
}

function readState(win: Window): DevState {
  const fallback: DevState = { open: false, tab: 'problems', dismissed: [] }

  try {
    return { ...fallback, ...JSON.parse(win.sessionStorage.getItem(STATE_KEY) ?? '{}') as Partial<DevState> }
  }
  catch {
    return fallback
  }
}

// Per browser tab, as the page's own state is: another tab starts closed.
function writeState(win: Window, state: DevState): void {
  try {
    win.sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  }
  catch {}
}

function readLayout(win: Window): DevLayout {
  const fallback: DevLayout = { dock: 'float', corner: 'bottom-left', max: false, bottom: 320, right: 448 }
  let read: Partial<DevLayout>

  try {
    read = JSON.parse(win.localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<DevLayout>
  }
  catch {
    return fallback
  }

  if (typeof read !== 'object' || read === null)
    return fallback

  return {
    dock: DOCKS.some(([dock]) => dock === read.dock) ? read.dock! : fallback.dock,
    corner: CORNERS.has(String(read.corner)) ? read.corner! : fallback.corner,
    max: read.max === true,
    box: isBox(read.box) ? read.box : undefined,
    bottom: typeof read.bottom === 'number' ? read.bottom : fallback.bottom,
    right: typeof read.right === 'number' ? read.right : fallback.right,
  }
}

// Per browser, unlike the rest of the state: a new tab opens the tool where the last one left it.
function writeLayout(win: Window, layout: DevLayout): void {
  try {
    win.localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
  }
  catch {}
}

function isBox(value: unknown): value is Box {
  return typeof value === 'object' && value !== null && (['left', 'top', 'width', 'height'] as const).every(key => Number.isFinite((value as Record<string, unknown>)[key]))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function boxOf(element: Element): Box {
  const { left, top, width, height } = element.getBoundingClientRect()

  return { left, top, width, height }
}

// A box at least the drawer's smallest size, inside the window.
function fitBox(box: Box, room: Room): Box {
  const width = clamp(box.width, MIN_WIDTH, room.width)
  const height = clamp(box.height, MIN_HEIGHT, room.height)

  return { width, height, left: clamp(box.left, 0, room.width - width), top: clamp(box.top, 0, room.height - height) }
}

// A box near an edge of the window lands its margin from it.
function snapped(box: Box, room: Room): Box {
  return { ...box, left: snapAxis(box.left, box.width, room.width), top: snapAxis(box.top, box.height, room.height) }
}

function snapAxis(start: number, size: number, room: number): number {
  if (start < SNAP)
    return MARGIN

  return room - start - size < SNAP ? room - size - MARGIN : start
}

// The box as an edge or corner, `n`, `e`, `s`, `w` or two of them, moves by an offset, stopping at the window, the opposite side staying put.
function resized(start: Box, edge: string, dx: number, dy: number, room: Room): Box {
  const box = { ...start }
  const right = start.left + start.width
  const bottom = start.top + start.height

  if (edge.includes('e'))
    box.width = clamp(start.width + dx, MIN_WIDTH, room.width - start.left)

  if (edge.includes('w')) {
    box.width = clamp(start.width - dx, MIN_WIDTH, right)
    box.left = right - box.width
  }

  if (edge.includes('s'))
    box.height = clamp(start.height + dy, MIN_HEIGHT, room.height - start.top)

  if (edge.includes('n')) {
    box.height = clamp(start.height - dy, MIN_HEIGHT, bottom)
    box.top = bottom - box.height
  }

  return box
}

// Calls `move` with the pointer's offset from where it went down until it lifts, then `done`.
function follow(event: PointerEvent, element: HTMLElement, move: (dx: number, dy: number) => void, done: () => void): void {
  const { clientX, clientY, pointerId } = event
  const moving = new AbortController()

  try {
    element.setPointerCapture(pointerId)
  }
  catch {
    // A pointer the browser no longer tracks, as a synthetic one: moves still reach the element while over it.
  }

  element.addEventListener('pointermove', (next) => {
    if (next.pointerId === pointerId)
      move(next.clientX - clientX, next.clientY - clientY)
  }, { signal: moving.signal })

  for (const type of ['pointerup', 'pointercancel'] as const) {
    element.addEventListener(type, (next) => {
      if (next.pointerId !== pointerId)
        return

      moving.abort()
      done()
    }, { signal: moving.signal })
  }
}

const FOCUSABLE = 'a[href], area[href], button, input:not([type=hidden]), select, textarea, details > summary:first-of-type, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable=false]), [tabindex]'
// Re-reading the page waits for the mutations to settle, and the focus check, which moves focus, for the list of stops or a class or style to change.
const TAB_ORDER_WAIT = 150
const TAB_ORDER_MAX_REPORTED = 5
const FOCUS_ANCESTORS = 4
const WCAG = 'https://www.w3.org/WAI/WCAG22/Understanding'

// What a focus ring or a focus style would change on an element: its outline, shadow, borders, colours and decoration.
const FOCUS_STYLES = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'backgroundColor', 'color', 'textDecorationLine', 'textDecorationColor', 'filter'] as const

// A problem the tab order overlay found, worded as an accessibility rule so the Problems tab lists it and hovering it outlines its elements.
export interface TabOrderIssue {
  id: string
  help: string
  helpUrl: string
  elements: Element[]
}

// The elements the keyboard reaches, in the order Tab walks them: a positive `tabindex` first, smallest first, then the rest as the page is laid out, an open shadow root's contents where its host has them and a slot's where its assigned elements go. What is not rendered, disabled, inert, or out of the order with `tabindex="-1"` is left out, as is all but one radio of a group and the dev tool itself.
export function tabStops(doc: Document): HTMLElement[] {
  return reach(doc).stops
}

// The tab stops and the open shadow roots holding some.
interface Reach {
  stops: HTMLElement[]
  roots: ShadowRoot[]
}

// Visits the page's elements as they are laid out: an open shadow root's contents where its host has them and a slot's where its assigned elements go. `visit` returns false to leave an element's contents out. Gives the open shadow roots met.
function walkComposed(doc: Document, visit: (element: Element) => boolean): ShadowRoot[] {
  const roots: ShadowRoot[] = []

  function visitChildren(parent: Document | ShadowRoot | Element): void {
    for (const child of parent.children)
      walk(child)
  }

  function walk(element: Element): void {
    if (!visit(element))
      return

    if (element instanceof HTMLSlotElement) {
      for (const node of element.assignedElements().length > 0 ? element.assignedElements() : element.children)
        walk(node)
    }
    else if (element.shadowRoot === null) {
      visitChildren(element)
    }
    else {
      roots.push(element.shadowRoot)
      visitChildren(element.shadowRoot)
    }
  }

  visitChildren(doc)

  return roots
}

function reach(doc: Document): Reach {
  const found: HTMLElement[] = []
  const roots = walkComposed(doc, (element) => {
    if (element.localName === HOST || element.hasAttribute('inert'))
      return false

    if (element instanceof HTMLElement && element.matches(FOCUSABLE) && isStop(element))
      found.push(element)

    return true
  })
  const positive = found.filter(element => element.tabIndex > 0).sort((a, b) => a.tabIndex - b.tabIndex)

  return { stops: [...positive, ...found.filter(element => element.tabIndex === 0)], roots }
}

function isStop(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled'))
    return false

  // Not rendered: display none, or a hidden ancestor.
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({ visibilityProperty: true }))
    return false

  return !(element instanceof HTMLInputElement) || element.type !== 'radio' || element.name === '' || element === radioStop(element)
}

// The one radio of a group the keyboard stops at: the checked one, else the first.
function radioStop(radio: HTMLInputElement): HTMLInputElement | undefined {
  const group = [...(radio.form ?? radio.getRootNode() as Document | ShadowRoot).querySelectorAll<HTMLInputElement>('input[type=radio]')].filter(other => other.name === radio.name && other.form === radio.form)

  return group.find(other => other.checked) ?? group[0]
}

// Where the keyboard moves up the page: a stop drawn entirely above the one Tab leaves.
export function tabJumps(stops: HTMLElement[], rects: DOMRect[]): number[] {
  const jumps: number[] = []

  for (let index = 1; index < stops.length; index++) {
    if (rects[index]!.bottom <= rects[index - 1]!.top)
      jumps.push(index)
  }

  return jumps
}

// The element around another, across a shadow root's edge.
function parentOf(node: Element): Element | null {
  const root = node.getRootNode()

  return node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
}

// What a style would show of the element and of the few elements around it that can carry its focus style.
function focusLook(element: HTMLElement): string {
  const looks: string[] = []

  for (let node: Element | null = element, depth = 0; node !== null && depth <= FOCUS_ANCESTORS; node = parentOf(node), depth++) {
    const style = getComputedStyle(node)

    looks.push(FOCUS_STYLES.map(property => style[property]).join('|'))
  }

  return looks.join('||')
}

// The element focus is on, down through open shadow roots.
function deepActive(doc: Document): HTMLElement | null {
  let active = doc.activeElement as HTMLElement | null

  while (active?.shadowRoot?.activeElement)
    active = active.shadowRoot.activeElement as HTMLElement

  return active
}

// The elements that may hold a shadow root besides a custom element.
const SHADOW_HOSTS = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span'])

// Whether the element focus is on may be a host whose closed shadow root holds it: the page reports the host either way, and a host given a tabindex looks as focusable as an element holding focus itself.
function maybeClosedHost(element: HTMLElement): boolean {
  return element.shadowRoot === null && (element.localName.includes('-') || SHADOW_HOSTS.has(element.localName))
}

// The stops whose focus shows nothing: focused, neither they nor the elements around them change how they look. Only elements the browser would show a focus ring on count, as it shows none on a button after a click; focus moves from stop to stop and returns to where it was. Nothing is checked, and undefined returned, while focus may be inside a closed shadow root, which the tool cannot give focus back to.
function hiddenFocus(doc: Document, stops: HTMLElement[], roots: ShadowRoot[]): HTMLElement[] | undefined {
  const win = doc.defaultView!
  const before = deepActive(doc)

  if (before !== null && before !== doc.body && before !== doc.documentElement && (!before.matches(FOCUSABLE) || maybeClosedHost(before)))
    return undefined

  const still = new win.CSSStyleSheet()
  const trees = [doc, ...roots]
  const hidden: HTMLElement[] = []

  // A transition would leave the look unchanged for a moment.
  still.replaceSync('*, *::before, *::after { transition: none !important; animation: none !important; }')

  for (const tree of trees)
    tree.adoptedStyleSheets = [...tree.adoptedStyleSheets, still]

  try {
    for (const stop of stops) {
      const look = focusLook(stop)

      stop.focus({ preventScroll: true })

      if ((stop.getRootNode() as Document | ShadowRoot).activeElement === stop && stop.matches(':focus-visible') && focusLook(stop) === look)
        hidden.push(stop)

      stop.blur()
    }
  }
  finally {
    for (const tree of trees)
      tree.adoptedStyleSheets = tree.adoptedStyleSheets.filter(sheet => sheet !== still)

    before?.focus({ preventScroll: true })

    if (before === null || before === doc.body)
      (doc.activeElement as HTMLElement | null)?.blur()
  }

  return hidden
}

// Where the keyboard may not leave: an `inert` part of the page holding focusable elements while no modal dialog is open, and a modal that is not a `dialog` element, which only a script keeps focus in.
function trapSuspects(doc: Document): { inert: Element[], modals: Element[] } {
  let dialog = false

  try {
    dialog = doc.querySelector('dialog:modal') !== null
  }
  catch {}

  const rendered = (element: Element) => typeof element.checkVisibility !== 'function' || element.checkVisibility()
  const inert = dialog ? [] : [...doc.querySelectorAll('[inert]')].filter(element => element.parentElement?.closest('[inert]') == null && (element.matches(FOCUSABLE) || element.querySelector(FOCUSABLE) !== null))
  const modals = [...doc.querySelectorAll('[aria-modal="true"]')].filter(element => !(element instanceof HTMLDialogElement) && rendered(element))

  return { inert: inert.filter(rendered), modals }
}

// A selector reaching the element: by its id, or by its tag and place from the nearest id or the page.
function selectorOf(element: Element): string {
  const parts: string[] = []

  for (let node: Element | null = element; node !== null && node !== node.ownerDocument.documentElement; node = node.parentElement) {
    if (node.id !== '') {
      parts.unshift(`#${CSS.escape(node.id)}`)

      break
    }

    const same = [...node.parentElement?.children ?? []].filter(sibling => sibling.localName === node.localName)

    parts.unshift(same.length > 1 ? `${node.localName}:nth-of-type(${same.indexOf(node) + 1})` : node.localName)
  }

  return parts.join(' > ')
}

// The warning an issue logs, in the shape of the accessibility check's: the rule and what it asks, then the elements, a few at most, and where it explains.
export function tabOrderProblem(issue: TabOrderIssue): string {
  const shown = issue.elements.slice(0, TAB_ORDER_MAX_REPORTED).map(element => `  ${selectorOf(element)}`)
  const more = issue.elements.length > TAB_ORDER_MAX_REPORTED ? [`  and ${issue.elements.length - TAB_ORDER_MAX_REPORTED} more`] : []

  return [`[kay] a11y ${issue.id}: ${issue.help}`, ...shown, ...more, issue.helpUrl].join('\n')
}

export interface TabOrder {
  show: (on: boolean) => void
  stop: () => void
}

const TAB_ORDER_OBSERVED = { subtree: true, childList: true, attributes: true, attributeFilter: ['tabindex', 'disabled', 'hidden', 'inert', 'open', 'href', 'class', 'style', 'aria-modal', 'aria-busy'] }

// What the overlay found in the page, which a scroll frame draws again without looking for it again.
interface TabScan extends Reach {
  inert: Element[]
  modals: Element[]
}

const NO_SCAN: TabScan = { stops: [], roots: [], inert: [], modals: [] }

// The overlay of the tab order: a numbered badge on each stop and a line between them, a jump up the page dashed in red, what it finds logged as accessibility problems. It reads the page again after it changes or resizes, moves the badges as it scrolls, and does nothing while hidden.
function startTabOrder(doc: Document, root: ShadowRoot, make: DevTool['make']): TabOrder {
  const win = doc.defaultView!
  const layer = make('div', 'tab-order')
  const svg = doc.createElementNS(SVG, 'svg')
  const logged = new Set<string>()
  let found = NO_SCAN
  // Whether the page changed since it was read.
  let stale = true
  // The stops the focus check ran on, which it runs on again when they change or when a class or style change may have changed a focus ring.
  let checked: HTMLElement[] = []
  let restyled = true
  let hidden = new Set<HTMLElement>()
  let on = false
  let frame = 0
  let timer = 0
  const busy = () => doc.documentElement.hasAttribute('aria-busy')
  const changes = new MutationObserver((records) => {
    // A page swap drops the old page's problems with it.
    if (busy()) {
      logged.clear()
      checked = []
      found = NO_SCAN
      repaint()
    }

    if (records.some(record => record.type === 'attributes' && (record.attributeName === 'class' || record.attributeName === 'style')))
      restyled = true

    stale = true
    schedule()
  })
  const move = () => repaint()
  const resize = () => {
    stale = true
    schedule()
  }
  const sameStops = (stops: HTMLElement[]) => stops.length === checked.length && stops.every((stop, index) => stop === checked[index])

  svg.setAttribute('aria-hidden', 'true')
  layer.hidden = true
  layer.append(svg)
  root.append(layer)

  // After the page stops changing for a moment its issues are read and the overlay drawn.
  function schedule(): void {
    if (!on)
      return

    win.clearTimeout(timer)
    timer = win.setTimeout(analyse, TAB_ORDER_WAIT)
  }

  // The next frame moves the overlay to where the stops are now.
  function repaint(): void {
    if (on && frame === 0)
      frame = win.requestAnimationFrame(redraw)
  }

  function report(issues: TabOrderIssue[]): void {
    for (const issue of issues) {
      const text = tabOrderProblem(issue)

      if (issue.elements.length > 0 && !logged.has(text)) {
        logged.add(text)
        console.warn(text)
      }
    }
  }

  function scan(): void {
    stale = false

    const reached = reach(doc)

    found = { ...reached, ...trapSuspects(doc) }

    // Changes inside an open shadow root are not seen from the page's.
    for (const shadow of reached.roots)
      changes.observe(shadow, TAB_ORDER_OBSERVED)
  }

  function analyse(): void {
    timer = 0

    if (!on || busy())
      return

    if (stale)
      scan()

    const { stops, inert, modals } = found

    if (restyled || !sameStops(stops)) {
      const result = hiddenFocus(doc, stops, found.roots)

      if (result !== undefined) {
        checked = stops
        hidden = new Set(result)
        restyled = false
      }

      // Moving focus may have changed the page, which is not a change to read again.
      changes.takeRecords()
    }

    const rects = stops.map(stop => stop.getBoundingClientRect())
    const jumps = tabJumps(stops, rects)

    report([
      { id: 'tab-order-jump', help: 'The keyboard moves up the page from the previous element, because of a positive tabindex or a visual order unlike the DOM\'s', helpUrl: `${WCAG}/focus-order.html`, elements: jumps.map(index => stops[index]!) },
      { id: 'focus-not-visible', help: 'Focus shows nothing on this element, give it an outline or a ring', helpUrl: `${WCAG}/focus-visible.html`, elements: [...hidden] },
      { id: 'keyboard-trap', help: 'Part of the page the keyboard cannot reach while no dialog is open', helpUrl: `${WCAG}/no-keyboard-trap.html`, elements: inert },
      { id: 'keyboard-trap', help: 'A modal that is not an open dialog element, which only a script keeps focus in: check Tab and Escape leave it', helpUrl: `${WCAG}/no-keyboard-trap.html`, elements: modals },
    ])
    draw(rects)
  }

  function redraw(): void {
    frame = 0

    if (!on || busy()) {
      clear()

      return
    }

    // A change waiting to be read draws itself when it is.
    if (stale && timer !== 0)
      return

    if (stale)
      scan()

    draw(found.stops.map(stop => stop.getBoundingClientRect()))
  }

  function clear(): void {
    svg.replaceChildren()
    layer.replaceChildren(svg)
  }

  function draw(rects: DOMRect[]): void {
    clear()

    const { stops, inert, modals } = found
    const jumps = new Set(tabJumps(stops, rects))
    const width = win.innerWidth
    const height = win.innerHeight

    for (const trap of [...inert, ...modals]) {
      const box = boundsOf(trap)
      const element = make('div', 'tab-trap')

      element.style.left = `${box.left}px`
      element.style.top = `${box.top}px`
      element.style.width = `${box.width}px`
      element.style.height = `${box.height}px`
      layer.append(element)
    }

    for (let index = 1; index < stops.length; index++) {
      const from = rects[index - 1]!
      const to = rects[index]!
      const path = doc.createElementNS(SVG, 'path')

      path.setAttribute('d', `M${from.left + from.width / 2} ${from.top + from.height / 2}L${to.left + to.width / 2} ${to.top + to.height / 2}`)

      if (jumps.has(index))
        path.setAttribute('class', 'jump')

      svg.append(path)
    }

    for (const [index, stop] of stops.entries()) {
      const rect = rects[index]!

      if (rect.right < 0 || rect.bottom < 0 || rect.left > width || rect.top > height)
        continue

      const flags = [jumps.has(index) ? 'jump' : '', hidden.has(stop) ? 'hidden-focus' : ''].filter(flag => flag !== '')
      const badge = make('div', `tab-badge ${flags.join(' ')}`, `${index + 1}${flags.length > 0 ? ' !' : ''}`)

      badge.style.left = `${Math.max(0, rect.left - 6)}px`
      badge.style.top = `${Math.max(0, rect.top - 9)}px`
      layer.append(badge)
    }
  }

  function show(value: boolean): void {
    on = value
    layer.hidden = !on
    win.clearTimeout(timer)
    timer = 0
    win.cancelAnimationFrame(frame)
    frame = 0
    logged.clear()
    checked = []
    found = NO_SCAN
    stale = true
    restyled = true
    hidden = new Set()
    changes.disconnect()

    if (!on) {
      win.removeEventListener('scroll', move, true)
      win.removeEventListener('resize', resize)
      clear()

      return
    }

    win.addEventListener('scroll', move, { capture: true, passive: true })
    win.addEventListener('resize', resize)
    changes.observe(doc.documentElement, TAB_ORDER_OBSERVED)
    schedule()
  }

  return {
    show,
    stop: () => show(false),
  }
}

// An island's slot lays out as its contents, so its box is theirs.
function boundsOf(target: Element): DOMRect {
  const rect = target.getBoundingClientRect()

  if (rect.width > 0 || rect.height > 0 || target.children.length === 0)
    return rect

  const boxes = [...target.children].map(child => boundsOf(child))
  const left = Math.min(...boxes.map(box => box.left))
  const top = Math.min(...boxes.map(box => box.top))

  return new DOMRect(left, top, Math.max(...boxes.map(box => box.right)) - left, Math.max(...boxes.map(box => box.bottom)) - top)
}

// A header as a row of two cells, except a policy: its directives each get a line, as one wrapped block of hashes hides which is which.
function headerRow(tool: DevTool, name: string, value: string): HTMLElement {
  const row = tool.make('tr')
  const cell = tool.make('td')
  const directives = name.startsWith('content-security-policy') ? value.split(';').map(directive => directive.trim()).filter(directive => directive !== '') : []

  if (directives.length < 2)
    cell.textContent = value
  else
    cell.append(...directives.map(directive => tool.make('span', 'directive', `${directive};`)))

  cell.append(copyButton(tool, `the ${name} header`, value))
  row.append(tool.make('td', '', name), cell)

  return row
}
