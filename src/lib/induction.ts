// Pure logic for the induction: the guided first run on the real screens
// (src/components/induction/**). No network, no React. The steps come from the
// route scripts (src/lib/induction-routes.ts); every function here takes the
// script as a parameter, so the rules are unit tested on small fixture
// scripts: which step is up (resolve), where it moves next, Back, the 4 s
// skip, the progress fill, the box and label geometry, and the upload copy of
// the first post.

import { INDUCTION_KEYS, type InductionKey } from './induction-keys';
import {
  ROUTE_PREFIX,
  type Card,
  type Chapter,
  type InductionFacts,
  type RouteScript,
  type Step,
  type StepPlace,
} from './induction-model';
import { isApplicable } from './induction-routes';

export { INDUCTION_KEYS, inductionSelector, type InductionKey } from './induction-keys';

/** Success sites dispatch this so the guide refetches induction_state at once. */
export const INDUCTION_REFRESH_EVENT = 'sorted:induction-refresh';

export function dispatchInductionRefresh(): void {
  window.dispatchEvent(new CustomEvent(INDUCTION_REFRESH_EVENT));
}

/** The 4 s poll, only while a data-finished step is active. */
export const INDUCTION_POLL_MS = 4000;

/** How long a step's control may stay off screen before the guide moves on. */
export const ABSENT_SKIP_MS = 4000;

/**
 * Stored step ids outside the route scripts: the approver who signed up alone
 * (naming their team, then waiting for it). The Creator's start is the first
 * creator step.
 */
export const APPROVER_BRAND_STEP = 'approver_brand';
export const APPROVER_WAITING_STEP = 'approver_waiting';
export const WORKSPACE_STEP = `${ROUTE_PREFIX.creator}workspace`;

/** Where an approver who signed up alone is, from the stored step. */
export type ApproverStage = 'none' | 'brand' | 'waiting';

export function approverStageOf(state: Pick<InductionState, 'step' | 'done'>): ApproverStage {
  if (state.done) return 'none';
  if (state.step === APPROVER_BRAND_STEP) return 'brand';
  if (state.step === APPROVER_WAITING_STEP) return 'waiting';
  return 'none';
}

/** Mirrors the induction_step_set check (^[a-z0-9_]{1,40}$). */
export const STEP_ID_PATTERN = /^[a-z0-9_]{1,40}$/;

// ---------- state ----------

/** induction_state, narrowed. Fields the proc returns as null stay null. */
export interface InductionState {
  step: string | null;
  done: boolean;
  role: string | null;
  postId: string | null;
  clientInvited: boolean;
  teamInvited: boolean;
}

/**
 * The state used when induction_state cannot be read: done, so a failed read
 * never traps anyone in a guide. The next refetch (route change, event) heals it.
 */
export const FAIL_OPEN_STATE: InductionState = {
  step: null,
  done: true,
  role: null,
  postId: null,
  clientInvited: false,
  teamInvited: false,
};

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Narrow the jsonb induction_state returns; anything malformed fails open. */
export function parseInductionState(raw: unknown): InductionState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return FAIL_OPEN_STATE;
  const record = raw as Record<string, unknown>;
  return {
    step: stringField(record, 'step'),
    done: stringField(record, 'done_at') !== null,
    role: stringField(record, 'role'),
    postId: stringField(record, 'post_id'),
    clientInvited: record.client_invited === true,
    teamInvited: record.team_invited === true,
  };
}

// ---------- step data ----------

/** What the engine reads to decide a step: the stored state and the workspace facts. */
export interface EngineInput {
  state: InductionState;
  facts: InductionFacts;
}

/** Whether the data already finished a step. 'none' steps are finished by the DOM, never here. */
export function stepDataDone(step: Pick<Step, 'dataDone'>, input: EngineInput): boolean {
  switch (step.dataDone) {
    case 'none':
      return false;
    case 'hasWorkspace':
      return input.facts.hasWorkspace;
    case 'firstPostSent':
      return input.state.postId !== null;
    case 'clientInvited':
      return input.state.clientInvited;
    case 'teamInvited':
      return input.state.teamInvited;
  }
}

/** Steps the data finishes and the guide polls for (setup and gate). */
export function isGated(step: Pick<Step, 'kind'>): boolean {
  return step.kind === 'gate' || step.kind === 'setup';
}

/** The script's steps that apply to this workspace, in order. */
export function applicableSteps(script: RouteScript, facts: InductionFacts): readonly Step[] {
  return script.steps.filter((step) => isApplicable(step, facts));
}

/** The first look-around (chapter) step, or -1 when the route has none. */
export function firstLookAroundIndex(steps: readonly Step[]): number {
  return steps.findIndex((step) => step.chapter !== undefined);
}

// ---------- resolution ----------

export type Resolution =
  | { kind: 'off' }
  | { kind: 'intro'; card: Card; steps: readonly Step[]; index: number }
  | { kind: 'step'; step: Step; steps: readonly Step[]; index: number }
  | { kind: 'closing'; card: Card; steps: readonly Step[] };

/**
 * Where the stored id points. A step id resolves within the route (a step the
 * facts dropped moves on to the next one that applies); the intro id points at
 * the first look-around step and the closing id past the end. Anything else (an
 * old or foreign id) resumes after the furthest step the data has finished, so
 * nobody restarts from zero when the data shows progress.
 */
function startIndex(script: RouteScript, steps: readonly Step[], input: EngineInput): number {
  const stored = input.state.step;
  if (stored === script.intro.id) return Math.max(0, firstLookAroundIndex(steps));
  if (stored === script.closing.id) return steps.length;
  const inScript = script.steps.findIndex((step) => step.id === stored);
  if (inScript >= 0) {
    const later = script.steps.slice(inScript).find((step) => steps.includes(step));
    return later === undefined ? steps.length : steps.indexOf(later);
  }
  return afterData(steps, input);
}

function afterData(steps: readonly Step[], input: EngineInput): number {
  let last = -1;
  steps.forEach((step, i) => {
    if (step.dataDone !== 'none' && stepDataDone(step, input)) last = i;
  });
  return last + 1;
}

/**
 * An earlier open setup or gate wins over a later stored step: the person goes
 * back to the first open step of that gate's group (the steps sharing its
 * data), unless the stored step is already inside that group.
 */
function gateOverride(steps: readonly Step[], at: number, input: EngineInput): number {
  const gate = steps.findIndex((step) => isGated(step) && !stepDataDone(step, input));
  const gateStep = steps[gate];
  if (gateStep === undefined || gate >= at) return at;
  if (steps[at]?.dataDone === gateStep.dataDone) return at;
  const first = steps.findIndex(
    (step) => step.dataDone === gateStep.dataDone && !stepDataDone(step, input),
  );
  return first < 0 ? gate : first;
}

function skipDone(steps: readonly Step[], at: number, input: EngineInput): number {
  let i = at;
  while (i < steps.length && stepDataDone(steps[i] as Step, input)) i += 1;
  return i;
}

/**
 * What the guide shows for a route: the stored step (resolved as above), the
 * intro card before the first look-around step (until Start stores that step),
 * or the closing card when nothing is left. Off once done.
 */
export function resolveGuide(script: RouteScript, input: EngineInput): Resolution {
  if (input.state.done) return { kind: 'off' };
  const steps = applicableSteps(script, input.facts);
  const at = skipDone(steps, gateOverride(steps, startIndex(script, steps, input), input), input);
  const step = steps[at];
  if (step === undefined) return { kind: 'closing', card: script.closing, steps };
  if (at === firstLookAroundIndex(steps) && input.state.step !== step.id) {
    return { kind: 'intro', card: script.intro, steps, index: at };
  }
  return { kind: 'step', step, steps, index: at };
}

/**
 * The id to store when the guide moves from one step to another: the intro id
 * when it enters the look-around from a setup step, the closing id past the end.
 */
export function storedIdFor(
  script: RouteScript,
  steps: readonly Step[],
  move: { from: number; to: number },
): string {
  const target = steps[move.to];
  if (target === undefined || move.to < 0) return script.closing.id;
  const first = firstLookAroundIndex(steps);
  if (move.to === first && move.from < first) return script.intro.id;
  return target.id;
}

/** Whether a tap or the DOM may finish a step. A gate, and the last setup step of its group, wait for the data. */
export function completesByUi(steps: readonly Step[], index: number): boolean {
  const step = steps[index];
  if (step === undefined || step.kind === 'gate') return false;
  if (step.kind !== 'setup') return true;
  return steps[index + 1]?.dataDone === step.dataDone;
}

/** Live answers about a step's control and data, injected so the rules stay pure. */
export interface StepProbe {
  visible: (step: Step) => boolean;
  done: (step: Step) => boolean;
}

/**
 * Back: the previous step when its control is on screen, else the nearest
 * earlier one whose control is, else the nearest earlier step at all (its
 * place opens). Never a step the data finished (Back never undoes data). -1
 * hides Back: the first step, or every earlier step is finished by the data.
 */
export function backIndex(steps: readonly Step[], index: number, probe: StepProbe): number {
  let fallback = -1;
  for (let j = Math.min(index, steps.length) - 1; j >= 0; j -= 1) {
    const step = steps[j] as Step;
    if (probe.done(step)) continue;
    if (probe.visible(step)) return j;
    if (fallback < 0) fallback = j;
  }
  return fallback;
}

/** The nearest earlier visible step that shares this step's data (the first post's own steps). */
function backInGroup(steps: readonly Step[], index: number, probe: StepProbe): number {
  const key = steps[index]?.dataDone;
  if (key === undefined || key === 'none') return -1;
  for (let j = index - 1; j >= 0; j -= 1) {
    const step = steps[j] as Step;
    if (step.dataDone !== key) return -1;
    if (probe.visible(step)) return j;
  }
  return -1;
}

/** The chapter or phase a step belongs to ('' when neither). */
function sectionOf(step: Step): string {
  return step.chapter ?? step.phase ?? '';
}

/**
 * Where the 4 s rule moves a step whose control never showed: forward to the
 * next step on the same screen (same place, same chapter or phase) whose
 * control is visible, never past an open gate; else back within its own
 * group; else simply the next step, whose place then opens and gets its own
 * 4 s. A gate only ever goes back within its group, otherwise it stays.
 */
export function skipTarget(steps: readonly Step[], index: number, probe: StepProbe): number {
  const here = steps[index];
  if (here === undefined) return index;
  const back = backInGroup(steps, index, probe);
  if (here.kind === 'gate') return back >= 0 ? back : index;
  for (let j = index + 1; j < steps.length; j += 1) {
    const step = steps[j] as Step;
    if (step.place !== here.place || sectionOf(step) !== sectionOf(here)) break;
    if (probe.visible(step)) return j;
    if (isGated(step) && !probe.done(step)) break;
  }
  return back >= 0 ? back : index + 1;
}

/** The fill: (entry taps + steps behind) over (entry taps + every applicable step). */
export function progressOf(script: RouteScript, resolution: Resolution): number {
  if (resolution.kind === 'off') return 0;
  if (resolution.kind === 'closing') return 1;
  const total = script.entrySteps + resolution.steps.length;
  return total === 0 ? 1 : (script.entrySteps + resolution.index) / total;
}

/** The route's chapters in the order its steps run them. */
export function chapterOrder(steps: readonly Step[]): Chapter[] {
  const order: Chapter[] = [];
  for (const step of steps) {
    if (step.chapter !== undefined && !order.includes(step.chapter)) order.push(step.chapter);
  }
  return order;
}

// ---------- the post sheet ----------

const POST_SHEET_KEYS: readonly InductionKey[] = [
  INDUCTION_KEYS.pipelineCreate,
  INDUCTION_KEYS.postSheetCaption,
  INDUCTION_KEYS.postSheetFormat,
  INDUCTION_KEYS.postSheetFormatSingle,
  INDUCTION_KEYS.postSheetMedia,
  INDUCTION_KEYS.postSheetPrimary,
];

/** The preset primary while a first post step is up (creator and invited routes); undefined otherwise. */
export function presetPrimaryFor(step: Step): PostSheetPreset['primary'] | undefined {
  if (step.route === 'approver') return undefined;
  return step.targets.some((key) => POST_SHEET_KEYS.includes(key)) ? 'send_for_review' : undefined;
}

// ---------- routes ----------

export interface PlaceContext {
  postId: string | null;
  groupChannelId: string | null;
}

/** The route that shows a step's screen ('' for the shell step, which lives anywhere). */
export function placeRoute(place: StepPlace, ctx: PlaceContext): string {
  switch (place) {
    case 'shell':
      return '';
    case 'pipeline':
      return '/pipeline';
    case 'members':
      return '/settings?panel=members';
    case 'post':
      return ctx.postId !== null ? `/posts/${ctx.postId}` : '/pipeline';
    case 'briefs':
      return '/briefs';
    case 'activity':
      return '/activity';
    case 'chat':
      return '/chat';
    case 'group':
      return ctx.groupChannelId !== null
        ? `/chat?channel=${encodeURIComponent(ctx.groupChannelId)}`
        : '/chat';
  }
}

/** Whether the current location already shows a step's screen. */
export function onPlace(
  place: StepPlace,
  location: { pathname: string; search: string },
  ctx: PlaceContext,
): boolean {
  if (place === 'shell') return true;
  if (place === 'members') return location.pathname === '/settings';
  const channel = new URLSearchParams(location.search).get('channel');
  if (place === 'chat') return location.pathname === '/chat' && channel === null;
  if (place === 'group') return location.pathname === '/chat' && channel === ctx.groupChannelId;
  return location.pathname === placeRoute(place, ctx);
}

// ---------- geometry ----------

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 5px gap plus 2px of air: the hairline sits 7px off the control. */
export const BOX_GAP = 5;
export const BOX_AIR = 2;
const BOX_OUTSET = BOX_GAP + BOX_AIR;

/** The hairline's rect around a control's live rect. */
export function boxRect(target: Rect): Rect {
  return {
    top: target.top - BOX_OUTSET,
    left: target.left - BOX_OUTSET,
    width: target.width + BOX_OUTSET * 2,
    height: target.height + BOX_OUTSET * 2,
  };
}

/** How far inside the screen edge the box stays, so all four sides always show. */
const BOX_SCREEN_EDGE = 2;

/** The box kept inside the viewport: a full-width row gets its box pulled in rather than cut off. */
export function clampToViewport(rect: Rect, viewport: Size): Rect {
  const left = Math.max(rect.left, BOX_SCREEN_EDGE);
  const top = Math.max(rect.top, BOX_SCREEN_EDGE);
  const right = Math.min(rect.left + rect.width, viewport.width - BOX_SCREEN_EDGE);
  const bottom = Math.min(rect.top + rect.height, viewport.height - BOX_SCREEN_EDGE);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** The hairline radius from the control's own: 12 for a control up to 12px, else 16. */
export function guideRadius(controlRadiusPx: number): number {
  return controlRadiusPx <= 12 ? 12 : 16;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

const EDGE = 16;
const LABEL_GAP = 8;
/** A control this close to the right edge, and narrower than its label, takes the label on its left. */
const RIGHT_EDGE_ZONE = 72;

export type LabelSide = 'below' | 'above' | 'left';

export interface LabelPlacement {
  side: LabelSide;
  top: number;
  left: number;
}

/**
 * Where the label pill goes: below the box, above it when there is no room
 * below, or on its left in the same row for a short control at the right edge.
 * `area` is the free band (the viewport minus the guide bar). When the band has
 * no room, the label goes on the side with most room in the whole viewport,
 * over the bar if it must, but never over the box and never off screen.
 */
export function placeLabel(input: {
  box: Rect;
  label: Size;
  area: { top: number; bottom: number; width: number; viewportHeight: number };
}): LabelPlacement {
  const { box, label, area } = input;
  const left = clamp(
    box.left + box.width / 2 - label.width / 2,
    EDGE,
    area.width - EDGE - label.width,
  );
  const atRightEdge = box.left + box.width >= area.width - RIGHT_EDGE_ZONE;
  const leftSide = {
    side: 'left' as const,
    top: clamp(box.top + box.height / 2 - label.height / 2, area.top, area.bottom - label.height),
    left: box.left - LABEL_GAP - label.width,
  };
  if (atRightEdge && box.width < label.width && leftSide.left >= EDGE) return leftSide;
  const below = { side: 'below' as const, top: box.top + box.height + LABEL_GAP, left };
  if (below.top + label.height <= area.bottom) return below;
  const above = { side: 'above' as const, top: box.top - LABEL_GAP - label.height, left };
  if (above.top >= area.top) return above;
  if (leftSide.left >= EDGE) return leftSide;
  return placeLabelInViewport({ box, label, area });
}

/** The last resort: the side of the box with most room in the whole viewport. */
function placeLabelInViewport(input: {
  box: Rect;
  label: Size;
  area: { width: number; viewportHeight: number };
}): LabelPlacement {
  const { box, label, area } = input;
  const left = clamp(
    box.left + box.width / 2 - label.width / 2,
    EDGE,
    area.width - EDGE - label.width,
  );
  const roomBelow = area.viewportHeight - (box.top + box.height);
  const roomAbove = box.top;
  const below = roomBelow >= roomAbove;
  const top = below
    ? Math.min(box.top + box.height + LABEL_GAP, area.viewportHeight - label.height)
    : Math.max(box.top - LABEL_GAP - label.height, 0);
  return { side: below ? 'below' : 'above', top, left };
}

/** The gap between a docked bar and the screen edge (or the tab bar). */
export const DOCK_GAP = 8;

/**
 * The guide bar's side, by free space: bottom unless the bottom bar would
 * cover the box, then top unless the top bar would too; if both would, the
 * side with more room.
 */
export function barSide(
  box: Rect | undefined,
  frame: { viewportHeight: number; insets: { top: number; bottom: number }; barHeight: number },
): 'top' | 'bottom' {
  if (box === undefined) return 'bottom';
  const { viewportHeight, insets, barHeight } = frame;
  const bottomBarTop = viewportHeight - insets.bottom - DOCK_GAP - barHeight;
  const topBarBottom = insets.top + DOCK_GAP + barHeight;
  if (box.top + box.height <= bottomBarTop) return 'bottom';
  if (box.top >= topBarBottom) return 'top';
  const roomBelow = viewportHeight - insets.bottom - (box.top + box.height);
  const roomAbove = box.top - insets.top;
  return roomBelow >= roomAbove ? 'bottom' : 'top';
}

/** The hand's fingertip: a little below and right of the control's centre. */
export function handPoint(target: Rect): { x: number; y: number } {
  return {
    x: target.left + target.width / 2 + Math.min(8, target.width / 4),
    y: target.top + target.height / 2 + Math.min(8, target.height / 4),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// ---------- the first post ----------

/**
 * How the post sheet opens on a post step. The sheet hides owner, bucket,
 * origin and brief, takes the title from the caption and asks for media when
 * the format needs it. `share` is the default group to post the card into, or
 * 'no_group' when the workspace has none (the sheet says so instead).
 */
export interface PostSheetPreset {
  primary: 'send_for_review' | 'save_draft';
  share: { channelId: string; groupName: string } | 'no_group';
}

/** Formats a post can go out without media. Everything else needs a photo or a video. */
const MEDIA_OPTIONAL_FORMATS: readonly string[] = ['text', 'link', 'thread'];

export function formatNeedsMedia(format: string): boolean {
  return format !== '' && !MEDIA_OPTIONAL_FORMATS.includes(format);
}

/** The post title the preset derives from the caption: its first line, cut at a word, 80 chars max. */
export function titleFromCaption(caption: string): string {
  const line = (caption.trim().split('\n')[0] ?? '').trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).trimEnd();
}

/** Automatic retries after the first failed upload attempt. */
export const UPLOAD_RETRIES = 3;

function timesWord(n: number): string {
  if (n === 1) return 'once';
  if (n === 2) return 'twice';
  return `${n} times`;
}

/** The plain reason after the automatic retries ran out. */
export function uploadFailedReason(failedAttempts: number): string {
  return `The file did not reach us. Your connection dropped ${timesWord(failedAttempts)}. Try again or pick a smaller file.`;
}

export type RetryOutcome<T> = { ok: true; value: T } | { ok: false; failures: number };

/**
 * Run an attempt, then up to `retries` more while it fails. `onRetry` hears the
 * attempt number before each retry. Never throws: a throw counts as a failure.
 */
export async function withRetries<T>(
  attempt: () => Promise<{ ok: true; value: T } | { ok: false }>,
  retries: number,
  onRetry: (nextAttempt: number) => void,
): Promise<RetryOutcome<T>> {
  let failures = 0;
  for (let n = 0; n <= retries; n += 1) {
    if (n > 0) onRetry(n + 1);
    try {
      const result = await attempt();
      if (result.ok) return { ok: true, value: result.value };
    } catch {
      // A transport throw is one more failed attempt.
    }
    failures += 1;
  }
  return { ok: false, failures };
}

// ---------- the approver who signed up alone ----------

/** brand_agency_request failures as people read them. */
export function brandRequestErrorMessage(message: string): string {
  if (message.includes('too_many_requests')) {
    return 'You have sent this 5 times. Ask them to check spam, or write to us.';
  }
  if (message.includes('invalid_payload')) return 'Check the email address and try again.';
  return "We couldn't send that. Try again.";
}
