import { signal } from '@kayjs/kay'
import { greet } from '../actions/greet'

export function GreetForm() {
  const name = signal('')
  const reply = signal('')

  async function onSubmit(e: SubmitEvent) {
    e.preventDefault()
    const res = await greet({ name: name.value })
    reply.value = res.ok ? res.data.message : res.error
  }

  return (
    <form class="greet-form" action={greet.url} method="post" onSubmit={onSubmit}>
      <input
        name="name"
        placeholder="Your name"
        value={name.value}
        onInput={(e) => { name.value = (e.target as HTMLInputElement).value }}
      />
      <button type="submit">Greet</button>
      {reply.value && <span>{reply.value}</span>}
    </form>
  )
}
