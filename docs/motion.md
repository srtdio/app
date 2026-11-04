# Motion

Only `src/lib/motion/` moves. Everything else calls one of the nine moves below. Guard: `src/__tests__/motion-rules.test.ts`. Token drift: `src/lib/motion.test.ts`.

## Laws

- **Never fade.** Opacity never animates: no fade-in, fade-out, cross-fade or pulsing skeleton. The one exception is the sheet's backdrop dim, which tracks the sheet's position (`trackDim`, `dimFor`); it is never a timed fade of its own.
- **Every move declares its axis** (`MoveSpec.axis`: `x`, `y`, `scale`, `rotate`, `clip`, `fill`). `play()` throws on opacity or on a property outside the axis. Lists and feeds move on Y only.
- **Final state first.** React and CSS always render the end state. A move is a Web Animation laid over it from a start pose (`fill: none`), so an element whose move never runs (motion off, no Web Animations, features not loaded yet) simply shows its end state. Exits use `fill: forwards` and unmount on `done`.
- **Interruptible.** Any `pointerdown` or `keydown` (capture phase) finishes every running move (`finishAll`). The tap's own new move then starts.
- **Instant when off.** Reduce Motion (OS) or `?motion=0` (remembered for the tab in `sessionStorage`, `?motion=1` clears it) mirror onto `html[data-motion='off']`; `play()` returns at once (`instant: true`) and every `mv-*` CSS class drops its transition and animation.
- **Never waits for data.** No move runs inside a data wait; no await, hold or gate on a paint or tap path.
- **Lighting stays put.** A moving surface keeps its `lit-*` class. A dragged card lifts one lit height; a pressed control sinks to .97.
- **Laptop** (`useIsLaptop`): pane and screen switches are instant. Kept: grow-from-card, menus growing from their trigger, centre dialogs growing 95% to 100%, press, list item in/out/glide, loading boxes.
- **Theme switch is instant.** `toggleTheme` (`src/lib/theme.ts`) adds `html.theme-switching` for two frames (rAF x2, then removed); `motion.css` sets `transition: none !important` on every element under it, so light/dark lands in one frame with no per-control colour ease. The flip and the theme-color meta write stay synchronous.
- **No motion at all**: the bottom tab bar, tab switches and kept-view tab return, workspace switch (clean cut), a scheduled strip that is already there when a chat opens.

## Tokens

`src/index.css :root`, mirrored in `src/lib/motion/tokens.ts`, registered in `tailwind.config.ts`.

| Token             | ms   | Token          | Curve                        | Used by                                     |
| ----------------- | ---- | -------------- | ---------------------------- | ------------------------------------------- |
| `--dur-fast`      | 120  | `--ease-enter` | cubic-bezier(.16,1,.3,1)     | entrances, itemIn, settle, menus (grow)     |
| `--dur-base`      | 160  | `--ease-exit`  | cubic-bezier(.7,0,.84,0)     | exits                                       |
| `--dur-slow`      | 200  | `--ease-ios`   | cubic-bezier(.32,.72,0,1)    | push, sheets, grow, toast                   |
| `--dur-push`      | 280  | `--ease-move`  | cubic-bezier(.77,0,.175,1)   | glide, reorder, wipe                        |
| `--dur-back`      | 240  | `--ease-pop`   | cubic-bezier(.34,1.56,.64,1) | pills, photo settle, upload settle, OK tick |
| `--dur-grow`      | 300  |                |                              |                                             |
| `--dur-grow-back` | 260  |                |                              |                                             |
| `--dur-sheet-in`  | 320  |                |                              |                                             |
| `--dur-sheet-out` | 240  |                |                              |                                             |
| `--dur-menu`      | 160  |                |                              |                                             |
| `--dur-toast`     | 320  |                |                              |                                             |
| `--dur-wipe`      | 1200 |                |                              |                                             |
| `--dur-sweep`     | 1100 |                |                              |                                             |

## The nine moves

| #   | Move             | Axis                   | Values                                                                                                                                                                                                                                                                                                                 | API (`@/lib/motion`)                                                                                                                              |
| --- | ---------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | push             | X                      | Phone: enters from the right, the screen behind shifts left 25%. 280 in, 240 back, ease-ios. Edge back from the left 28 px follows the finger; closes at 130 px or a flick over 0.5 px/ms, else springs back. Skipped when popstate has `hasUAVisualTransition`. Incoming edge: 1 px ring, no shadow. Laptop: instant. | `pushIn`, `pushBack`, `pushSettle`, `useDragDismiss({axis:'x', edgeZone: EDGE_BACK_ZONE_PX, closeAt: EDGE_BACK_CLOSE_PX})`, `skipForUATransition` |
| 2   | growFromCard     | scale from card origin | The tapped card's rect scales and moves into the page; corners 12 to 0. 300 open, 260 back into the same card.                                                                                                                                                                                                         | `rememberCard`, `takeCard`, `growFromCard`, `rememberPage`, `takePage`, `growBackIntoCard`                                                        |
| 3   | rise             | Y; laptop: scale       | Sheet translateY 100% to 0, 320 in, 240 out. Drag down from the top edge follows the finger; closes at 140 px or a flick over 0.5 px/ms. Backdrop dim tracks position. Laptop centre dialogs grow 95% to 100%, 200 ms.                                                                                                 | `riseIn`, `riseOut`, `dialogIn`, `dialogOut`, `trackDim`, `dimFor`, `useDragDismiss`                                                              |
| 4   | growFromTrigger  | scale from trigger     | Scale .90 to 1 from the trigger or cursor point, 160 ms, ease-enter (no overshoot). Phone long-press stays the bottom sheet (rise).                                                                                                                                                                                    | `growFromTrigger`, `shrinkToTrigger`, `originFrom`                                                                                                |
| 5   | press            | scale                  | Button, IconButton, Chip, PressableRow, tiles: .97 while held, 120 ms. Never on the iOS long-press callout.                                                                                                                                                                                                            | CSS `mv-press` (`MOVE_CLASS.press`)                                                                                                               |
| 6   | itemIn / itemOut | Y / clip               | In: rises 8 px, 180 ms ease-enter. Out: closes upward (clip), 200 ms.                                                                                                                                                                                                                                                  | `itemIn`, `itemOut`, `useFreshKeys`                                                                                                               |
| 7   | glide            | Y (lists), X+Y (grids) | FLIP: siblings move to their new place. 210 ms ease-move.                                                                                                                                                                                                                                                              | `GlideItem` (motion `layout`, domMax loaded at idle)                                                                                              |
| 8   | edgeStrip        | Y                      | Activity toast drops from the top, 320 ms; swipe up 30 px dismisses. Bottom strips rise from the bottom (Undo stays 4 s). Strips above the composer slide 8-48 px. Leaving: the same way back.                                                                                                                         | `stripIn`, `stripOut`, `TOAST_DISMISS_PX`                                                                                                         |
| 9   | sweepBoxes       | fill (sweep) + Y       | One shared box primitive. Boxes match the final layout. A top-lit sweep, 1100 ms linear, looping. On landing content settles 6 px, 200 ms, 40 ms stagger (max 5). Boxes only when the device or session holds nothing.                                                                                                 | `Bone`, `BoxSkeleton`, `useSettleOnLanding`, `useHadBoxes`, `settle`                                                                              |

### Small touches (same tokens)

| Touch                            | Axis        | Values                                                            | API                                          |
| -------------------------------- | ----------- | ----------------------------------------------------------------- | -------------------------------------------- |
| Approve / Mark checked tick      | fill        | stroke-dashoffset, 220 ms                                         | `drawTick` (path `pathLength="1"`)           |
| Badge and unread counts          | Y           | digit rolls one step, 160 ms                                      | `rollDigit`                                  |
| Unread pill, star, mark, OK chip | scale       | from .9, ease-pop                                                 | `pop`                                        |
| Composer plus to X               | rotate      | 45deg, 200 ms                                                     | CSS `mv-turn`                                |
| Reminder bell                    | rotate      | 3 swings, 700 ms                                                  | `bellSwing`                                  |
| Wrong sign-in code               | X           | shake 320 ms, plus/minus 10 px                                    | `shake`                                      |
| Landing highlight (focus-target) | clip        | wipes away L to R, 1200 ms                                        | `wipeAway`                                   |
| Plan week/month change           | X           | slide 240 ms                                                      | `slideX`                                     |
| Board drag                       | scale       | lift one lit height, 1.02                                         | CSS `mv-lift` + `GlideItem`                  |
| Upload ring                      | fill, scale | fills at real progress; finish scales to 0, tile settles ease-pop | CSS `mv-fill`, `mv-ring-out`, `uploadSettle` |
| Tour cards, onboarding steps     | X           | slide, Back reverses                                              | `stepX`                                      |
| Command palette                  | Y           | drops 8 px                                                        | `dropIn`                                     |
| Spinner                          | rotate      | 800 ms linear loop                                                | CSS `mv-spin`                                |
| Hover / state colour             | none        | colour only, 120 ms                                               | CSS `mv-tint`                                |
| Knob, thumb, chevron flip        | X / rotate  | 160 ms                                                            | CSS `mv-slide`, `mv-turn`                    |

## Loading the code

- `motion` (MIT), pinned exact. Boot carries `LazyMotion` + `m` only (about 5 KB gzip) plus the module (WAAPI, no library).
- `MotionRoot` (main.tsx) loads `domMax` (layout, layoutId, drag) with a dynamic import after first paint at idle. Before it loads every `m.*` element renders at its final state and layout moves snap.

## Push hold

`pushIn` holds the screen behind at its shifted pose until `pushBack` (or the next `pushIn`) on that screen releases it.

## Marks (?paintlog=1)

`motion:start:push|growFromCard|rise` and `motion:end:...` on every push, grow and rise.

## Opener to move

| Opener                                                    | Move                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------ |
| ui/Sheet (48 users)                                       | rise; laptop dialogIn                                                    |
| ui/ConfirmDialog (17)                                     | rise (phone) / dialogIn (laptop)                                         |
| ui/ActionMenu (10), shell/MenuPopover (4), SortMenu       | growFromTrigger (laptop), rise (phone sheet)                             |
| ui/toast/Toast, ToastProvider                             | edgeStrip top, swipe up 30 px                                            |
| ui/toast/UndoStrip                                        | edgeStrip bottom                                                         |
| ui/Button, IconButton, Chip, PressableRow (77), tiles     | press                                                                    |
| ui/Backdrop                                               | dim tracks its sheet (no timed fade)                                     |
| ui/DatePicker, ui/Select                                  | growFromTrigger                                                          |
| ui/FileViewer, ImageLightbox, PhotoViewer                 | growFromCard from the thumbnail; swipe down closes (rise out)            |
| ui/UnsafeLinkSheet                                        | rise                                                                     |
| shell/CommandPalette                                      | dropIn (8 px from the top)                                               |
| preview/PlatformPreviewPanel                              | rise (phone), instant (laptop side panel)                                |
| chat/ThreadView                                           | push                                                                     |
| chat/ComposerEmoji, ContactSheet, ModalPanel, StarredList | rise                                                                     |
| chat/PlanDayPopover                                       | growFromTrigger                                                          |
| chat/PostCard                                             | growFromCard                                                             |
| chat/StatusDrawer + StatusTicker                          | edgeStrip (drops from the ticker), rows settle, chevron `mv-turn` 180deg |
| chat/VoiceDraft                                           | press (record button grows while held)                                   |
| chat/tasks/TaskSheet, TaskRow                             | rise; itemIn/itemOut, glide                                              |
| chat/MessageThread overlays                               | edgeStrip above the composer, itemIn, glide                              |
| pages/assets/AssetLightbox, pcs/PostLightbox              | growFromCard                                                             |
| pages/create/FilePromptSheet                              | rise                                                                     |
| pages/pipeline/PipelineDateRangeCalendar                  | growFromTrigger                                                          |
| pages/plan-tab/PlanDayMenu                                | growFromTrigger                                                          |
| induction/InductionGuide, GuideParts, EntryHand           | stepX (Back reverses)                                                    |
| onboarding/OnboardingFlow                                 | stepX                                                                    |
| Pipeline, Briefs, Plan, Activity, chat cards, search      | growFromCard into the detail page                                        |

## Tests

- Unit tests (jsdom) have no Web Animations, so every move is instant there; tests stub `HTMLElement.prototype.animate` to see a move run.
- The e2e harness (`e2e/harness/main.tsx`) runs with motion off (`?motion=0`, remembered for the tab) so specs measure and shoot the rest state; a spec that needs motion opens its page with `?motion=1`.
