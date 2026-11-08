import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Visual coverage: every page, sheet, menu and picker has a screen in
// e2e/visual/screens.spec.ts and a committed baseline in each project it runs
// in (e2e/visual/__screenshots__/<project>/<name>.png). A new screen goes in
// REQUIRED here and in the spec in the same PR; its baselines come from CI (a
// commit with [update-visual-baselines]), so this fails until they land.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VISUAL = `${ROOT}e2e/visual/`;
const SPEC = readFileSync(`${VISUAL}screens.spec.ts`, 'utf8');
const ONBOARDING = readFileSync(`${VISUAL}onboarding-steps.ts`, 'utf8');

type Project = 'iphone-light' | 'iphone-dark' | 'laptop-light' | 'laptop-dark';

/** The projects every screen runs in unless it is an exception below. */
const DEFAULT_PROJECTS: readonly Project[] = ['iphone-light', 'iphone-dark', 'laptop-light'];

/** Every screen name, sorted. */
const REQUIRED: readonly string[] = [
  'account-menu-density',
  'activity-bank',
  'activity-catch-up-bar',
  'activity-chip-mentions',
  'activity-chip-unread',
  'approve-confirm-approver',
  'asset-picker',
  'asset-rename-saving',
  'assets',
  'assets-approver',
  'assets-empty',
  'assets-files-approver',
  'assets-select',
  'assets-tab-docs',
  'assets-tab-links',
  'assets-tab-media',
  'boxes-activity',
  'boxes-members',
  'boxes-plan-tab',
  'brief-detail',
  'brief-more-menu',
  'brief-picker',
  'briefs-approver',
  'briefs-empty',
  'chat-composer-keyboard',
  'chat-composer-recording',
  'chat-delete-sheet-everyone',
  'chat-delete-sheet-me',
  'chat-dm-private-reply-bubble',
  'chat-dm-private-reply-long',
  'chat-dm-private-reply-long-sent',
  'chat-dm-private-reply-strip',
  'chat-home-chip-files',
  'chat-home-chip-files-dark',
  'chat-home-chip-links',
  'chat-home-chip-links-dark',
  'chat-home-chip-photos',
  'chat-home-chip-photos-dark',
  'chat-home-chip-select',
  'chat-home-chip-videos',
  'chat-home-chip-videos-dark',
  'chat-home-chip-voice-notes',
  'chat-home-chip-voice-notes-dark',
  'chat-idea-card',
  'chat-idea-share-sheet',
  'chat-info-group',
  'chat-list',
  'chat-list-calm',
  'chat-list-compact',
  'chat-list-notes-photo',
  'chat-list-select',
  'chat-media-lightbox-details',
  'chat-media-lightbox-details-dark',
  'chat-message-menu-reply-privately',
  'chat-message-not-sent',
  'chat-message-pending',
  'chat-own-post-card',
  'chat-plan-card',
  'chat-post-sheet',
  'chat-post-sheet-approver',
  'chat-post-sheet-scrolled',
  'chat-select-mode',
  'chat-status-drawer',
  'chat-status-drawer-plan',
  'chat-tasks-delete',
  'chat-tasks-past',
  'chat-tasks-row-menu',
  'chat-tasks-saving',
  'chat-tasks-sheet',
  'chat-tasks-swipe',
  'chat-thread',
  'chat-thread-files-removed',
  'chat-thread-group',
  'chat-thread-own-voice',
  'chat-tombstone',
  'chat-tombstone-menu',
  'chat-upload-progress',
  'chat-viewer-bar',
  // Chat media sweep: single photos, albums, sending states, links, plan dates, sheet back.
  'chat-photo-single-portrait',
  'chat-photo-single-landscape',
  'chat-photo-single-square',
  'chat-album-2',
  'chat-album-3',
  'chat-album-4',
  'chat-send-queued-photo',
  'chat-send-uploading-album',
  'chat-send-uploading-video',
  'chat-send-uploading-file',
  'chat-send-failed-photo',
  'chat-send-failed-file',
  'chat-link-youtube',
  'chat-link-no-picture',
  'plan-dates-sheet',
  'sheet-header-back',
  'chat-viewer-delete-sheet',
  'chat-voice-sending',
  'chat-voice-uploading',
  'chip-row-hover',
  'cockpit-dot-green',
  'cockpit-dot-green-dark',
  'cockpit-dot-red',
  'cockpit-dot-red-dark',
  'cockpit-panel-needs',
  'cockpit-panel-needs-dark',
  'cockpit-panel-users',
  'cockpit-panel-users-dark',
  'cockpit-sheet-traffic',
  'cockpit-sheet-users',
  'code-step-error-focused',
  'command-palette',
  'command-palette-recents',
  'command-palette-recents-cleared',
  'command-palette-search-empty',
  'composer-tray',
  'confirm-dialog-delete',
  'confirm-dialog-discard',
  'contact-files-select',
  'contact-media-select',
  'create-brief-sheet-approver',
  'create-post-sheet',
  'forward-picker',
  'help',
  'homepage',
  'member-sheet',
  'member-sheet-dark',
  'members',
  'message-action-menu',
  'new-chat-group-limit-member',
  'new-chat-group-limit-member-dark',
  'new-chat-group-limit-owner',
  'new-chat-group-limit-owner-dark',
  'new-chat-sheet',
  'notifications',
  'on-behalf-confirm',
  'onboarding-brand',
  'onboarding-done',
  'onboarding-first-post',
  'onboarding-invite-accept',
  'onboarding-invite-approver',
  'onboarding-name',
  'onboarding-photo-crop',
  'onboarding-role',
  'onboarding-side',
  'onboarding-sign-in',
  'onboarding-sign-in-code',
  'onboarding-sign-in-code-error',
  'onboarding-sign-in-code-filled',
  'onboarding-sign-up',
  'onboarding-sign-up-code',
  'onboarding-tour-1',
  'onboarding-tour-2',
  'onboarding-tour-3',
  'onboarding-tour-intro',
  'onboarding-waiting',
  'onboarding-welcome',
  'onboarding-workspace-confirm',
  'onboarding-workspace-name',
  'onboarding-workspace-slot',
  'person-card',
  'person-card-dark',
  'person-card-inline',
  'person-card-inline-context',
  'person-card-inline-laptop',
  'person-card-removed',
  'person-card-self',
  'person-photo-viewer',
  'person-photo-viewer-laptop',
  'pipeline',
  'pipeline-approver',
  'pipeline-chip-all',
  'pipeline-chip-approved',
  'pipeline-chip-draft',
  'pipeline-chip-parked',
  'pipeline-chip-rejected',
  'pipeline-overdue',
  'pipeline-select-1',
  'pipeline-select-2',
  'plan-from-bank',
  'plan-item',
  'plan-item-bank',
  'plan-item-bank-more-menu',
  'plan-item-mention-picker',
  'plan-item-more-menu',
  'plan-item-notes',
  'plan-item-thread',
  'plan-item-thread-approver',
  'plan-picker',
  'plan-screen',
  'plan-screen-today',
  'plan-screen-today-dark',
  'plan-screen-trace',
  'plan-share-draft-sheet',
  'plan-tab',
  'plan-tab-bank',
  'plan-tab-bank-add',
  'plan-tab-bank-filter',
  'plan-tab-bank-filter-bucket-menu',
  'plan-tab-bank-plan-it',
  'plan-tab-bank-select',
  'plan-tab-ended',
  'plan-tab-live',
  'plan-tab-week-zero',
  'post-approve-busy',
  'post-comment-file-viewer',
  'post-detail',
  'post-detail-approved',
  'post-detail-approver',
  'post-more-menu',
  'post-picker',
  'post-preview-facebook',
  'post-preview-instagram',
  'post-preview-linkedin',
  'post-preview-threads',
  'post-preview-tiktok',
  'post-preview-x',
  'post-preview-youtube-shorts',
  'post-thread-folded',
  'recently-deleted',
  'recently-deleted-empty',
  'select-open',
  'settings-profile',
  'settings-profile-paused',
  'settings-profile-switch-off',
  'settings-workspace',
  'support-contact-sheet',
  'support-contact-sheet-dark',
  'viewer-remove',
  // One search, the top bar and the chip row (7 Nov 2026): sorts, Activity at
  // 0 unread, palette pick mode, Select pressed, upload states.
  'activity-all-read',
  'assets-select-on',
  'assets-sort',
  'assets-upload-uploading',
  'briefs',
  'briefs-sort',
  'chat-list-select-on',
  'chat-list-sort',
  'concept-chip-failed',
  'concept-chip-ready',
  'concept-chip-uploading',
  'onboarding-first-post-uploading',
  'palette-pick',
  'pipeline-select-on',
  'pipeline-sort',
  'plan-tab-bank-select-on',
  'plan-tab-chip-past',
  'plan-tab-sort',
  'post-tile-uploading',
  // Density (Compact / Cozy / Calm, 8 Nov 2026): the account menu row, New
  // plan's Add from bank, and the plan screen and two lists per density.
  'new-plan-bank',
  'pipeline-calm',
  'pipeline-compact',
  'plan-screen-calm',
  'plan-screen-compact',
  'plan-screen-cozy',
  // The writing box (ui/WritingBox, Slack style, 8 Nov 2026): the chat pill,
  // the card focused and typing, the Aa row, @, the + drawer from the card,
  // the emoji and Add link sheets, the expanded editor (phone) and box
  // (laptop), bubbles with blocks, and the comment, field and caption boxes.
  'add-link-sheet',
  'brief-field-row',
  'chat-box-expanded',
  'chat-box-expanded-laptop',
  'chat-box-focused',
  'chat-box-format-row',
  'chat-box-idle',
  'chat-box-mention',
  'chat-box-tray',
  'chat-box-typing',
  'chat-bubble-blocks',
  'emoji-sheet',
  'post-caption-box',
  'post-comment-box',
  // Work-chat threads (8 Nov 2026): the More actions page, the group layout,
  // the replies row and the thread screen.
  'message-action-menu-more',
  'chat-group-work',
  'chat-replies-row',
  'chat-thread-screen',
  'chat-thread-screen-plan',
  // Catch up (8 Nov 2026): the cards, the swipe frames, typing, the end
  // screen; and the thread view redo (root at top, divider icons).
  'catch-up-comment',
  'catch-up-end',
  'catch-up-swipe-keep',
  'catch-up-swipe-read',
  'catch-up-thread-mention',
  'catch-up-thread-started',
  'catch-up-typing',
  'chat-thread-view-divider',
  // Flat finish (8 Nov 2026): own edited comment, its inline editor with Save
  // in view, and the Edit concept day tiles with one picked.
  'plan-day-picker',
  'post-comment-edited',
  'post-comment-editing',
];

/** A name and its laptop dark twin (the loops over dark false/true). */
const withDark = (name: string): string[] => [name, `${name}-dark`];

/** The chat home's media chips (MEDIA_CHIP_SCREENS in the spec). */
const CHIPS = ['photos', 'videos', 'links', 'files', 'voice-notes'];
const CHIP = 'chat-home-chip-';

/**
 * Names the spec builds in loops (a template literal, not a literal name): the
 * exact source of each template and the names it expands to.
 */
const GENERATED: Readonly<Record<string, readonly string[]>> = {
  'name: `cockpit-dot-${level}`': ['cockpit-dot-green', 'cockpit-dot-red'],
  'name: `cockpit-dot-${level}-dark`': ['cockpit-dot-green-dark', 'cockpit-dot-red-dark'],
  'name: `cockpit-panel-needs${suffix}`': withDark('cockpit-panel-needs'),
  'name: `cockpit-panel-users${suffix}`': withDark('cockpit-panel-users'),
  'name: `new-chat-group-limit-owner${suffix}`': withDark('new-chat-group-limit-owner'),
  'name: `new-chat-group-limit-member${suffix}`': withDark('new-chat-group-limit-member'),
  'name: `support-contact-sheet${suffix}`': withDark('support-contact-sheet'),
  'name: `chat-home-chip-${chip.name}${suffix}`': CHIPS.flatMap((c) => withDark(`${CHIP}${c}`)),
  'name: `chat-media-lightbox-details${suffix}`': withDark('chat-media-lightbox-details'),
  // The six ListCard lists, chip by chip (7 Nov 2026).
  'name: `pipeline-chip-${stage}`': ['all', 'draft', 'approved', 'parked', 'rejected'].map(
    (stage) => `pipeline-chip-${stage}`,
  ),
  'name: `assets-tab-${tab}`': ['media', 'docs', 'links'].map((tab) => `assets-tab-${tab}`),
  'name: `activity-chip-${chip}`': ['unread', 'mentions'].map((chip) => `activity-chip-${chip}`),
  // Chat media sweep (7 Nov 2026): single photos by shape, albums by count.
  'name: `chat-photo-single-${shape}`': ['portrait', 'landscape', 'square'].map(
    (shape) => `chat-photo-single-${shape}`,
  ),
  'name: `chat-album-${count}`': [2, 3, 4].map((count) => `chat-album-${count}`),
  'name: `plan-tab-chip-${chip}`': ['past'].map((chip) => `plan-tab-chip-${chip}`),
  // Density (Compact / Cozy / Calm, 8 Nov 2026).
  'name: `plan-screen-${density}`': ['compact', 'cozy', 'calm'].map(
    (density) => `plan-screen-${density}`,
  ),
  'name: `pipeline-${density}`': ['compact', 'calm'].map((density) => `pipeline-${density}`),
  'name: `chat-list-${density}`': ['compact', 'calm'].map((density) => `chat-list-${density}`),
  // The platform preview, one per platform (post screen redo, 7 Nov 2026).
  'name: `post-preview-${p.slug}`': [
    'instagram',
    'facebook',
    'linkedin',
    'x',
    'threads',
    'tiktok',
    'youtube-shorts',
  ].map((slug) => `post-preview-${slug}`),
};

interface Exception {
  projects: readonly Project[];
  reason: string;
}

/** Phone-only screens (skipped on laptop: `only: 'phone'`). */
const PHONE_ONLY_NAMES = [
  'plan-tab-week-zero',
  'cockpit-sheet-users',
  'cockpit-sheet-traffic',
  'person-card-inline',
  'chat-tasks-swipe',
  'chat-composer-keyboard',
  'chat-box-idle',
  'chat-box-expanded',
];

/**
 * Laptop-only light screens (`only: 'laptop'`): the Cockpit side panel, the
 * chip hover (a hover pointer) and the writing box grown in place.
 */
const LAPTOP_LIGHT_NAMES = [
  'cockpit-panel-needs',
  'cockpit-panel-users',
  'chip-row-hover',
  'chat-box-expanded-laptop',
];

/** Laptop dark shots taken in the laptop-light project (`only: 'laptop', dark: true`). */
const LAPTOP_FORCED_DARK_NAMES = [
  'member-sheet-dark',
  'cockpit-dot-green-dark',
  'cockpit-dot-red-dark',
  'cockpit-panel-needs-dark',
  'cockpit-panel-users-dark',
  'plan-screen-today-dark',
  'new-chat-group-limit-owner-dark',
  'new-chat-group-limit-member-dark',
  'support-contact-sheet-dark',
  ...CHIPS.map((c) => `${CHIP}${c}-dark`),
  'chat-media-lightbox-details-dark',
  'person-card-dark',
  'person-card-inline-laptop',
  'person-photo-viewer-laptop',
  'chat-dm-private-reply-long-sent',
];

/** Screens that do not run in every default project, and why. */
function exceptions(): Record<string, Exception> {
  const out: Record<string, Exception> = {
    homepage: {
      projects: ['iphone-light', 'laptop-light'],
      reason: 'the homepage is light-only (skipped in every dark project)',
    },
  };
  for (const name of PHONE_ONLY_NAMES) {
    out[name] = { projects: ['iphone-light', 'iphone-dark'], reason: 'a phone-only surface' };
  }
  for (const name of LAPTOP_LIGHT_NAMES) {
    out[name] = { projects: ['laptop-light'], reason: 'a laptop-only surface' };
  }
  for (const name of LAPTOP_FORCED_DARK_NAMES) {
    out[name] = { projects: ['laptop-light'], reason: 'dark forced in the laptop-light project' };
  }
  return out;
}

const EXCEPTIONS = exceptions();

/** Literal screen names (`name: 'x',` at a line start or opening an object). */
function literalNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^[ \t]*|\{ )name: '([a-z0-9]+(?:-[a-z0-9]+)*)',/gm)) {
    out.push(m[1] ?? '');
  }
  return out;
}

/** The names the spec tags @laptop-dark (its LAPTOP_DARK_SCREENS set). */
function laptopDarkNames(): string[] {
  const block = /const LAPTOP_DARK_SCREENS = new Set\(\[([\s\S]*?)\]\)/.exec(SPEC)?.[1] ?? '';
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] ?? '');
}

const DEFINED = new Set([
  ...literalNames(SPEC),
  ...literalNames(ONBOARDING),
  ...Object.entries(GENERATED)
    .filter(([source]) => SPEC.includes(source))
    .flatMap(([, names]) => names),
]);
const LAPTOP_DARK = new Set(laptopDarkNames());

function projectsFor(name: string): Project[] {
  const base = [...(EXCEPTIONS[name]?.projects ?? DEFAULT_PROJECTS)];
  if (LAPTOP_DARK.has(name)) base.push('laptop-dark');
  return base;
}

describe('visual coverage', () => {
  it('REQUIRED has no duplicates', () => {
    expect(REQUIRED.length).toBe(new Set(REQUIRED).size);
  });

  it('every generated template is still in the spec', () => {
    const gone = Object.keys(GENERATED).filter((source) => !SPEC.includes(source));
    expect(gone, `templates gone from screens.spec.ts:\n${gone.join('\n')}`).toEqual([]);
  });

  it('every REQUIRED screen is defined in screens.spec.ts', () => {
    const missing = REQUIRED.filter((name) => !DEFINED.has(name));
    expect(missing, `no screen in the spec:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every screen in screens.spec.ts is in REQUIRED', () => {
    const required = new Set(REQUIRED);
    const extra = [...DEFINED].filter((name) => !required.has(name)).sort();
    expect(extra, `spec screens missing from REQUIRED:\n${extra.join('\n')}`).toEqual([]);
  });

  it('every exception and @laptop-dark name is a REQUIRED screen', () => {
    const required = new Set(REQUIRED);
    const stray = [...Object.keys(EXCEPTIONS), ...LAPTOP_DARK].filter((n) => !required.has(n));
    expect(LAPTOP_DARK.size).toBeGreaterThan(0);
    expect(stray, `unknown names:\n${stray.join('\n')}`).toEqual([]);
  });

  it('every screen has a baseline in each project it runs in', () => {
    const missing = REQUIRED.flatMap((name) =>
      projectsFor(name)
        .map((project) => `e2e/visual/__screenshots__/${project}/${name}.png`)
        .filter((path) => !existsSync(`${ROOT}${path}`)),
    );
    expect(missing, `missing baselines:\n${missing.join('\n')}`).toEqual([]);
  });
});
