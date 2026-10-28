---
description: A microphone button that records the visitor's voice and hands the app the file.
---

<Demo name="record-button/basic" />

`onRecord` takes what was said as a `File`, `recording.webm` in Chrome and Firefox and `recording.m4a` in Safari, which an action's `s.File()` field takes as it is: `RecordButton(onRecord={audio => transcribe({ audio })})`. `label` names the button, `Record` by default.

A press asks the browser for the microphone, which prompts the visitor the first time, and starts recording. The button is then pressed, draws a stop icon and shows the time beside it. The next press stops and hands the recording over. While the promise `onRecord` returns is pending the button is busy, and a rejection says `failure`. `maxDuration`, `5m` by default and a duration with its unit, stops a recording left running as if pressed, so it stays within the action's `maxSize`.

## What it handles

The microphone is released however the recording ends: stopped, dropped, unplugged, or the button removed from the page. A notice under the button says why nothing was recorded:

- the visitor blocked the microphone, or none was found;
- another application holds it;
- it was unplugged mid-recording, which drops what was said;
- the page is not on https, where browsers offer no microphone;
- the browser cannot record;
- the recording held no sound.

## Keyboard and screen readers

The button is a toggle, `aria-pressed` while it records, so Enter and Space start and stop it. Escape on it drops the recording. A visually hidden status region says when the recording starts, stops and is dropped, and empties once `onRecord` settles, as a screen reader does not read a button's new state. The time ticks every second, so it is hidden from screen readers.

## Variant

It takes a Button's `variant`, `tone` and `size`, and draws the `microphone` icon slot.

## Words

Its texts are `ui.recordButton.*` messages, the microphone's troubles included, so a catalog words them once for the whole site. kayjs-ai's Chat reads the same words for its own microphone.

## Drawn otherwise

`recorder()` and `recordWords()` from `@kaynooo/kayjs-ui/lib/record` are the button's state, for a microphone drawn another way: `state`, `problem`, `said` and `seconds` are signals, `press()` starts or stops and `cancel()` drops. The recorder's browser code is a chunk of its own, loaded when the component mounts, so a page without a microphone ships none of it.
