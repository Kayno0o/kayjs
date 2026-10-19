import { describe, expect, it } from 'bun:test'
import { t } from 'elysia'
import { action } from '../src/runtime/action'
import { formsScript } from '../src/server/forms'
import { registerScript } from '../src/server/offline'
import { queryRules, queryScript } from '../src/server/query'

function posted(url: string, schema: ReturnType<typeof t.Object>) {
  const submitted = action(schema, () => undefined)

  ;(submitted as { url: string }).url = url

  return submitted
}

describe('the scripts of constant data', () => {
  const first = posted('/first', t.Object({ name: t.String({ minLength: 3 }), note: t.Optional(t.String({ pattern: '<b>' })) }))
  const second = posted('/second<x>', t.Object({ age: t.Number({ minimum: 1 }) }))

  it('write the forms script as before, the same each time, in the order the forms came', () => {
    const one = '"/first":{"properties":{"name":{"minLength":3,"type":"string"},"note":{"pattern":"\\u003cb>","type":"string"}},"required":["name"]}'
    const two = '"/second\\u003cx>":{"properties":{"age":{"minimum":1,"type":"number"}},"required":["age"]}'

    for (let round = 0; round < 2; round++) {
      expect(formsScript(new Set([first]))).toBe(`<script type="application/json" data-kay-forms>{${one}}</script>`)
      expect(formsScript(new Set([second, first]))).toBe(`<script type="application/json" data-kay-forms>{${two},${one}}</script>`)
    }

    expect(formsScript(new Set())).toBe('')
  })

  it('write the query script and the registration as before', () => {
    const rules = queryRules(t.Object({ page: t.Integer({ minimum: 1 }), q: t.Optional(t.String()) }))

    for (let round = 0; round < 2; round++) {
      expect(queryScript(rules)).toBe(`<script type="application/json" data-kay-query>${JSON.stringify(rules).replaceAll('<', '\\u003c')}</script>`)
      expect(registerScript('/shop')).toBe('<script>if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/shop/sw.js")})</script>')
      expect(registerScript('')).toBe('<script>if("serviceWorker"in navigator)addEventListener("load",function(){navigator.serviceWorker.register("/sw.js")})</script>')
    }

    expect(queryScript(undefined)).toBe('')
  })
})
