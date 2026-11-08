// The stylesheet of the dev tool, adopted by its shadow root. Split from dev-tool.ts, which the dev server serves with the modules it imports.

export const STYLE = `
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
