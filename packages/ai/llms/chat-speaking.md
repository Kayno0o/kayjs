# Reading replies aloud

## Common tasks

- Put a chat on a page and choose what it shows: the tasks of [Chat](chat.md#common-tasks).

## Reference

### Reading replies aloud

`speak` takes an action that turns a reply's text into audio, the way `transcribe` takes one for a recording ([Speaking a message](chat.md#speaking-a-message)). Each finished reply is read with it, markdown left unsaid. kayjs-ai's `speakData()` is `speak()` made to answer an action, whose answer is JSON: the audio as base64 with its type.

```kay
--- server
import { s, action } from 'kay'
import { speakData } from '@kayjs/ai'

export const say = action({ text: s.string() }, ({ text }) => speakData(text, { voice: 'nova' }), { protect: { rateLimit: { max: 20, window: '1m' } } })
---
Chat(action={reply} speak={say})
```

An action may also answer the address of audio, a string the browser plays (a URL of the app or a `data:` URL), to serve what it stored.

- A newer reply, a send, a regenerate, an edit and a new conversation stop the reading under way, and a reading whose action had not answered yet is dropped.
- A browser that refuses to play unasked (its autoplay policy) leaves a play button, the part `play`, in the actions of the turn: a press always plays. While a reply is read the button is a stop button.
- `autoplay={false}` reads nothing unasked and shows the play button under every finished reply.
- A refusal of the action (its `ctx.fail` or `ctx.deny` message under 500, else `labels.speakFailed`) or audio that cannot be played shows a notice, which the next reading, send or new conversation clears. A `play()` rejected with `AbortError` while the audio is not paused plays all the same and shows nothing.
- `speaking` is whether a reply is read, for the app to control: `bind:speaking={speaking}`, or `speaking={false}` to stop it and `true` to read the last reply. `onSpeakingChange({ speaking })` hears each change.
- `onSpeak({ turn })` is called when the audio starts playing, `onSpeakEnd({ turn })` when it ends and `onSpeakFail({ turn, message })` when the reading failed, with the notice's text. A throw is logged and leaves the chat alone.
- Words: `ai.chat.play` (`labels.play`, `Read the reply aloud`), `stopReading` (`Stop reading`) and `speakFailed` (`The reply could not be read aloud.`). `icons.play` replaces the play icon and `icons.stop` the stop one. `@actions(turn)` adds buttons beside the play one.
- The audio of a reply costs a `speak()` call each, billed and counted against `ai({ rateLimit, budget })`: protect the action as `transcribe`'s is.
