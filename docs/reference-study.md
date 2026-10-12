# Reference study: Skribbl.io

Observed on 10 October 2026 at <https://skribbl.io/> using Chrome through Playwright. Three independent browser contexts named `DR Study One`, `DR Study 2`, and `DR Study 3` joined only a newly created private room. No public game or other person's room was entered. The study informs interaction requirements; DoodleRoom uses original branding, layout details, and implementation.

## Verified live behavior

| Area | Direct observation | DoodleRoom implementation decision |
| --- | --- | --- |
| Entry | Name entry, avatar, language, Play, and Create Private Room appear on the home screen. | Original home screen with guest name and create/join actions. |
| Lobby | Host controls player cap, language, draw time, rounds, mode, number of word choices, hints, and custom words. Copyable invitation link; owner/join announcements. | 2–12 players; rounds, draw time, and built-in/custom/combined word modes; shareable link and host moderation. Other reference controls are outside the assignment. |
| Settings | Reference offers 2–20 player slots, 15–240-second draw options, 2–10 rounds, 1–5 choices, 0–5 hints. Its custom-word field advertises at least 10 comma-separated words of 1–32 characters. | Approved limits deliberately differ: 1–10 rounds, 15–180 seconds, exactly 3 choices, at least 3 unique custom-only words. |
| Choosing | Only the selected drawer sees three candidate words; others see who is choosing. Observed choosing countdown starts at 15 seconds. | Drawer-only choices and a 10-second automatic-choice deadline. |
| Drawing | Drawer sees “DRAW THIS” and the word. Other players see word-length blanks and “GUESS THIS.” Live canvas is internally 800×600, scaled for the viewport. | Private drawer state; public masked hints; shared 800×600 logical canvas. |
| Drawing controls | Active drawer toolbar exposes brush, fill, undo, clear, palette, and sizes, with B/F/U/C hotkey labels. A mouse stroke appeared during the test. | Pen, colors, size, eraser, fill, undo, clear, plus keyboard-accessible controls and touch input. |
| Near miss | `elephanx` was shown as an ordinary public guess, but `elephanx is close!` appeared only in that guesser's chat. | Server computes edit-distance feedback and sends “close!” privately. |
| Correct guess | Public chat announced that the player guessed the word, without echoing their submitted correct text. The successful guesser saw the full word. | Public success announcement only; disable further free-text chat for successful guessers until reveal. |
| End condition | Second successful guess ended the three-player turn immediately. A canvas overlay revealed the word, “Everyone guessed the word!”, and each player's score delta. | End on all eligible correct guesses or authoritative deadline; reveal word and score changes. |
| Scores | This run awarded +325, +300 to guessers and +155 to the drawer. Scores updated in the ranked left column. | Use the separately specified transparent time-based formula, not inferred reference scoring. |
| Turn progression | After a short reveal, the next player received the word-choice phase and the others saw the choosing notice. | Explicit choosing/drawing/reveal/results state machine. |
| Timing difference | After the first correct guess, the displayed reference timer dropped from about 28 seconds to 15 seconds. | Preserve the approved fixed authoritative deadline; no first-guess shortening. |

## Visual and interaction notes

Desktop reference layout places ranked players on the left, a dominant central canvas, and chat on the right, with round/timer/word status above. The reveal overlay preserves the underlying drawing. System messages distinguish joins, drawer changes, correct guesses, and word reveals through color. DoodleRoom adopts this readable information hierarchy with an original cream/ink/color visual system rather than recreating the reference's blue patterned background, logo, assets, or ads.

Reference screenshots were captured outside the repository at `/tmp/skribbl-home.png`, `/tmp/skribbl-private.png`, `/tmp/skribbl-turn.png`, and `/tmp/skribbl-reveal.png`; none are bundled as product assets.

## Verification boundaries

The private-room walkthrough verified lobby, three independent sessions, drawer-only choices, a live drawing gesture, private near-miss feedback, correct-guess announcements, all-guessed reveal, score display, and next-turn progression. The home page also describes mobile support, pressure input, configurable hotkeys, mute/report/votekick, and owner kick/ban controls; those are published reference claims, not all individually exercised here.

This study does **not** establish the reference's internal authority, transport ordering, reconnect grace, restart persistence, abuse limits, exact scoring formula, or capacity. Those DoodleRoom requirements must be verified against our implementation and tests. Drawer-disconnection recovery, mobile play, every toolbar operation, and a complete reference match were not exercised during the bounded walkthrough.

## Requirement checklist for implementation

- [x] Reference private-room behavior reviewed before feature implementation.
- [ ] Room creation, link joining, host settings, and moderation.
- [ ] Complete drawing toolbar and immediate local rendering.
- [ ] Authoritative choices, countdown, hints, scoring, and protected guesses.
- [ ] Ordered drawing synchronization, late-join snapshot, and deterministic replay.
- [ ] 30-second identity recovery, host succession, and drawer departure recovery.
- [ ] Durable restart recovery, request limits, origin/session checks, and load report.
- [ ] One-command startup.
