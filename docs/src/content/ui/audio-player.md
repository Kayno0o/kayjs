---
description: An audio player with chapters, a transcript that follows the voice, and lock screen controls.
---

<Demo name="audio-player/basic" />

`src` is the audio. The player draws a play button, the time and a slider to seek with, in the library's look, with no native controls. `title`, `artist` and `artwork` describe the audio to the lock screen.

## Chapters

A chapter has a `title`, a `start` in seconds and optionally a `url`. Pass them in time order, as the player never sorts them. They show as a list of buttons that seek and play, as marks on the timeline, and the previous and next buttons step between them. The chapter playing is marked, and a chapter with a `url` gets a link beside it.

The previous button restarts the chapter once it is more than 3 seconds in, and goes to the one before otherwise, as a music player's back button does.

## Transcript

A cue has a `start`, an `end` and a `text`. The cues fill a folded transcript, grouped under the chapter they start in. The cue playing is marked and kept in view, and clicking a cue seeks there and plays.

## Lock screen and headset

Once the audio has played, the lock screen and the headset buttons show the chapter playing as the title, with `title` as the album, and skip between chapters. The handlers are removed when the player leaves the page.

## Your own buttons per chapter

`@actions(chapter, index)` fills each chapter's row, after its link. This is where a like button or a queue toggle goes.

<Demo name="audio-player/actions" />

## Reading the position

`onPositionChange` gets the seconds played, and `onChapterChange` the index of the chapter now playing, or -1 before the first. `position` goes the other way: a player whose parent passes a position more than a second away from its own seeks to it, so `position={at()} onPositionChange={at.set}` keeps both in step.

## Labels

`playLabel`, `pauseLabel`, `previousLabel`, `nextLabel`, `seekLabel`, `chaptersLabel` and `transcriptLabel` name the controls and `linkLabel` a chapter's link, `{title}` standing for the chapter's title. `failure` is the message shown when the browser refuses to play. `preload` is `metadata` by default, which gives the slider its length.
