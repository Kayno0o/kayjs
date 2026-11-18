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
  'signal-from-prop': {
    level: 'warn',
    group: 'islands',
    summary: 'A `signal` seeded from a destructured prop at the top of an island\'s script, `signal(light)` or `signal(todo.title)`, that the island never writes: an island stays when the page gives it new props, as after an action or a refresh, so the signal keeps the first value. `linked(() => light)` follows the prop; `kay check --fix` writes it. A signal the island writes, as a counter starting from a prop, is its own state and is left alone, as is a prop named `initial...` or `default...` or a comment `// kay-allow signal-from-prop`.',
    wrong: '---\nimport { signal } from \'kay\'\n\nconst { light } = props<{ light: string }>()\nconst picked = signal(light)\n---\np {picked()}',
    right: '---\nimport { linked } from \'kay\'\n\nconst { light } = props<{ light: string }>()\nconst picked = linked(() => light)\n---\np {picked()}',
  },
} as const satisfies Record<string, Lint>
