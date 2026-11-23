import { toast } from '@kayjs/ui'

export function ToastTrigger() {
  return (
    <div data-layout="cluster">
      <button
        type="button"
        data-ui="button"
        data-variant="solid"
        data-tone="accent"
        onClick={() => toast.success('Saved to SQLite', 'Zero JS recipe runtime required.')}
      >
        Success toast
      </button>
      <button
        type="button"
        data-ui="button"
        data-variant="outline"
        data-tone="danger"
        onClick={() => toast.danger('Session expired', 'Please sign in again.')}
      >
        Danger toast
      </button>
    </div>
  )
}
