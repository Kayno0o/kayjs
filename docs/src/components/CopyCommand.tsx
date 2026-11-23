import { signal } from 'kay'

export function CopyCommand({ command }: { command: string }) {
  const copied = signal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = command
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    copied.value = true
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      copied.value = false
    }, 1800)
  }

  return (
    <div class="docs-cli">
      <code class="docs-cli-cmd">{command}</code>
      <button
        type="button"
        class="docs-cli-copy"
        data-copied={copied.value ? 'true' : undefined}
        aria-label={copied.value ? 'Copied to clipboard' : 'Copy command'}
        title={copied.value ? 'Copied!' : 'Copy command'}
        onClick={onCopy}
      >
        {copied.value
          ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )
          : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        <span>{copied.value ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}
