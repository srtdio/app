# PR 1: Visible and lit, before and after

Every field, edge, state and outline clears 3:1 in light and dark; one lighting look on every
surface, shell and state. This page lists the shots to compare. The images are produced by Visual
CI from the harness (`e2e/visual/screens.spec.ts`, the projects of
`e2e/visual/playwright.visual.config.ts`); they are not captured locally. Visual CI copies each
baseline it writes to `docs/review/pr1/after/` and the `main` baseline of the same screen to
`docs/review/pr1/before/`, named `<shot>__<phone|laptop>__<light|dark>.png`.

Phone is the `iphone-light` / `iphone-dark` project, laptop the `laptop-light` / `laptop-dark`
project. A cell marked "n/a" is a state that layout does not have (a mouse-only drag, a hover).
New screens have no `before`: their `before` cell is the closest existing screen, named in the
Source column.

## Shots

| Shot            | Source screen (visual suite)                                             | What to look at                                                              |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| sign-in         | `onboarding-sign-in`                                                     | Email field: border-field line at rest, lit-well                             |
| code-step       | `code-step-error-focused` (new; before: `onboarding-sign-in-code-error`) | Invalid boxes lit-bad, the focus line kept on the active box                 |
| chat-own-voice  | `chat-thread-own-voice` (new; before: `chat-thread`)                     | Own bubble in dark: on-bubble bars, speed pill, transcript link              |
| chat-composer   | `chat-thread`                                                            | Composer textarea border-field; send button; day pill edge                   |
| pipeline-drop   | `pipeline-drag-drop` (new; before: `pipeline`)                           | Lifted card lit-float; Review column 1px dashed lit-drop with its inset ring |
| settings-switch | `settings-profile-switch-off` (new; before: `settings-profile`)          | Off track: panel-2 well, border-strong edge; knob lighter than track         |
| plan-week       | `plan-tab-week`                                                          | Segment well border-field, today edge, chip edges                            |
| activity        | `notifications`                                                          | Read bar border-strong, row hover/focus, icon tiles lit-media                |
| assets          | `assets`                                                                 | Cards rounded-xl lit-card, type tab counts hold their slot                   |
| post-comments   | `post-detail`                                                            | Comment composer bg-panel on the panel-2 card, row actions                   |
| select-open     | `select-open` (new; before: `create-post-sheet`)                         | Option list lit-overlay, picked option lit-selected                          |
| chip-hover      | `chip-row-hover` (new; before: `settings-profile-paused`)                | Hover overlay on the unselected chip beside the selected one                 |

## Images

| Shot            | Phone light                                            | Phone dark                                            | Laptop light                                            | Laptop dark                                            |
| --------------- | ------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| sign-in         | `pr1/{before,after}/sign-in__phone__light.png`         | `pr1/{before,after}/sign-in__phone__dark.png`         | `pr1/{before,after}/sign-in__laptop__light.png`         | `pr1/{before,after}/sign-in__laptop__dark.png`         |
| code-step       | `pr1/{before,after}/code-step__phone__light.png`       | `pr1/{before,after}/code-step__phone__dark.png`       | `pr1/{before,after}/code-step__laptop__light.png`       | `pr1/{before,after}/code-step__laptop__dark.png`       |
| chat-own-voice  | `pr1/{before,after}/chat-own-voice__phone__light.png`  | `pr1/{before,after}/chat-own-voice__phone__dark.png`  | `pr1/{before,after}/chat-own-voice__laptop__light.png`  | `pr1/{before,after}/chat-own-voice__laptop__dark.png`  |
| chat-composer   | `pr1/{before,after}/chat-composer__phone__light.png`   | `pr1/{before,after}/chat-composer__phone__dark.png`   | `pr1/{before,after}/chat-composer__laptop__light.png`   | `pr1/{before,after}/chat-composer__laptop__dark.png`   |
| pipeline-drop   | n/a (mouse drag)                                       | n/a (mouse drag)                                      | `pr1/{before,after}/pipeline-drop__laptop__light.png`   | `pr1/{before,after}/pipeline-drop__laptop__dark.png`   |
| settings-switch | `pr1/{before,after}/settings-switch__phone__light.png` | `pr1/{before,after}/settings-switch__phone__dark.png` | `pr1/{before,after}/settings-switch__laptop__light.png` | `pr1/{before,after}/settings-switch__laptop__dark.png` |
| plan-week       | `pr1/{before,after}/plan-week__phone__light.png`       | `pr1/{before,after}/plan-week__phone__dark.png`       | `pr1/{before,after}/plan-week__laptop__light.png`       | `pr1/{before,after}/plan-week__laptop__dark.png`       |
| activity        | `pr1/{before,after}/activity__phone__light.png`        | `pr1/{before,after}/activity__phone__dark.png`        | `pr1/{before,after}/activity__laptop__light.png`        | `pr1/{before,after}/activity__laptop__dark.png`        |
| assets          | `pr1/{before,after}/assets__phone__light.png`          | `pr1/{before,after}/assets__phone__dark.png`          | `pr1/{before,after}/assets__laptop__light.png`          | `pr1/{before,after}/assets__laptop__dark.png`          |
| post-comments   | `pr1/{before,after}/post-comments__phone__light.png`   | `pr1/{before,after}/post-comments__phone__dark.png`   | `pr1/{before,after}/post-comments__laptop__light.png`   | `pr1/{before,after}/post-comments__laptop__dark.png`   |
| select-open     | `pr1/{before,after}/select-open__phone__light.png`     | `pr1/{before,after}/select-open__phone__dark.png`     | `pr1/{before,after}/select-open__laptop__light.png`     | `pr1/{before,after}/select-open__laptop__dark.png`     |
| chip-hover      | n/a (hover pointer)                                    | n/a (hover pointer)                                   | `pr1/{before,after}/chip-hover__laptop__light.png`      | `pr1/{before,after}/chip-hover__laptop__dark.png`      |

## Laptop dark

The visual suite's `laptop-dark` project runs only the screens in `LAPTOP_DARK_SCREENS`
(`chat-thread`, `chat-thread-own-voice`, `pipeline`, `plan-tab`, `post-detail`, `assets`,
`settings-profile`, and others) plus the forced-dark `-dark` twins. For the other shots above, the
laptop dark image comes from the same screen run with the dark scheme emulated in the review
capture; nothing in the suite's baselines changes for it.

## Changed screens

Every baseline that moves in this PR is listed in the PR body (CLAUDE.md: every UI change updates
the visual baselines in the same PR and lists the changed screens). New screens in this PR:
`pipeline-drag-drop`, `chat-thread-own-voice`, `settings-profile-switch-off`, `chip-row-hover`,
`select-open`, `code-step-error-focused`.
