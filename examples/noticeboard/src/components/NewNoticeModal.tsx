import { Dialog, toast } from '@kayjs/ui'
import { signal } from 'kay'
import { pinNotice } from '../actions/notices'

export function NewNoticeModal() {
  const open = signal(false)
  const title = signal('')
  const body = signal('')
  const error = signal('')
  const busy = signal(false)

  const submit = async (e: Event) => {
    e.preventDefault()
    if (busy.value)
      return
    busy.value = true
    error.value = ''
    try {
      const res = await pinNotice({ title: title.value, body: body.value })
      if (!res.ok) {
        error.value = res.error
        return
      }
      title.value = ''
      body.value = ''
      open.value = false
      toast.success('Pinned', `"${res.data.title}" is now live.`)
    }
    finally {
      busy.value = false
    }
  }

  return (
    <Dialog open={open} title="Pin a notice" triggerLabel="Pin a notice" triggerVariant="solid">
      <form onSubmit={submit} data-layout="stack" style="--ui-gap:0.9rem">
        {error.value && <div data-ui="notice" data-tone="danger" role="alert">{error.value}</div>}
        <div data-ui="field">
          <label data-part="label" for="notice-title">Title *</label>
          <input
            id="notice-title"
            name="title"
            maxlength="120"
            required
            value={title.value}
            onInput={(e) => { title.value = (e.target as HTMLInputElement).value }}
          />
        </div>
        <div data-ui="field">
          <label data-part="label" for="notice-body">Notice *</label>
          <textarea
            id="notice-body"
            name="body"
            rows="4"
            maxlength="4000"
            required
            value={body.value}
            onInput={(e) => { body.value = (e.target as HTMLTextAreaElement).value }}
          />
        </div>
        <div data-layout="cluster">
          <button id="submit-notice" data-ui="button" data-variant="solid" data-tone="accent" type="submit" disabled={busy.value}>
            {busy.value ? 'Pinning...' : 'Pin it'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
