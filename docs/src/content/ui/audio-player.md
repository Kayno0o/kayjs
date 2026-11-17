---
description: An audio player with chapters, a transcript that follows the voice, and lock screen controls.
---

<Demo name="audio-player/basic" />

`src` is the audio. The player draws a play button, the time and a slider to seek with, in the library's look, with no native controls. `title`, `artist` and `artwork` describe the audio to the lock screen.

## Chapters

A chapter has a `label`, a `start` in seconds and optionally an `href`. Pass them in time order, as the player never sorts them. They show as a list of buttons that seek and play, as marks on the timeline, and the previous and next buttons step between them. The chapter playing is marked, and a chapter with an `href` gets a link beside it, in a new tab for another site so the audio keeps playing.

The previous button restarts the chapter once it is more than 3 seconds in, and goes to the one before otherwise, as a music player's back button does.

## Transcript

A cue has a `start`, an `end` and a `text`. The cues fill a folded transcript, grouped under the chapter they start in. The cue playing is marked and kept in view, and clicking a cue seeks there and plays. The cues are one tab stop and the arrows move between them, the left and right ones following the reading direction.

## Lock screen and headset

Once the audio has played, the lock screen and the headset buttons show the chapter playing as the title, with `title` as the album, and skip between chapters. The handlers are removed when the player leaves the page.

## Your own buttons per chapter

`@actions(chapter, index)` fills each chapter's row, after its link. This is where a like button or a queue toggle goes.

<Demo name="audio-player/actions" />

## A tile, a subtitle and the chapter in the bar

`@lead(chapter, index)` fills the start of each chapter's row, before its button: a tile, an icon or a cover. A chapter's `subtitle` is drawn under its label. `@status(chapter, index)` puts the chapter playing in the bar, after the time, and takes the place of the line under the bar that names it.

## A waveform

`peaks` on a chapter are its loudness, each from 0 to 1 and evenly spread over the chapter's length. When any chapter has some, the timeline draws them as bars, one stretch per chapter as wide as the chapter is long, in place of the groove and its marks. The bars already played are in the accent and the rest are muted. A chapter with none leaves its stretch empty.

The slider is still there, invisible over the bars, so a click or a drag seeks and the arrows, Home, End and Page keys work as before; its focus is drawn around the bars.

<Demo name="audio-player/waveform" />

## Reading the position

`onPositionChange` gets the seconds played, and `onChapterChange` the index of the chapter now playing, or -1 before the first. `position` goes the other way: a player whose parent passes a position more than a second away from its own seeks to it, so `position={at()} onPositionChange={({ seconds }) => at = seconds}` keeps both in step. A position the player reported in the last second is taken as an echo and never seeks. One that comes back later is behind the audio and seeks it backwards.

## Labels

`playLabel`, `pauseLabel`, `previousLabel`, `nextLabel`, `seekLabel`, `chaptersLabel` and `transcriptLabel` name the controls and `linkLabel` a chapter's link, `{title}` standing for the chapter's title. `failureLabel` is the message shown when the browser refuses to play. `preload` is `metadata` by default, which gives the slider its length.

## Play, pause, end and error

`onPlay`, `onPause` and `onEnd` are called as the audio moves through them. `onError` gets `{ error, event }`, the error being the `MediaError` when the file or stream fails to load, or the `DOMException` when the browser refuses to play, which the `failureLabel` toast also reports.
