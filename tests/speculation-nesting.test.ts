import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { speculationRules } from '../src/server/speculation'
import { browse, browserPath } from '../src/test'

const path = browserPath()
const RULES = JSON.parse((/<script type="speculationrules">(.*?)<\/script>/).exec(speculationRules('moderate'))![1]!) as { prefetch: { where: { and: { not?: { selector_matches?: string } }[] } }[] }
const SELECTOR = RULES.prefetch[0]!.where.and.map(clause => clause.not?.selector_matches).find(selector => selector !== undefined)!

// Each case is a page body holding one link, and whether the rules leave that link out: the nearest `data-prefetch`, the link's own or an ancestor's, decides.
const CASES: [string, boolean][] = [
  ['<a>x</a>', false],
  ['<a data-prefetch="false">x</a>', true],
  ['<a data-prefetch="eager">x</a>', false],
  ['<div data-prefetch="false"><a>x</a></div>', true],
  ['<div data-prefetch="eager"><a>x</a></div>', false],
  ['<main data-prefetch="eager"><nav data-prefetch="false"><p><a>x</a></p></nav></main>', true],
  ['<main data-prefetch="false"><nav data-prefetch="eager"><p><a>x</a></p></nav></main>', false],
  ['<main data-prefetch="false"><nav><a data-prefetch="viewport">x</a></nav></main>', false],
  ['<main data-prefetch="eager"><nav><a data-prefetch="false">x</a></nav></main>', true],
  ['<i data-prefetch="false"><b data-prefetch="eager"><u data-prefetch="false"><a>x</a></u></b></i>', true],
  ['<i data-prefetch="eager"><b data-prefetch="false"><u data-prefetch="eager"><a>x</a></u></b></i>', false],
  ['<i data-prefetch="eager"><b data-prefetch="false"><u data-prefetch="eager"><s data-prefetch="false"><a>x</a></s></u></b></i>', true],
  ['<i data-prefetch="false"><b data-prefetch="eager"><u data-prefetch="false"><s data-prefetch="eager"><a>x</a></s></u></b></i>', false],
]

// Deeper than three alternations fails open: the link is off by its nearest rule but the speculation rules still prefetch it, as the JS prefetch of the swap keeps the nearest rule.
const DEEPER: [string, boolean][] = [
  ['<i data-prefetch="false"><b data-prefetch="eager"><u data-prefetch="false"><s data-prefetch="eager"><q data-prefetch="false"><a>x</a></q></s></u></b></i>', false],
]

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('speculation rules and nested data-prefetch in a browser', () => {
  it('leave a link out exactly when its nearest data-prefetch is false', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('<!doctype html><body></body>', { headers: { 'content-type': 'text/html' } }) })
    const page = await browse(server.url.href, { path })

    try {
      const verdicts = await page.evaluate((cases, selector) => cases.map(([html]) => {
        document.body.innerHTML = html

        return document.querySelector('a')!.matches(selector)
      }), [...CASES, ...DEEPER], SELECTOR)

      expect(verdicts).toEqual([...CASES, ...DEEPER].map(([, out]) => out))
    }
    finally {
      await page.close()
      await server.stop(true)
    }
  }, 60_000)
})
