import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FormComponent from '../tests/fixture/src/components/form.kay'
import { click } from './dom'

let mounted: Mounted | undefined

afterEach(() => mounted?.unmount())

async function form(props: Record<string, unknown>) {
  mounted = await mountComponent(FormComponent, props)

  return mounted.root
}

const messages = (root: HTMLElement) => [...root.querySelectorAll('.kui-form-field')].map(field => [...field.querySelectorAll('[data-field] > *')].map(message => message.textContent))

async function submit(root: HTMLElement) {
  click(root.querySelector('#submit'))
  await settle()
}

describe('Form', () => {
  test('onSaved still hears the result, after onSave', async () => {
    const heard: string[] = []
    const root = await form({ add: async (input: { title: string }) => input.title, onSave: (title: string) => heard.push(`save ${title}`), old: { onSaved: (title: string) => heard.push(`saved ${title}`) } })

    root.querySelector<HTMLInputElement>('#title')!.value = 'Hello'
    await submit(root)

    expect(heard).toEqual(['save Hello', 'saved Hello'])
  })

  test('calls the action with its fields, toasts saved and hands the result to onSave', async () => {
    const saved: string[] = []
    const root = await form({ add: async (input: { title: string }) => input.title, onSave: (title: string) => saved.push(title) })

    root.querySelector<HTMLInputElement>('#title')!.value = 'Hello'
    await submit(root)

    expect(saved).toEqual(['Hello'])
    expect(root.textContent).toContain('Added.')
    expect(messages(root)).toEqual([[], []])
  })

  test('shows the messages of a refusal on the FormField of that name, with no issue prop, and focuses the first invalid field', async () => {
    const root = await form({ add: async () => ({ errors: { title: 'Too short', slug: 'Taken' } }), onSave: () => undefined })

    await submit(root)

    expect(messages(root)).toEqual([['Too short'], ['Taken']])
    expect(root.querySelector('#title')!.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(root.querySelector('#title'))
  })

  test('clears the messages once a call goes through, and calls onError with the refusal', async () => {
    const failures: unknown[] = []
    let refuse = true
    const root = await form({ add: async () => refuse ? { errors: { title: 'Too short' } } : 'ok', onSave: () => undefined, onError: (failure: unknown) => failures.push(failure) })

    await submit(root)
    expect(messages(root)[0]).toEqual(['Too short'])
    expect(failures).toHaveLength(1)

    refuse = false
    await submit(root)
    expect(messages(root)).toEqual([[], []])
  })

  test('reads the messages `refused` finds in what the handler refused with', async () => {
    const root = await form({ add: async () => ({ data: { field: 'slug' } }), onSave: () => undefined, refused: (data: { field: string }) => ({ [data.field]: 'Already used' }) })

    await submit(root)

    expect(messages(root)).toEqual([[], ['Already used']])
  })
})
