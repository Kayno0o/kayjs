import type { Mounted } from 'kay/test'
import { afterEach, describe, expect, test } from 'bun:test'
import { mountComponent, settle } from 'kay/test'
import FailureDelete from '../tests/fixture/src/components/failure-delete.kay'
import FailureDialog from '../tests/fixture/src/components/failure-dialog.kay'
import { click, library } from './dom'

let mounted: Mounted | undefined

afterEach(() => {
  mounted?.unmount()
})

const toast = (root: HTMLElement) => root.querySelector('.kui-toast [data-part=message]')?.textContent

async function failedDelete(props: Record<string, unknown>) {
  mounted = await mountComponent(FailureDelete, { words: props })
  click(mounted.root.querySelector('.kui-icon-btn'))
  await settle()
  click(mounted.root.querySelector('dialog .kui-btn-danger'))
  await settle()

  return toast(mounted.root)
}

async function failedDialog(props: Record<string, unknown>) {
  const heard: unknown[] = []

  mounted = await mountComponent(FailureDialog, { words: props, onError: (failure: unknown) => heard.push(failure) })
  mounted.root.querySelector('form')!.requestSubmit()
  await settle()

  return { text: toast(mounted.root), heard }
}

describe('failure messages', () => {
  test('ConfirmDelete says failureLabel, still takes failure, and has words of its own', async () => {
    expect(await failedDelete({ failureLabel: 'New' })).toBe('New')
    mounted?.unmount()
    expect(await failedDelete({ failure: 'Old' })).toBe('Old')
    mounted?.unmount()
    expect(await failedDelete({})).toBe('Could not delete.')
  })

  test('FormDialog says failureLabel, still takes failure, has words of its own and tells onError { error }', async () => {
    const given = await failedDialog({ failureLabel: 'New' })

    expect(given.text).toBe('New')
    expect(given.heard).toEqual([{ error: expect.any(Error) }])
    mounted?.unmount()
    expect((await failedDialog({ failure: 'Old' })).text).toBe('Old')
    mounted?.unmount()
    expect((await failedDialog({})).text).toBe('Could not save.')
  })

  test('ImageCropper says failureLabel and still takes errorLabel', async () => {
    for (const [props, said] of [[{ failureLabel: 'New' }, 'New'], [{ errorLabel: 'Old' }, 'Old'], [{}, 'The image could not be loaded.']] as const) {
      mounted = await mountComponent(await library('image-cropper'), { src: '/photo.png', ...props })
      mounted.root.querySelector('[data-part="image"]')!.dispatchEvent(new Event('error'))
      await settle()
      expect(mounted.root.querySelector('[data-part="error"]')?.textContent).toBe(said)
      mounted.unmount()
    }
  })

  test('IconPicker says failureLabel and still takes errorLabel', async () => {
    for (const [props, said] of [[{ failureLabel: 'New' }, 'New'], [{ errorLabel: 'Old' }, 'Old'], [{}, 'The icons could not be loaded.']] as const) {
      mounted = await mountComponent(await library('icon-picker'), { search: async () => Promise.reject(new Error('down')), ...props })
      await settle()
      expect(mounted.root.textContent).toContain(said)
      mounted.unmount()
    }
  })
})
