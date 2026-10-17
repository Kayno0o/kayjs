// Loaded by every page a dev server serves: a bar in a corner of the page opens a drawer whose tabs show what kay knows of the page, its problems first; under `kay dev` the inspector adds its own tab and buttons.
// It runs in the browser from its own route, so it imports types only; its elements live in a shadow root on the root element, which a page swap keeps, styled by an adopted stylesheet, which a policy without inline styles allows.
import type { DevHead, DevRequest, DevResponse, DevRoute, DevRoutes } from '../server/dev'
import type { DevProblem, DevProblems } from './dev-boot'

const HOST = 'kay-dev'
const STATE_KEY = 'kay-dev'
const LAYOUT_KEY = 'kay-dev-layout'
const CHECK_PROBLEMS = 'kay-check-problems'
const REQUEST = 'kay-dev-request'
const ROUTES_URL = '/_kay/dev/routes'
const HEAD_URL = '/_kay/dev/head'
const ENV_URL = '/_kay/env.js'
const MODULE_START = 'export default '
const HEAD_HEADER = 'x-kay-dev'
const REQUEST_URL = '/_kay/dev/request'
const SIZES_URL = '/_kay/dev/sizes'
// The navigations the Network tab keeps: the page's load, then each swap.
const MAX_NAVIGATIONS = 5
// The most requests one navigation lists, the rest counted.
const MAX_FETCHES = 300
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
// The event the live reload script fires for each restart or stylesheet swap `kay dev` announces.
const BUILT_EVENT = 'kay-dev-built'
// A path segment, kay's `(group)`, `[param]`, `[[optional]]` and `[...rest]` names included.
const SEGMENT = String.raw`(?:\([\w@.+=-]+\)|\[{1,2}(?:\.{3})?[\w-]+\]{1,2}|[\w@.+=-])+`
const SOURCE_EXTENSION = String.raw`(?:[cm]?[jt]sx?|css)`

// A source file a problem names, with its line and column when it gives them, not one inside a URL nor a URL of kay's own: a `.kay` file named alone, a script or stylesheet once a folder or a line tells it from a word like Node.js, and an absolute one, as a URL path reads, only with a line, as a stack trace gives.
const SOURCE_POSITION = new RegExp(String.raw`(?<![\w@.+=:/\\)\]-])(?![\\/]_kay[\\/])(?:(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.kay|(?:${SEGMENT}[\\/])+${SEGMENT}\.${SOURCE_EXTENSION}|(?:[A-Za-z]:)?[\\/]?(?:${SEGMENT}[\\/])*${SEGMENT}\.${SOURCE_EXTENSION}(?=:\d))(?::\d+(?::\d+)?)?(?!\.?\w)`, 'g')
const OPENED_POSITION = /^(.+\.\w+)(?::(\d+))?(?::(\d+))?$/
// A value the Head tab gives a copy button, as a link.
const WEB_URL = /^https?:\/\//i
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
.bar { position: fixed; bottom: 12px; left: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); box-shadow: var(--shadow); max-width: calc(100vw - 24px); }
.right .bar { left: auto; right: 12px; }
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
.drawer { position: fixed; bottom: 56px; left: 12px; z-index: 2147483647; display: flex; flex-direction: column; width: min(36rem, calc(100vw - 24px)); height: min(28rem, 60vh); border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); overflow: hidden; container: drawer / inline-size; }
.right .drawer { left: auto; right: 12px; }
.max .drawer { width: calc(100vw - 24px); height: calc(100vh - 68px); }
.top .bar { bottom: auto; top: 12px; }
.top .drawer { bottom: auto; top: 56px; }
.ui.dock-bottom .drawer { inset: auto 0 0; width: auto; height: var(--dock); border-width: 1px 0 0; border-radius: 0; }
.ui.dock-right .drawer { inset: 0 0 0 auto; width: min(var(--dock), 100vw); height: auto; border-width: 0 0 0 1px; border-radius: 0; }
.dock-bottom.open:not(.top) .bar { bottom: calc(var(--dock) + 12px); }
.dock-right.open.right .bar { right: calc(var(--dock) + 12px); }
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
.signals { width: 100%; border-collapse: collapse; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.signals td { padding: 3px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.signals td:first-child { color: var(--sub); width: 2.5rem; }
.signals td:last-child { color: var(--sub); text-align: right; padding-left: 10px; }
.outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 2px solid var(--accent); border-radius: 3px; background: var(--accent-soft); }
.label { position: fixed; z-index: 2147483647; pointer-events: none; padding: 2px 7px; border-radius: 5px; background: var(--accent); color: var(--on-accent); white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) {
  .tabs button, .bar > button, .icon { transition: background-color .12s, color .12s; }
}
@media (max-width: 480px) {
  .drawer, .right .drawer, .max .drawer { left: 8px; right: 8px; width: auto; }
  .max .drawer { height: calc(100vh - 68px); }
}
`

const SVG = 'http://www.w3.org/2000/svg'

// Icons of Lucide 0.469.0 (https://lucide.dev), under the ISC licence: Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT), all other copyright (c) for Lucide are held by Lucide Contributors 2022.
// Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
// Each is a 24 by 24 drawing as its nodes, `tag~attribute~value~...` joined by `|`.
const ICONS = {
  'circle-x': 'circle~cx~12~cy~12~r~10|path~d~m15 9-6 6|path~d~m9 9 6 6',
  'triangle-alert': 'path~d~m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3|path~d~M12 9v4|path~d~M12 17h.01',
  'server': 'rect~width~20~height~8~x~2~y~2~rx~2~ry~2|rect~width~20~height~8~x~2~y~14~rx~2~ry~2|line~x1~6~x2~6.01~y1~6~y2~6|line~x1~6~x2~6.01~y1~18~y2~18',
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
const RATING_TONES = { good: 'ok', needs: 'warn', poor: 'error' } as const

// A guard that did not run is no failure, so it has no tone.
function guardTone(outcome: string): 'ok' | 'error' | undefined {
  if (outcome === 'did not run')
    return undefined

  return outcome === 'passed' ? 'ok' : 'error'
}

function worstTone(bad: string[]): 'error' | 'warn' | undefined {
  if (bad.includes('poor'))
    return 'error'

  return bad.length > 0 ? 'warn' : undefined
}

// The tabs kay makes itself; those a library adds sit under a line.
const CORE_TABS = new Set(['problems', 'request', 'network', 'head', 'env', 'images', 'performance', 'routes', 'i18n', 'islands'])

// A small rounded label, tinted by what it counts or says, with an icon before it when given.
function pill(tool: Pick<DevTool, 'make' | 'icon'>, text: string, tone?: 'error' | 'warn' | 'ok' | 'accent', icon?: DevIconName): HTMLElement {
  const element = tool.make('span', tone === undefined ? 'pill' : `pill ${tone}`)

  if (icon !== undefined)
    element.append(tool.icon(icon))

  element.append(text)

  return element
}

interface EntryParts {
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

interface Toolbar {
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

// A section the "Problems only" toggle hides, as it lists no problem.
function plain<T extends HTMLElement>(element: T): T {
  element.dataset.plain = ''

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
  clearTimeout(copyResets.get(button))
  copyResets.set(button, setTimeout(setIcon, COPIED_MS, button, label, icon))
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

        if (own.length > 0)
          group.hidden = own.every(row => row.hidden === true)
        else
          group.toggleAttribute('data-filtered', typed !== '' || only)
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
  // The count beside the tab's name and on the bar, `error` or `warn` coloring both.
  count: (count: number, tone?: 'error' | 'warn') => void
}

export interface DevTool {
  root: ShadowRoot
  make: <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => HTMLElementTagNameMap[K]
  tab: (options: DevTabOptions) => DevTab
  // A button of its own on the bar, with an icon by name from kay's set before its text.
  button: (text: string, label: string, icon?: DevIconName) => HTMLButtonElement
  icon: (name: DevIconName) => SVGSVGElement
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

export function startDevTool(doc: Document = document): DevTool {
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
  const close = make('button', 'icon')
  const grips = GRIPS.map((edge) => {
    const grip = make('div', `grip ${edge}`)

    grip.dataset.edge = edge

    return grip
  })
  const status = make('span', 'sr')
  const tabs: { options: DevTabOptions, button: HTMLButtonElement, panel: HTMLElement, badge: HTMLButtonElement }[] = []
  // A docked drawer pads the page by its size, so none of the page hides under it.
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
  size.type = 'button'
  close.type = 'button'
  setIcon(close, 'Close', 'x')
  setIcon(copyTab, COPY_TAB, 'clipboard-copy')
  copyTab.type = 'button'
  head.append(title, where, copyTab, dock, size, close)
  body.append(tabList, content)
  drawer.append(head, body, ...grips)
  bar.append(mark, status)
  ui.append(drawer, bar)
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
    const sheet = state.open && !floating ? `html { padding-${current}: ${docked}px !important; }` : ''

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
      count: (value, tone) => {
        const text = options.summary?.(value) ?? ''

        count.hidden = value === 0
        count.textContent = String(value)
        count.className = tone === undefined ? 'count pill' : `count pill ${tone}`
        badge.hidden = value === 0 || options.summary === undefined
        badge.replaceChildren(pill({ make, icon: name => iconOf(doc, name) }, text, tone, tone === undefined ? undefined : TONE_ICONS[tone]))

        if (options.announce === true)
          status.textContent = value === 0 ? '' : text
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

  // The buttons kay's error pages carry need a script and have no other.
  const listening = new AbortController()
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
      win.removeEventListener('keydown', onKeyDown, true)
      listening.abort()
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(other => other !== pageSheet)
      host.remove()
    },
  }

  const missing = missingMessages()

  problems = problemsTab(doc, tool, state, save, missing)
  request = requestTab(doc, tool)
  networkTab(doc, tool, listening.signal)
  headTab(doc, tool, listening.signal)
  envTab(doc, tool, listening.signal)
  const vitals = watchVitals(doc.defaultView!, listening.signal)

  imagesTab(doc, tool, vitals, listening.signal)
  performanceTab(doc, tool, vitals, listening.signal)
  routesTab(doc, tool, listening.signal)
  i18nTab(doc, tool, missing, listening.signal)
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
    close.onclick = () => dismiss([problem.text])
    text.append(...withPositions(problem.text, tool))
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

    shown.set(problem.text, { problem, kind, element, times, count: 1 })
    groups.get(kind)!.list.append(element)
    update()
  }

  clear.onclick = () => dismiss([...shown.keys()])
  copy.onclick = async () => copyText(copy, copiedProblems(win.location.href, [...shown.values()]))

  // What `kay check` finds now, as the page carries it: a swap brings the block of the code the server runs.
  const readChecks = () => {
    const texts = new Set(JSON.parse(doc.getElementById(CHECK_PROBLEMS)?.textContent ?? '[]') as string[])

    for (const [text, { kind }] of shown) {
      if (kind === 'check' && !texts.has(text))
        remove(text)
    }

    for (const text of texts)
      add({ level: text.startsWith('error') ? 'error' : 'warn', text }, true)

    update()
  }

  readChecks()

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
      // Problems logged from now on wait for the next tool.
      win.$kayProblems = [] as DevProblem[]
    },
  }
}

const MISSING_MESSAGE = /no locale has the message ("(?:[^"\\]|\\.)*")/

// The message keys the page asked for that no locale has, read off the problems kay logs, which `changed` hears of.
interface MissingMessages {
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

// The page's locale, a link to the page in each other one, and the messages no locale has; only for a site with `i18n`, whose request block lists the locales.
function i18nTab(doc: Document, tool: DevTool, missing: MissingMessages, signal: AbortSignal): void {
  const read = () => JSON.parse(doc.getElementById(REQUEST)?.textContent ?? 'null') as DevRequest | null

  if (read()?.locales === undefined)
    return

  let render: () => void = () => undefined
  const tab = tool.tab({ id: 'i18n', label: 'i18n', icon: 'languages', shown: () => render() })

  render = () => {
    const request = read()

    if (request?.locales === undefined)
      return

    const facts = tool.make('dl', 'facts')
    const switcher = tool.make('dd')
    const chips = tool.make('span', 'locales')
    const messages = tool.make('section', 'group')
    const heading = tool.make('h3', 'heading', 'Missing messages')
    const keys = tool.make('ul', 'missing')

    for (const { locale, href } of request.locales) {
      const current = locale === request.locale
      const chip = current ? tool.make('span', 'locale-chip', locale) : Object.assign(tool.make('a', 'locale-chip', locale), { href })

      if (current)
        chip.setAttribute('aria-current', 'true')

      chips.append(chip)
    }

    switcher.append(chips)

    for (const key of missing.keys) {
      const item = tool.make('li')

      item.append(tool.icon('circle-x'), key)
      keys.append(item)
    }

    heading.append(pill(tool, String(missing.keys.size), missing.keys.size > 0 ? 'error' : undefined))
    messages.append(heading, missing.keys.size === 0 ? tool.make('span', 'note', 'none') : keys)
    facts.append(tool.make('dt', '', 'Locale'), tool.make('dd', 'mono', request.locale), tool.make('dt', '', 'Page in'), switcher)
    tab.count(missing.keys.size, missing.keys.size > 0 ? 'error' : undefined)
    tab.panel.replaceChildren(facts, messages)
  }
  // A page swap brings the next page's block, and starts with the old page's problems gone.
  const blocks = new MutationObserver((records) => {
    if (records.some(record => [...record.addedNodes, ...record.removedNodes].some(node => (node as Element).id === REQUEST)))
      render()
  })
  const swaps = new MutationObserver(() => {
    if (doc.documentElement.hasAttribute('aria-busy'))
      missing.clear()
  })

  missing.changed = render
  render()
  blocks.observe(doc.head, { childList: true })
  swaps.observe(doc.documentElement, { attributeFilter: ['aria-busy'] })
  signal.addEventListener('abort', () => {
    blocks.disconnect()
    swaps.disconnect()
  })
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

interface Navigation {
  // The page it showed, empty while a swap brings it.
  path: string
  start: number
  fetches: PerformanceResourceTiming[]
  more: number
}

// What the page fetched, by navigation, newest first: its load and the last few swaps, each request with its kind, status, size and time; the dev tool's own requests are left out, and an error status is counted on the tab for the page shown.
function networkTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  let draw: () => void = () => undefined
  const tab = tool.tab({ id: 'network', label: 'Network', icon: 'network', shown: () => draw() })
  const content = tool.make('div', 'stack')
  const bar = toolbar(tool, 'Filter by address, kind or status', () => bar.apply(content), true)
  const here = () => `${win.location.pathname}${win.location.search}`
  const navigations: Navigation[] = [{ path: here(), start: 0, fetches: [], more: 0 }]
  const changed = () => {
    const current = navigations.at(-1)!

    tab.count(current.fetches.filter(fetched => statusOf(fetched) >= 400).length, 'error')

    if (tab.panel.hidden === false)
      draw()
  }
  const add = (fetched: PerformanceResourceTiming) => {
    if (DEV_PATH.test(fetched.name) || ((fetched.initiatorType === 'fetch' || fetched.initiatorType === 'xmlhttprequest') && OWN_FETCHES.has(fetched.name)))
      return

    const navigation = navigations.findLast(candidate => candidate.start <= fetched.startTime) ?? navigations[0]!

    if (navigation.fetches.length < MAX_FETCHES)
      navigation.fetches.push(fetched)
    else
      navigation.more++
  }

  draw = () => {
    const groups = navigations.toReversed().map((navigation, index) => {
      const group = tool.make('section', 'group')
      const heading = tool.make('h3', 'heading', `${index === 0 ? 'This page' : 'Before'}, ${navigation.path === '' ? 'loading' : navigation.path}`)
      const list = tool.make('div', 'list')

      heading.append(pill(tool, String(navigation.fetches.length + navigation.more)))
      list.append(...navigation.fetches.toSorted((a, b) => a.startTime - b.startTime).map(fetched => fetchRow(tool, fetched, navigation.start, win)))
      group.append(heading, navigation.fetches.length === 0 ? tool.make('div', 'note', 'Nothing fetched.') : list)

      if (navigation.more > 0)
        group.append(tool.make('div', 'note', `${navigation.more} more not listed.`))

      return group
    })

    content.replaceChildren(...groups, bar.empty)
    bar.apply(content)
  }

  const [loaded] = win.performance.getEntriesByType('navigation') as PerformanceResourceTiming[]

  if (loaded !== undefined)
    add(loaded)

  try {
    const observer = new win.PerformanceObserver((list) => {
      for (const fetched of list.getEntries())
        add(fetched as PerformanceResourceTiming)

      changed()
    })

    observer.observe({ type: 'resource', buffered: true })
    signal.addEventListener('abort', () => observer.disconnect())
  }
  catch {
    // A browser without Resource Timing lists the document alone.
  }

  // A swap opens a navigation as it starts, so the page it fetches lands in it, and names it once it ends.
  const swaps = new MutationObserver(() => {
    const busy = doc.documentElement.getAttribute('aria-busy') === 'true'
    const last = navigations.at(-1)!

    if (busy && last.path !== '') {
      navigations.push({ path: '', start: win.performance.now(), fetches: [], more: 0 })

      if (navigations.length > MAX_NAVIGATIONS)
        navigations.shift()
    }
    else if (!busy && last.path === '') {
      last.path = here()
    }

    changed()
  })

  swaps.observe(doc.documentElement, { attributes: true, attributeFilter: ['aria-busy'] })
  signal.addEventListener('abort', () => swaps.disconnect())
  tab.panel.append(bar.element, content)
  changed()
}

// The status a request was answered with, 0 when the browser does not tell, as for another site's answer.
function statusOf(fetched: PerformanceResourceTiming): number {
  return 'responseStatus' in fetched && typeof fetched.responseStatus === 'number' ? fetched.responseStatus : 0
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

// What a request brought, as the bytes on the wire or from the cache; nothing when the browser does not tell, as for another site's answer.
function fetchedSize(fetched: PerformanceResourceTiming): string[] {
  if (fetched.transferSize === 0 && fetched.decodedBodySize > 0)
    return ['from the cache']

  return fetched.encodedBodySize > 0 ? [formatBytes(fetched.encodedBodySize)] : []
}

function fetchRow(tool: DevTool, fetched: PerformanceResourceTiming, start: number, win: Window): HTMLElement {
  const url = new URL(fetched.name)
  const status = statusOf(fetched)
  const kind = fetchKind(fetched, url)
  const name = url.origin === win.location.origin ? `${url.pathname}${url.search}` : fetched.name
  const chips = [kind, ...fetchedSize(fetched), formatMs(fetched.duration), `at ${formatMs(Math.max(0, fetched.startTime - start))}`]
  const after = [...status === 0 ? [] : [pill(tool, String(status), status >= 400 ? 'error' : 'ok')], copyButton(tool, 'the address', fetched.name)]

  return filterable(entry(tool, 'fetch', { name, after, chips }), `${name} ${kind} ${status}`, status >= 400)
}

// What a search result shows of a title before cutting it.
const TITLE_LENGTH = 60

// A length against the limit search results cut at, the bar full and amber once past it; the length alone when the limit is not known.
function meter(tool: DevTool, length: number, limit?: number): HTMLElement {
  const over = limit !== undefined && length > limit
  const element = tool.make('span', over ? 'meter over' : 'meter')
  const track = tool.make('span', 'track')

  if (limit === undefined) {
    element.append(tool.make('span', 'n', `${length} characters`))

    return element
  }

  const fill = tool.make('i')

  fill.style.width = `${Math.min(100, length / limit * 100)}%`
  track.append(fill)
  element.append(track, tool.make('span', 'n', `${length} / ${limit}${over ? ', cut in results' : ''}`))

  return element
}

// A JSON-LD block named by its type and what it is about, as `BlogPosting · Bonjour kay`.
function ldSummary(data: unknown): string {
  const first = (Array.isArray(data) ? data[0] : data) as { '@type'?: unknown, 'headline'?: unknown, 'name'?: unknown } | null
  const type = Array.isArray(first?.['@type']) ? (first['@type'] as unknown[]).join(', ') : first?.['@type']
  const about = first?.headline ?? first?.name

  return [type, about].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ') || 'JSON-LD block'
}

// A tag of the page's head, by its `name` or `property`.
function metaContent(head: HTMLHeadElement, key: string): string | undefined {
  const content = head.querySelector(`meta[name="${key}"],meta[property="${key}"]`)?.getAttribute('content')?.trim()

  return content === '' ? undefined : content
}

// The page's head as it is now: the search result it makes, its title, description, canonical link, alternates and robots tag, its og and twitter tags with the card image, and its JSON-LD blocks, each parsed or with its error; what `kay check` would flag in it comes from the server, which also says whether the sitemap lists the page. Read as the tab shows and again after each page swap.
function headTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'head', label: 'Head', icon: 'scan-search', shown: () => reread() })
  const content = tool.make('div', 'stack')
  const bar = toolbar(tool, 'Filter tags and JSON-LD', () => bar.apply(content), true)
  // A swap while a fetch is out asks again; the latest answer wins.
  let asked = 0
  const read = async () => {
    const ask = ++asked
    // One snapshot of the head, so a swap during the fetch cannot mix two heads in what is shown.
    const head = doc.head.cloneNode(true) as HTMLHeadElement
    const href = win.location.href
    const path = win.location.pathname
    const title = head.querySelector('title')?.textContent?.trim() ?? ''
    const description = metaContent(head, 'description')
    const canonical = head.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? undefined
    let server: DevHead | undefined
    let failure: string | undefined

    try {
      const response = await ownFetch(win, HEAD_URL, { method: 'POST', headers: { 'content-type': 'application/json', [HEAD_HEADER]: '1' }, body: JSON.stringify({ path, head: head.outerHTML }), cache: 'no-store' })

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      server = await response.json() as DevHead
    }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (ask !== asked)
      return

    const limit = server?.descriptionLength
    const children: Node[] = []
    const facts = tool.make('dl', 'facts')
    const fact = (term: string, ...values: (Node | string)[]) => {
      const value = tool.make('dd')

      value.append(...values)
      facts.append(filterable(tool.make('dt', '', term), `${term} ${value.textContent}`), filterable(value, `${term} ${value.textContent}`))
    }
    const none = () => tool.make('span', 'note', 'none')
    const problems = server?.problems ?? []

    tab.count(problems.length, problems.some(problem => problem.severity === 'error') ? 'error' : 'warn')

    if (failure !== undefined)
      children.push(tool.make('div', 'empty', `Could not check the head: ${failure}`))

    if (problems.length > 0) {
      const list = tool.make('div', 'list')

      for (const problem of problems) {
        const error = problem.severity === 'error'
        const element = tool.make('div', `problem ${error ? 'error' : 'warn'}`)

        const text = [problem.message, problem.note, problem.help === undefined ? undefined : `help: ${problem.help}`].filter(Boolean).join('\n')

        const pre = tool.make('pre', 'mono')

        pre.append(...withPositions(text, tool))
        element.append(tool.icon(error ? 'circle-x' : 'triangle-alert'), pre)
        list.append(filterable(element, text, true))
      }

      children.push(list)
    }

    const snippet = tool.make('div', 'preview serp')
    const clipped = limit !== undefined && description !== undefined && description.length > limit ? `${description.slice(0, limit).trimEnd()}...` : description
    const previews = plain(tool.make('div', 'previews'))
    const share = tool.make('div', 'preview')

    snippet.append(
      tool.make('span', 'cap', 'In search results'),
      tool.make('span', 'site', canonical ?? href),
      tool.make('span', 't', title === '' ? 'No title' : title),
      tool.make('span', 'd', clipped ?? 'No description'),
    )
    share.append(tool.make('span', 'cap', 'Share card, og:image'))
    previews.append(snippet, share)
    children.push(previews)

    fact('Title', ...title === '' ? [none()] : [title, meter(tool, title.length, TITLE_LENGTH)])
    fact('Description', ...description === undefined ? [none()] : [description, meter(tool, description.length, limit)])
    fact('Canonical', ...canonical === undefined ? [none()] : [tool.make('span', 'mono', canonical), copyButton(tool, 'the canonical URL', canonical)])

    const alternates = [...head.querySelectorAll('link[rel="alternate"][hreflang]')].map(link => `${link.getAttribute('hreflang')}: ${link.getAttribute('href')}`)
    const chips = tool.make('span', 'chips')

    chips.append(...alternates.map(line => tool.make('span', 'chip', line)))
    fact('Alternates', alternates.length === 0 ? none() : chips)
    fact('Robots', metaContent(head, 'robots') ?? tool.make('span', 'note', 'no tag, indexable'))

    if (server !== undefined) {
      let sitemap: HTMLElement = server.sitemap === 'listed' ? pill(tool, 'listed', 'ok') : pill(tool, 'not listed')

      if (server.sitemap === 'error')
        sitemap = tool.make('span', 'error', `could not be read: ${server.sitemapError ?? 'unknown error'}`)
      else if (server.sitemap === 'none')
        sitemap = tool.make('span', 'note', 'none, the site has no origin (set site in kay.config.ts, SITE_URL or ORIGIN)')

      fact('Sitemap', sitemap)
    }

    const tags = plain(tool.make('section', 'group'))

    tags.append(tool.make('h3', 'heading', 'Tags'), facts)
    children.push(tags)

    for (const [heading, prefix] of [['Open Graph', 'og:'], ['Twitter', 'twitter:']] as const) {
      const found = [...head.querySelectorAll('meta')].flatMap((meta) => {
        const key = meta.getAttribute('property') ?? meta.getAttribute('name') ?? ''

        return key.startsWith(prefix) ? [[key, meta.getAttribute('content') ?? ''] as const] : []
      })
      const group = plain(tool.make('section', 'group'))
      const table = tool.make('table', 'kv')
      const title = tool.make('h3', 'heading', heading)

      for (const [key, tagValue] of found) {
        const row = tool.make('tr')

        const value = tool.make('td', '', tagValue)

        if (WEB_URL.test(tagValue))
          value.append(copyButton(tool, `the ${key} URL`, tagValue))

        row.append(tool.make('td', '', key), value)
        table.append(filterable(row, `${key} ${tagValue}`))
      }

      title.append(pill(tool, String(found.length)))
      group.append(title, found.length === 0 ? tool.make('div', 'note', 'No tags.') : table)
      children.push(group)
    }

    const image = metaContent(head, 'og:image') ?? metaContent(head, 'twitter:image')

    if (image === undefined) {
      share.append(tool.make('span', 'note', 'No og:image or twitter:image tag.'))
    }
    else {
      try {
        const url = new URL(image, href)
        const card = tool.make('img', 'card')

        // The site's own origin is not the dev server's, so the card is read from here.
        card.src = server?.site !== undefined && url.origin === new URL(server.site).origin ? `${win.location.origin}${url.pathname}${url.search}` : url.href
        card.alt = 'The social card image'
        share.append(card)
      }
      catch {
        share.append(tool.make('div', 'error', `The social card image is not a valid URL: ${image}`))
      }
    }

    const blocks = [...head.querySelectorAll('script[type="application/ld+json"]')]
    const ld = plain(tool.make('section', 'group'))
    const ldHeading = tool.make('h3', 'heading', 'JSON-LD')

    ldHeading.append(pill(tool, String(blocks.length)))
    ld.append(ldHeading)

    for (const block of blocks) {
      try {
        const data = JSON.parse(block.textContent ?? '') as unknown
        const details = tool.make('details', 'json')
        const summary = tool.make('summary', '', ldSummary(data))

        const json = JSON.stringify(data, null, 2)

        details.append(summary, tool.make('pre', 'mono', json))
        ld.append(filterable(details, `${summary.textContent} ${json}`))
      }
      catch (error) {
        const text = `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`

        ld.append(filterable(tool.make('div', 'error', text), text, true))
      }
    }

    if (blocks.length === 0)
      ld.append(tool.make('div', 'note', 'None.'))

    children.push(ld)
    content.replaceChildren(...children, bar.empty)
    bar.apply(content)
  }

  reread = () => void read()
  tab.panel.append(bar.element, content)
  let scheduled = false
  // A page swap patches the head in place, in many small changes: one read follows them.
  const swaps = new MutationObserver(() => {
    if (tab.panel.hidden === true || scheduled)
      return

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      void read()
    })
  })

  swaps.observe(doc.head, { childList: true, subtree: true, characterData: true, attributes: true })
  signal.addEventListener('abort', () => swaps.disconnect())
}

// Names a variable of a secret goes by, and the shapes of the values of one: a URL carrying a password, a token with a well-known prefix, a long run of random-looking characters.
const SECRET_NAME = /SECRET|PASSW(?:OR)?D|PRIVATE|TOKEN|CREDENTIAL|AUTH_?(?:KEY|TOKEN|SECRET)|(?:^|_)(?:DATABASE|DB|POSTGRES|PG|MYSQL|REDIS|MONGO(?:DB)?)_URL$/i
// A key may be public by design (a map or analytics key), so its name alone only calls for a look.
const KEY_NAME = /(?:^|_)KEY$/i
const PUBLIC_NAME = /PUBLIC|PUBLISHABLE/i
const SECRET_PREFIX = /^(?:sk|rk)_(?:live|test)_|^sk-|^gh[pousr]_|^github_pat_|^glpat-|^npm_|^SG\.|^xox[abprs]-|^AKIA[0-9A-Z]{16}|^eyJ[\w-]+\.[\w-]+\.|^-----BEGIN /
const URL_PASSWORD = /^[a-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const HEX_SECRET = /^[0-9a-f]{32,}$/i
const RANDOM_LIKE = /^[\w+/=.-]{24,}$/
// Bits per character of a run of random base64 sits near 5; words and paths stay under 4.
const RANDOM_ENTROPY = 4

function entropy(value: string): number {
  const counts = new Map<string, number>()

  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1)

  return -[...counts.values()].reduce((sum, count) => sum + count / value.length * Math.log2(count / value.length), 0)
}

// Why a public variable looks like a secret, if it does; `maybe` when only its name is a key's, which may be public by design.
function secretReason(name: string, value: unknown): { reason: string, maybe: boolean } | undefined {
  if (SECRET_NAME.test(name))
    return { reason: 'its name looks like a secret', maybe: false }

  if (typeof value === 'string') {
    if (URL_PASSWORD.test(value))
      return { reason: 'its value is a URL with a password', maybe: false }

    if (SECRET_PREFIX.test(value))
      return { reason: 'its value looks like a token', maybe: false }

    if (HEX_SECRET.test(value))
      return { reason: 'its value is a long hexadecimal string, like a token', maybe: false }

    // A path or a URL has slashes in the places a base64 string has none.
    if (RANDOM_LIKE.test(value) && !value.startsWith('/') && !value.includes('://') && entropy(value) >= RANDOM_ENTROPY)
      return { reason: 'its value looks random, like a key', maybe: false }
  }

  return KEY_NAME.test(name) && !PUBLIC_NAME.test(name) ? { reason: 'its name is a key\'s, which is fine if the key is public by design, such as a map\'s', maybe: true } : undefined
}

// The variables `publicEnv` sends every visitor, read from the module the browser loads, so a secret declared public is seen; fetched as the tab shows and again after each restart.
function envTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'env', label: 'Env', icon: 'key-round', shown: () => reread() })
  const content = tool.make('div', 'stack')
  const bar = toolbar(tool, 'Filter by name or value', () => bar.apply(content))
  let asked = 0
  const read = async () => {
    const ask = ++asked
    let values: Record<string, unknown> | undefined
    let failure: string | undefined

    try {
      const response = await ownFetch(win, ENV_URL, { cache: 'no-store' })

      // The route is there only when `publicEnv` is declared; any other answer is a failure to read it.
      if (response.status !== 404) {
        if (!response.ok)
          throw new Error(`the server answered ${response.status}`)

        const text = await response.text()

        if (!(response.headers.get('content-type') ?? '').includes('javascript') || !text.startsWith(MODULE_START))
          throw new Error('the module is not the one kay sends')

        values = JSON.parse(text.slice(MODULE_START.length)) as Record<string, unknown>
      }
    }
    catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    if (ask !== asked)
      return

    bar.element.hidden = values === undefined || Object.keys(values).length === 0

    if (failure !== undefined) {
      tab.count(0)
      content.replaceChildren(tool.make('div', 'empty', `Could not read the public env: ${failure}`))

      return
    }

    if (values === undefined) {
      tab.count(0)
      content.replaceChildren(tool.make('div', 'empty', 'This app sends no public env to the browser: kay.config.ts declares no `publicEnv`.'))

      return
    }

    const entries = Object.entries(values)
    const list = tool.make('div')
    let flagged = 0

    for (const [name, value] of entries) {
      const found = secretReason(name, value)
      const secret = found !== undefined && !found.maybe
      const shown = typeof value === 'string' ? value : JSON.stringify(value)

      if (secret)
        flagged++

      list.append(filterable(entry(tool, 'env', {
        name,
        after: [tool.make('span', 'val', shown), copyButton(tool, `the value of ${name}`, shown)],
        issues: secret ? [{ text: `Every visitor reads this, and ${found.reason}. Keep a secret in defineEnv, read on the server alone.`, tone: 'error', icon: 'lock' }] : [],
        note: found?.maybe === true ? `Every visitor reads this: ${found.reason}.` : undefined,
      }), `${name} ${shown}`))
    }

    tab.count(flagged, flagged > 0 ? 'error' : undefined)
    content.replaceChildren(tool.make('div', 'note', `${entries.length} variable${entries.length === 1 ? '' : 's'} sent to every visitor at ${ENV_URL}.`), entries.length === 0 ? tool.make('div', 'empty', 'The app sends no public env: `publicEnv` declares no variable.') : list, bar.empty)
    bar.apply(content)
  }

  reread = () => void read()
  tab.panel.append(bar.element, content)
  win.addEventListener(BUILT_EVENT, () => {
    if (tab.panel.hidden === false)
      reread()
  }, { signal })
}

// An image served more than this many times the pixels it is drawn with is flagged: the ladder's widths are at most 2 apart, so a variant picked for the size drawn is under 2 times as wide, 4 times the pixels, even at its worst.
const OVERSIZED = 4
const IMAGE_ROUTE = '/_kay/image'
const SVG_TYPE = /^image\/svg\+xml\s*(?:;|$)/i
// The files `kay build` wrote for the variants.
const IMAGE_FILES = '/_kay/images/'
// How many formats are asked of the server at once, and how long one gets.
const IMAGE_REQUESTS = 4
const IMAGE_REQUEST_MS = 3000
const VARIANT_FILE = /-(card|\d+)(?:-(\d+x\d+))?\.(?:webp|avif|jpg)$/
// The accept header browsers send for an image, which the image route picks AVIF or WebP from.
const IMAGE_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'

interface ImageInfo {
  image: HTMLImageElement
  // The URL in use, shortened to its path and the `src` of the image route.
  url: string
  // The address the browser loaded.
  src: string
  variant: string
  natural: string
  drawn: string
  // What is wrong with it, one sentence each.
  flags: string[]
  lcp: boolean
}

function parseUrl(src: string, base: string): URL | undefined {
  try {
    return new URL(src, base)
  }
  catch {
    return undefined
  }
}

// A URL's path with its percent-encoding read; a name that is not valid percent-encoding is read as it is.
function decodedPath(url: URL): string {
  try {
    return decodeURIComponent(url.pathname)
  }
  catch {
    return url.pathname
  }
}

// What kay's URL for an image says it is: a width of the ladder, a crop, the share card, a file `kay build` wrote, or an image kay did not resize.
function imageVariant(src: string, origin: string): string {
  const url = parseUrl(src, origin)

  if (url === undefined || url.origin !== origin)
    return 'not resized by kay'

  if (url.pathname === IMAGE_ROUTE) {
    const crop = url.searchParams.get('crop')

    return url.searchParams.has('card') ? 'share card, 1200x630, resized on request' : `${url.searchParams.get('w') ?? 'original'}w${crop === null ? '' : `, cut ${crop}`}, resized on request`
  }

  const path = decodedPath(url)

  const file = VARIANT_FILE.exec(path)

  if (path.startsWith('/_kay/images/') && file)
    return `${file[1] === 'card' ? 'share card' : `${file[1]}w`}${file[2] === undefined ? '' : `, cut ${file[2]}`}, written by kay build`

  return 'not resized by kay'
}

// Whether an image is an SVG: a path ending in `.svg` whatever its query or hash, else the content type its fetch answered, as Resource Timing kept it, since asking again could run the app's own handler. The browser gives an SVG without a size a natural size of 150x150, and an SVG draws at any size from the same bytes, so its natural size says nothing about what was served.
function isVector(src: string, win: Window & typeof globalThis): boolean {
  const url = parseUrl(src, win.location.href)

  if (url === undefined)
    return false

  if (decodedPath(url).toLowerCase().endsWith('.svg'))
    return true

  url.hash = ''

  return win.performance.getEntriesByName(url.href, 'resource').some(entry => 'contentType' in entry && typeof entry.contentType === 'string' && SVG_TYPE.test(entry.contentType))
}

// Every image of the page with what it is, what it is drawn at and what is wrong with it; `lcp` is the element the browser reported as the largest paint.
function pageImages(doc: Document, lcp: Element | undefined): ImageInfo[] {
  const win = doc.defaultView!
  const density = win.devicePixelRatio || 1
  // Chromium reports a zoom's density as a float, 1.2000000476837158 at 120%.
  const shown = Number(density.toFixed(2))

  return [...doc.querySelectorAll('img')].flatMap((image) => {
    const src = image.currentSrc === '' ? image.getAttribute('src') : image.currentSrc

    if (src === null || src === '' || src.startsWith('data:'))
      return []

    const box = image.getBoundingClientRect()
    const flags: string[] = []
    const served = image.naturalWidth * image.naturalHeight
    const needed = box.width * box.height * density * density

    if (served > 0 && needed > 0 && served > needed * OVERSIZED && !isVector(src, win))
      flags.push(`served ${Math.round(served / needed)} times the pixels it is drawn with, give it a smaller width or \`sizes\``)

    if (!image.hasAttribute('width') || !image.hasAttribute('height'))
      flags.push('no width and height, so the page shifts as it loads')

    if (image.loading === 'lazy' && box.bottom > 0 && box.top < win.innerHeight && box.right > 0 && box.left < win.innerWidth)
      flags.push('lazy-loaded but in view, which delays it')

    return [{
      image,
      url: src.replace(win.location.origin, ''),
      src,
      variant: imageVariant(src, win.location.origin),
      natural: image.naturalWidth > 0 ? `${image.naturalWidth}x${image.naturalHeight}` : 'not loaded',
      drawn: `${Math.round(box.width)}x${Math.round(box.height)}${shown === 1 ? '' : ` at ${shown}x`}`,
      flags,
      lcp: image === lcp,
    }]
  })
}

// The Web Vitals "good" and "poor" limits: a value up to the first is good, past the second poor.
const VITAL_LIMITS = { lcp: [2500, 4000], cls: [0.1, 0.25], inp: [200, 500] } as const
// A new window of layout shifts starts after a gap this long, and one never lasts past the second.
const SHIFT_GAP_MS = 1000
const SHIFT_WINDOW_MS = 5000

type VitalName = keyof typeof VITAL_LIMITS

interface Vitals {
  // The page the browser loaded them for: a link swapping in another page starts no new load.
  path: string
  // The largest paint so far, the element it painted when it is on the page.
  lcp?: { ms: number, element: Element | undefined } | undefined
  cls: number
  inp?: number | undefined
  // Called with the vital that changed.
  changed: ((name: VitalName) => void)[]
}

function rateVital(name: VitalName, value: number): 'good' | 'needs' | 'poor' {
  const [good, poor] = VITAL_LIMITS[name]

  if (value <= good)
    return 'good'

  return value <= poor ? 'needs' : 'poor'
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

// The images of the page: the variant and format each got, the size served against the size drawn, which one is the largest paint, and what is wrong with it; hovering or focusing a row outlines the image, and the list is read again as the tab shows and as the page changes under it.
function imagesTab(doc: Document, tool: DevTool, vitals: Vitals, signal: AbortSignal): void {
  const win = doc.defaultView!
  let asked = 0
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'images', label: 'Images', icon: 'image', shown: () => reread() })
  const content = tool.make('div', 'stack')
  const bar = toolbar(tool, 'Filter by address, variant or problem', () => bar.apply(content), true)
  // What the server answered an image with, by address, until the next rebuild; a failed lookup is kept too, so a reread does not send one more request per failing image.
  const answers = new Map<string, Promise<string>>()
  const slots = limiter(IMAGE_REQUESTS)
  let scheduled = false
  const schedule = () => {
    if (tab.panel.hidden === true || scheduled)
      return

    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      reread()
    })
  }

  vitals.changed.push((name) => {
    if (name === 'lcp')
      schedule()
  })

  const read = async () => {
    const ask = ++asked
    const images = pageImages(doc, vitals.lcp?.element?.isConnected === true ? vitals.lcp.element : undefined)
    const body = tool.make('div')
    const formats: HTMLElement[] = []
    const flagged = images.filter(info => info.flags.length > 0).length

    tab.count(images.reduce((sum, info) => sum + info.flags.length, 0), flagged > 0 ? 'warn' : undefined)
    tool.hideOutline()

    bar.element.hidden = images.length === 0

    if (images.length === 0) {
      content.replaceChildren(tool.make('div', 'empty', 'No images on this page.'))

      return
    }

    // Copies of one image drawn at one size share a row, as the logo of a header and a footer would, with what is wrong with any of them.
    const copies = new Map<string, ImageInfo[]>()

    for (const info of images) {
      const key = JSON.stringify([info.src, info.variant, info.drawn])
      const same = copies.get(key)

      if (same === undefined)
        copies.set(key, [info])
      else
        same.push(info)
    }

    const rows = [...copies.values()]

    for (const same of rows) {
      const info = same[0]!
      const lcp = same.some(copy => copy.lcp)
      const thumb = tool.make('img', 'thumb')
      const format = tool.make('span', 'chip', 'format...')
      const label = lcp ? 'largest paint' : 'image'
      const issues = [...new Set(same.flatMap(copy => copy.flags))]
      const row = entry(tool, 'image', {
        lead: thumb,
        name: info.url,
        after: [...lcp ? [pill(tool, 'largest paint', 'accent')] : [], ...same.length > 1 ? [pill(tool, `${same.length} copies`)] : [], copyButton(tool, 'the address', info.src)],
        chips: [info.variant, format, info.natural === 'not loaded' ? `not loaded, drawn ${info.drawn}` : `${info.natural} drawn ${info.drawn}`],
        issues: issues.map(text => ({ text, tone: 'warn' as const })),
      })

      formats.push(format)
      thumb.src = info.src
      thumb.alt = ''
      thumb.loading = 'lazy'
      thumb.decoding = 'async'
      row.tabIndex = 0
      row.setAttribute('role', 'group')
      row.setAttribute('aria-label', same.length > 1 ? `${info.url}, ${same.length} copies` : info.url)
      row.onpointerenter = row.onfocus = () => tool.outline(same.map(copy => copy.image), label)
      row.onpointerleave = row.onblur = () => tool.hideOutline()
      body.append(filterable(row, [info.url, info.variant, ...issues].join(' '), issues.length > 0))
    }

    content.replaceChildren(tool.make('div', 'note', `${images.length} image${images.length === 1 ? '' : 's'}, ${flagged} to look at`), body, bar.empty, tool.make('div', 'note', 'Formats are those the server picks for a browser accepting AVIF and WebP. Those of images kay does not serve are not looked up, as asking could run the app\'s own handler.'))
    bar.apply(content)

    // An image the server is not asked about answers at once; the others go a few at a time, so a page of many images does not ask the server for all of them at once, and one that hangs holds back one slot only.
    await Promise.all(rows.map(async (same, index) => {
      const info = same[0]!
      let text = unaskedFormat(win, info.image, info.src)

      if (text === undefined) {
        let answer = answers.get(info.src)

        if (answer === undefined) {
          answer = slots(async () => askedFormat(win, info.src))
          answers.set(info.src, answer)
        }

        text = await answer
      }

      if (ask === asked)
        formats[index]!.textContent = text
    }))
  }

  reread = () => void read()
  tab.panel.append(bar.element, content)
  doc.addEventListener('load', schedule, { capture: true, signal })
  doc.addEventListener('error', schedule, { capture: true, signal })
  win.addEventListener(BUILT_EVENT, () => {
    answers.clear()
    schedule()
  }, { signal })

  const changes = new MutationObserver(schedule)

  changes.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'sizes', 'loading', 'width', 'height'] })
  signal.addEventListener('abort', () => changes.disconnect())
}

// A limit on how many calls of a kind run at once; the rest wait their turn.
function limiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: (() => void)[] = []

  return async (run) => {
    if (running >= max)
      await new Promise<void>(resolve => waiting.push(resolve))

    running++

    try {
      return await run()
    }
    finally {
      running--
      waiting.shift()?.()
    }
  }
}

// The format of an image the server is not asked about, or undefined for one that is. Only an image of kay's own routes loaded by the page is asked, with a HEAD request: the route's code is kay's, it writes no variant the page did not already draw, and the type is negotiated so the URL does not say it. Any other image could run the app's own handler, so its size comes from the browser's resource timing and its format is not looked up.
function unaskedFormat(win: Window & typeof globalThis, image: HTMLImageElement, src: string): string | undefined {
  // The page's policy lets it ask its own origin only.
  const url = parseUrl(src, win.location.href)

  if (url === undefined)
    return 'format unknown'

  if (url.origin !== win.location.origin)
    return 'on another host'

  if (url.pathname !== IMAGE_ROUTE && !url.pathname.startsWith(IMAGE_FILES))
    return `format not looked up${transferred(win, url.href)}`

  return !image.complete || image.naturalWidth === 0 ? 'not loaded' : undefined
}

// The format and size the server gives an image of kay's routes.
async function askedFormat(win: Window & typeof globalThis, src: string): Promise<string> {
  try {
    const response = await ownFetch(win, src, { method: 'HEAD', headers: { accept: IMAGE_ACCEPT }, cache: 'no-store', signal: AbortSignal.timeout(IMAGE_REQUEST_MS) })
    const type = response.headers.get('content-type') ?? ''

    if (!response.ok)
      return `the server answered ${response.status}`

    const format = type.startsWith('image/') ? type.slice('image/'.length) : 'not an image'
    const bytes = Number(response.headers.get('content-length'))

    return bytes > 0 ? `${format}, ${formatBytes(bytes)}` : format
  }
  catch {
    return 'format unknown'
  }
}

// What the browser says it downloaded for an address, as ` - 12.0 KB`; nothing when it did not report it.
function transferred(win: Window & typeof globalThis, href: string): string {
  const entry = win.performance.getEntriesByName(href, 'resource').at(-1) as PerformanceResourceTiming | undefined

  return entry !== undefined && entry.encodedBodySize > 0 ? `, ${formatBytes(entry.encodedBodySize)}` : ''
}

interface BuiltSizes {
  route: string
  js: number
  css: number
  estimated: boolean
  exported: boolean
  built: number
}

// What the last `kay build` measured for this page's route, which the server reads from the report kept under `.kay`; nothing when no build was made or the route is not in it.
async function builtSizes(win: Window & typeof globalThis): Promise<BuiltSizes | undefined> {
  try {
    const response = await ownFetch(win, `${SIZES_URL}?path=${encodeURIComponent(win.location.pathname)}`, { headers: { [HEAD_HEADER]: '1' }, cache: 'no-store', signal: AbortSignal.timeout(IMAGE_REQUEST_MS) })

    return response.ok ? ((await response.json()) as { sizes?: BuiltSizes }).sizes : undefined
  }
  catch {
    return undefined
  }
}

// How long ago, in the largest whole unit.
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)

  if (minutes < 1)
    return 'less than a minute ago'

  if (minutes < 60)
    return `${minutes} min ago`

  if (minutes < 1440)
    return `${Math.floor(minutes / 60)} h ago`

  const days = Math.floor(minutes / 1440)

  return days === 1 ? '1 day ago' : `${days} days ago`
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

// The gzipped size of some text, as a server would send it.
async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))

  return (await new Response(stream).arrayBuffer()).byteLength
}

// The page's HTML as the browser holds it, without the dev tool: what the server sent, as live reload and swaps changed it, so the server renders nothing again.
function deliveredHtml(doc: Document): string {
  const copy = doc.documentElement.cloneNode(true) as HTMLElement

  for (const host of copy.querySelectorAll(HOST))
    host.remove()

  return `<!doctype html>${copy.outerHTML}`
}

interface Weight {
  html: number
  css: { url: string, bytes: number }[]
  entry: { url: string, bytes: number }[]
  islands: { url: string, bytes: number }[]
  other: { url: string, bytes: number }[]
}

// A built file's name without its hash, `counter` of `counter-48rr5xzz.js`.
const HASHED_NAME = /^(.*)-[a-z\d]{8}\.(?:js|css)$/
const DIRECTORY_PREFIX = /^.*\//
const KAY_SUFFIX = /\.kay$/
const SCRIPT_OR_STYLE = /\.(?:js|css)$/

// The page's HTML (the document the browser holds), the stylesheets and scripts it loaded gzipped, as sent in development: not minified, with the dev-only code, so larger than `kay build` makes them. The dev tool's own scripts, the live reload and the public env stay out; a file rebuilt since it first loaded counts once, in its latest form, and a stylesheet only while the page links it.
async function pageWeight(doc: Document): Promise<Weight> {
  const win = doc.defaultView!
  const here = win.location.origin
  const linked = new Set([...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map(link => new URL(link.href, here).pathname))
  const latest = new Map<string, string>()
  const components = new Set([...doc.querySelectorAll('[data-component]')].map(element => (element.getAttribute('data-component') ?? '').replace(DIRECTORY_PREFIX, '').replace(KAY_SUFFIX, '')))

  for (const entry of win.performance.getEntriesByType('resource')) {
    const url = parseUrl(entry.name, here)

    if (url === undefined || url.origin !== here || !SCRIPT_OR_STYLE.test(url.pathname) || url.pathname.startsWith('/_kay/dev/') || url.pathname === '/_kay/env.js')
      continue

    if (url.pathname.endsWith('.css') && !linked.has(url.pathname))
      continue

    const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    const name = HASHED_NAME.exec(file)?.[1]

    // Later entries are later loads: the hash of the entry or an island rebuilt since replaces the one before. Any other file keeps its address, as a name ending in 8 letters, `chart-calendar.js`, may not be hashed at all.
    latest.set(name === undefined || !(name === 'entry' || components.has(name)) ? url.pathname : `${url.pathname.slice(0, url.pathname.length - file.length)}${name}.${file.slice(file.lastIndexOf('.') + 1)}`, url.pathname)
  }

  const sized = async (url: string, accept = '*/*') => {
    const response = await ownFetch(win, url, { headers: { accept } })

    if (!response.ok)
      throw new Error(`${url} answered ${response.status}`)

    return gzipSize(await response.text())
  }
  const settled = await Promise.allSettled([...latest.values()].map(async url => ({ url, bytes: await sized(url) })))
  const files = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const isEntry = (url: string) => url.slice(url.lastIndexOf('/') + 1).startsWith('entry-')
  const isIsland = (url: string) => components.has(HASHED_NAME.exec(url.slice(url.lastIndexOf('/') + 1))?.[1] ?? '')
  const scripts = files.filter(file => file.url.endsWith('.js'))

  return {
    html: await gzipSize(deliveredHtml(doc)),
    css: files.filter(file => file.url.endsWith('.css')),
    entry: scripts.filter(file => isEntry(file.url)),
    islands: scripts.filter(file => !isEntry(file.url) && isIsland(file.url)),
    other: scripts.filter(file => !isEntry(file.url) && !isIsland(file.url)),
  }
}

// How far past the poor limit a vital's scale reaches.
const SCALE_PAST_POOR = 1.25

// A vital's value as its digits and its unit, and a limit as a tick under its scale.
function vitalDigits(name: VitalName, value: number): [string, string] {
  return name === 'cls' ? [value.toFixed(3), ''] : [String(Math.round(value)), 'ms']
}

function vitalTick(name: VitalName, limit: number): string {
  return name !== 'cls' && limit >= 1000 ? `${limit / 1000} s` : String(limit)
}

// The page's weight and Web Vitals: LCP, CLS and INP each as a tile with its scale, good and poor limits marked, as the page is used, and the HTML, CSS and JS gzipped as bars, the island chunks split from the entry.
function performanceTab(doc: Document, tool: DevTool, vitals: Vitals, signal: AbortSignal): void {
  let scheduled = false
  let reread: () => void = () => undefined
  const tab = tool.tab({ id: 'performance', label: 'Performance', icon: 'gauge', shown: () => reread() })
  const vitalsPanel = tool.make('div', 'vitals')
  const weightPanel = tool.make('section', 'group')
  const loadNote = tool.make('div', 'note')
  let asked = 0
  const vital = (name: VitalName, label: string, value: number | undefined, detail?: string) => {
    const [good, poor] = VITAL_LIMITS[name]
    const tile = tool.make('div', 'vital')
    const top = tool.make('div', 'top')
    const number = tool.make('span', 'num')
    const box = tool.make('div', 'scalebox')
    const scale = tool.make('div', 'scale')
    const reach = poor * SCALE_PAST_POOR
    const part = (className: string, from: number, to: number) => {
      const segment = tool.make('i', className)

      segment.style.width = `${(to - from) / reach * 100}%`
      scale.append(segment)
    }
    const tick = (limit: number) => {
      const element = tool.make('span', 'tick', vitalTick(name, limit))

      element.style.left = `${limit / reach * 100}%`
      box.append(element)
    }

    top.append(tool.make('span', 'name', label))
    part('g', 0, good)
    part('n', good, poor)
    part('p', poor, reach)
    box.append(scale)
    tick(good)
    tick(poor)

    if (value === undefined) {
      number.append(tool.make('span', 'note', name === 'inp' ? 'no interaction yet' : 'not reported yet'))
    }
    else {
      const rating = rateVital(name, value)
      const [digits, unit] = vitalDigits(name, value)
      const marker = tool.make('span', 'mk')

      marker.style.left = `${Math.min(100, value / reach * 100)}%`
      box.append(marker)
      top.append(pill(tool, rating === 'needs' ? 'needs work' : rating, RATING_TONES[rating]))
      number.append(digits)

      if (unit !== '')
        number.append(tool.make('small', '', unit))
    }

    tile.append(top, number, box)

    if (detail !== undefined && value !== undefined)
      tile.append(tool.make('span', 'note', detail))

    vitalsPanel.append(tile)
  }
  const renderVitals = () => {
    const element = vitals.lcp?.element
    const painted = element === undefined ? undefined : `${element.localName}${element.id === '' ? '' : `#${element.id}`}`
    const rated = [vitals.lcp?.ms === undefined ? undefined : rateVital('lcp', vitals.lcp.ms), vitals.inp === undefined ? undefined : rateVital('inp', vitals.inp), rateVital('cls', vitals.cls)]
    const bad = rated.filter(rating => rating !== undefined && rating !== 'good')

    loadNote.textContent = doc.defaultView!.location.pathname === vitals.path ? `Measured on the load of ${vitals.path}.` : `Measured on the load of ${vitals.path}, not on this page: a link swapped it in without a load.`
    vitalsPanel.replaceChildren()
    vital('lcp', 'LCP', vitals.lcp?.ms, painted === undefined ? undefined : `painted: ${painted}`)
    vital('cls', 'CLS', vitals.cls)
    vital('inp', 'INP', vitals.inp)
    tab.count(bad.length, worstTone(bad))
  }
  const reload = async () => {
    const ask = ++asked

    renderVitals()
    weightPanel.replaceChildren(tool.make('div', 'note', 'Measuring the weight...'))

    let weight: Weight

    try {
      weight = await pageWeight(doc)
    }
    catch (error) {
      if (ask === asked)
        weightPanel.replaceChildren(tool.make('div', 'empty', `Could not measure the weight: ${error instanceof Error ? error.message : String(error)}`))

      return
    }

    if (ask !== asked)
      return

    const grid = tool.make('div', 'weight')
    const total = (files: { bytes: number }[]) => files.reduce((sum, file) => sum + file.bytes, 0)
    const rows: [string, number, { url: string, bytes: number }[]][] = [
      ['HTML', weight.html, []],
      ['CSS', total(weight.css), weight.css],
      ...([['Entry', weight.entry], ['Islands', weight.islands], ['Other chunks', weight.other]] as const).flatMap(([name, files]) => files.length === 0 ? [] : [[name, total(files), files] as [string, number, { url: string, bytes: number }[]]]),
    ]
    const longest = Math.max(...rows.map(([, bytes]) => bytes))

    for (const [name, bytes, files] of rows) {
      const track = tool.make('span', 'bars')
      const fill = tool.make('i')

      fill.style.width = `${longest === 0 ? 0 : Math.max(1, bytes / longest * 100)}%`
      track.append(fill)
      grid.append(tool.make('span', '', name), track, tool.make('span', 'v', formatBytes(bytes)))

      if (files.length > 0)
        grid.append(tool.make('span', 'files', files.map(file => `${file.url} ${formatBytes(file.bytes)}`).join(', ')))
    }

    grid.append(tool.make('span', 'rule'), tool.make('span', 'total', 'Total'), tool.make('span'), tool.make('span', 'v total', formatBytes(rows.reduce((sum, [, bytes]) => sum + bytes, 0))))
    weightPanel.replaceChildren(tool.make('h3', 'heading', 'Weight, gzipped'), grid, tool.make('div', 'note', 'Dev sizes: not minified and with the dev-only code, so `kay build` makes them smaller.'))

    const built = await builtSizes(doc.defaultView!)

    if (ask !== asked || built === undefined)
      return

    const production = tool.make('div', 'build')
    const mark = built.estimated ? '~' : ''
    const figure = (name: string, bytes: string) => {
      const element = tool.make('span', '', `${name} `)

      element.append(tool.make('b', '', bytes))

      return element
    }

    production.append(tool.make('span', '', `Last kay build, ${ago(Date.now() - built.built)}`), figure('JS', `${mark}${formatBytes(built.js)}`), figure('CSS', formatBytes(built.css)))
    weightPanel.append(production, tool.make('div', 'note', `Route ${built.route}, ${built.exported ? 'static export' : 'server build'}, gzipped, minified and without the dev-only code${built.estimated ? '; ~ marks an estimate, as no page of the route was prerendered, the scripts being what its components can load' : ''}. Build again for sizes of the code as it is now.`))
  }

  reread = () => void reload()
  vitals.changed.push(renderVitals)

  // A page swap brings other HTML, styles and islands: the weight is measured again.
  const swaps = new MutationObserver(() => {
    if (tab.panel.hidden === false && !scheduled) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        reread()
      })
    }
  })

  swaps.observe(doc.head, { childList: true })
  signal.addEventListener('abort', () => swaps.disconnect())

  const vitalsSection = tool.make('section', 'group')

  vitalsSection.append(tool.make('h3', 'heading', 'Web Vitals of the page load'), vitalsPanel, loadNote)
  tab.panel.append(vitalsSection, weightPanel)
  renderVitals()
}

const ROUTE_KINDS: Record<DevRoute['kind'], string> = { page: 'Pages', endpoint: 'Endpoints', api: 'API', kay: 'Served by kay' }

// Every route the server serves, filtered as typed, each opening its file, the GET paths no request fills in linking to themselves; fetched as the tab shows and again after each restart, so it lists what the running server serves.
function routesTab(doc: Document, tool: DevTool, signal: AbortSignal): void {
  const win = doc.defaultView!
  const body = tool.make('div', 'list')
  let routes: DevRoute[] = []
  let notes: string[] = []
  // A restart while a fetch is out asks again; the latest answer wins.
  let asked = 0
  let render: () => void = () => undefined
  const bar = toolbar(tool, 'Filter by path or file', () => render())

  render = () => {
    const typed = bar.input.value.trim().toLowerCase()
    const shown = routes.filter(route => typed === '' || route.path.toLowerCase().includes(typed) || route.file.toLowerCase().includes(typed) || (route.owner ?? '').toLowerCase().includes(typed))
    const sections = Object.entries(ROUTE_KINDS).flatMap(([kind, label]) => {
      const ofKind = shown.filter(route => route.kind === kind)

      if (ofKind.length === 0)
        return []

      const section = tool.make('section', 'group')
      const heading = tool.make('h3', 'heading', label)
      const list = tool.make('div')

      list.append(...ofKind.map(route => routeRow(tool, route, win.location)))
      heading.append(pill(tool, String(ofKind.length)))
      section.append(heading, list)

      return [section]
    })

    body.replaceChildren(...sections.length > 0 ? sections : [tool.make('div', 'empty', routes.length === 0 ? 'No routes.' : 'No route matches the filter.')], ...notes.map(note => tool.make('div', 'note', note)))
  }
  const list = async () => {
    const ask = ++asked

    try {
      const response = await ownFetch(win, ROUTES_URL, { cache: 'no-store' })

      if (ask !== asked)
        return

      if (!response.ok)
        throw new Error(`the server answered ${response.status}`)

      const listed = await response.json() as DevRoutes

      if (ask !== asked)
        return

      routes = listed.routes
      notes = listed.notes
      render()
    }
    catch (error) {
      if (ask !== asked)
        return

      body.replaceChildren(tool.make('div', 'empty', `Could not list the routes: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  const tab = tool.tab({ id: 'routes', label: 'Routes', icon: 'route', shown: () => void list() })

  tab.panel.append(bar.element, body)
  win.addEventListener(BUILT_EVENT, () => {
    if (tab.panel.hidden === false)
      void list()
  }, { signal })
}

function routeRow(tool: DevTool, route: DevRoute, here: Location): HTMLElement {
  const name = route.href === undefined ? tool.make('span', 'name', route.path) : Object.assign(tool.make('a', 'name', route.path), { href: route.href })
  const row = entry(tool, 'route', {
    name,
    after: [...route.locale === undefined ? [] : [tool.make('span', 'chip', route.locale)], ...route.href === undefined ? [] : [copyButton(tool, 'the URL', new URL(route.href, here.href).href)]],
    chips: [route.owner === undefined ? positionButton(tool, route.file) : route.owner],
  })

  name.before(tool.make('span', 'method', route.method))

  if (route.href === here.pathname)
    row.setAttribute('aria-current', 'page')

  return row
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
  const href = URL.parse(url, win.location.href)?.href

  if (href !== undefined)
    OWN_FETCHES.add(href)

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

  label.textContent = await toClipboard(button, text) ? 'Copied' : 'Copy failed'

  clearTimeout(copyResets.get(button))
  copyResets.set(button, setTimeout(() => {
    label.textContent = 'Copy'
  }, COPIED_MS))
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
