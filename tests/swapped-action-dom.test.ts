import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

describe('the form posts the page swap takes', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/app/page' })
    document.head.innerHTML = '<meta name="kay-base" content="/app">'
  })

  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  it('are posts to one of the app\'s actions in this tab, with nothing opting them out, and an action the page cannot resolve is left to the browser', async () => {
    const { swappedActionUrl } = await import('../src/runtime/form-submits')
    const swapped = (form: string, button = '<button>Send</button>') => {
      document.body.innerHTML = form.replace('></form>', `>${button}</form>`)

      const element = document.querySelector('form')!

      return swappedActionUrl(element, element.querySelector('button'))?.pathname
    }

    expect(swapped('<form method="post" action="/app/_kay/action/add"></form>')).toBe('/app/_kay/action/add')
    expect(swapped('<form method="post" action="/app/page"></form>', '<button formaction="/app/_kay/action/add">Send</button>')).toBe('/app/_kay/action/add')
    expect(swapped('<form action="/app/_kay/action/add"></form>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/_kay/action/add"></form>', '<button formmethod="get">Send</button>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/_kay/action/add" data-reload></form>')).toBeUndefined()
    expect(swapped('<div data-reload><form method="post" action="/app/_kay/action/add"></form></div>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/_kay/action/add"></form>', '<button data-reload>Send</button>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/_kay/action/add" target="_blank"></form>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/_kay/action/add"></form>', '<button formtarget="_blank">Send</button>')).toBeUndefined()
    expect(swapped('<form method="post" action="http://elsewhere/app/_kay/action/add"></form>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/page?next=/app/_kay/action/add"></form>')).toBeUndefined()
    expect(swapped('<form method="post" action="/app/_kay/action/add"><input name="method" value="put"><input name="target"></form>')).toBe('/app/_kay/action/add')
    expect(swapped('<form method="post" action="http://[::1"></form>')).toBeUndefined()
    expect(swapped('<form method="post" action="http://[::1/_kay/action/add"></form>')).toBeUndefined()
  })
})
