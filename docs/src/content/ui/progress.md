---
description: A bar showing how far a task has got, or that one is under way without saying how far.
---

<Demo name="progress/basic" />

`value` is the fraction done, from 0 to 1, and `label` names the bar for screen readers. It is a `progressbar`, where [Meter](/ui/meter) is a gauge for a level such as disk usage.

## Without a value

With no `value` the bar is indeterminate: a bar sliding along the track, held still under `prefers-reduced-motion`, and no `aria-valuenow`, so screen readers hear a task under way.

<Demo name="progress/indeterminate" />

## With an upload

`value` takes the 0 to 1 that an action's `progress()` reads while the browser sends a file, so it needs no conversion.

```kay
---
import Progress from '@kaynooo/kayjs-ui/progress.kay'
import { upload } from '../routes/photos.kay'

async function send(event: Event) {
  const input = event.currentTarget as HTMLInputElement

  await upload({ photo: input.files![0]! })
}
---
input(type="file" aria-label="Photo" onChange={send})
if upload.progress() !== undefined
  Progress(value={upload.progress()} label="Sending the photo")
```
