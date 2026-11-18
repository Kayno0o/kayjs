import type { Lint } from './lints'

// The lints of the `islands` group that sit apart from the rest, with the other lints in `LINTS`.
export const ISLAND_LINTS = {
  'page-island': {
    level: 'deny',
    group: 'islands',
    summary: 'A page without a `--- server` fence that needs the browser: an `on*`, `bind:` or `ref` in it, a browser value of `kay` such as `signal`, or a live or persisted import. A page renders once on the server and is never an island, so what needs the browser belongs in a component the page renders. Found in the pages of the project, at the thing that makes the page an island; a layout or a page with a `--- server` fence is not reported. It has no fix: moving the code into a component is not an edit that is safe to apply.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) {count()}',
    right: '---\nimport Counter from \'../components/counter.kay\'\n---\nCounter',
  },
} as const satisfies Record<string, Lint>
