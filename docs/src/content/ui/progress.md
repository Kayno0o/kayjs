---
description: A bar showing how far a task has got, or that one is under way without saying how far.
---

<Demo name="progress/basic" />

`value` is how far the task has got out of `max`, a percentage as Meter's, and `label` names the bar for screen readers. It is a `progressbar`, where [Meter](/ui/meter) is a gauge for a level such as disk usage.

## Without a value

With no `value` the bar is indeterminate: a bar sliding along the track, held still under `prefers-reduced-motion`, and no `aria-valuenow`, so screen readers hear a task under way.

<Demo name="progress/indeterminate" />

## With an upload

An action's `progress()` reads from 0 to 1 while the browser sends a file, so pass `max={1}`.

```kay
---
import Progress from '@kayjs/ui/progress.kay'
import { upload } from '../routes/photos.kay'

async function send(event: Event) {
  const input = event.currentTarget as HTMLInputElement

  await upload({ photo: input.files![0]! })
}
---
input(type="file" aria-label="Photo" onChange={send})
if upload.progress() !== undefined
  Progress(value={upload.progress()} max={1} label="Sending the photo")
```

## Value text, thresholds and size

`formatValue(value, max)` becomes `aria-valuetext` and the text `showValue` draws under the bar (the percentage without it), `@reading(text, value, max)` draws it in your markup, `thresholds` colors the fill by value as [Meter](/ui/meter)'s do, in the units of `max`, and `size` is `sm`, `md` (default) or `lg`. An indeterminate bar has no value, so none of the text shows.
