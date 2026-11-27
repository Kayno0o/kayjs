import { Button, Cluster, ControlledDialog, Field, Notice, Stack, toast } from '@kayjs/ui'
import { signal, useAction } from '@kayjs/kay'
import { pinNotice } from '../actions/notices'

export function NewNoticeModal() {
  const open = signal(false)
  const form = useAction(pinNotice, {
    reset: true,
    onSuccess(notice) {
      open.value = false
      toast.success('Pinned', `"${notice.title}" is now live.`)
    },
  })

  return (
    <ControlledDialog open={open} title="Pin a notice" triggerLabel="Pin a notice" triggerVariant="solid">
      <form action={pinNotice} method="post" onSubmit={form.onSubmit}>
        <Stack gap="0.9rem">
          {form.error.value && <Notice tone="danger" role="alert">{form.error.value}</Notice>}
          <Field id="notice-title" label="Title" error={form.fieldErrors.value.title} required>
            <input id="notice-title" name="title" maxlength="120" required />
          </Field>
          <Field id="notice-body" label="Notice" error={form.fieldErrors.value.body} required>
            <textarea id="notice-body" name="body" rows="4" maxlength="4000" required />
          </Field>
          <Cluster>
            <Button id="submit-notice" type="submit" tone="accent" disabled={form.pending.value}>
              {form.pending.value ? 'Pinning...' : 'Pin it'}
            </Button>
          </Cluster>
        </Stack>
      </form>
    </ControlledDialog>
  )
}
