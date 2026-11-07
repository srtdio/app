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
  'activity-bank',
  'activity-chip-briefs',
  'activity-chip-mentions',
  'activity-chip-plans',
  'activity-chip-snoozed',
  'activity-chip-unread',
  'activity-chip-upcoming',
  'approve-confirm-approver',
  'asset-more-menu',
  'asset-picker',
  'asset-rename-saving',
  'assets',
  'assets-approver',
  'assets-empty',
  'assets-files-approver',
  'assets-search-empty',
  'assets-select',
  'assets-tab-docs',
  'assets-tab-links',
  'assets-tab-media',
  'assets-tab-pdf',
  'assets-tab-sheets',
  'boxes-activity',
  'boxes-members',
  'boxes-plan-tab',
  'brief-detail',
  'brief-more-menu',
  'brief-picker',
  'briefs-approver',
  'briefs-empty',
  'briefs-search-empty',
  'chat-actions-menu',
  'chat-composer-keyboard',
  'chat-composer-recording',
  'chat-composer-scheduling',
  'chat-dm-private-reply-bubble',
  'chat-dm-private-reply-long',
  'chat-dm-private-reply-long-sent',
  'chat-dm-private-reply-strip',
  'chat-format-strip',
  'chat-home-chip-files',
  'chat-home-chip-files-dark',
  'chat-home-chip-links',
  'chat-home-chip-links-dark',
  'chat-home-chip-photos',
  'chat-home-chip-photos-dark',
  'chat-home-chip-videos',
  'chat-home-chip-videos-dark',
  'chat-home-chip-voice-notes',
  'chat-home-chip-voice-notes-dark',
  'chat-idea-card',
  'chat-idea-share-sheet',
  'chat-info-group',
  'chat-list',
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
  'chat-search-empty',
  'chat-select-mode',
  'chat-status-drawer',
  'chat-status-drawer-plan',
  'chat-tasks-delete',
  'chat-tasks-past-full',
  'chat-tasks-row-menu',
  'chat-tasks-saving',
  'chat-tasks-search',
  'chat-tasks-sheet',
  'chat-tasks-swipe',
  'chat-thread',
  'chat-thread-files-removed',
  'chat-thread-group',
  'chat-thread-own-voice',
  'chat-upload-progress',
  'chat-voice-sending',
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
  'pipeline-search-empty',
  'pipeline-search-focused',
  'pipeline-search-typed',
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
  'plan-tab-bank-panel',
  'plan-tab-bank-plan-it',
  'plan-tab-bank-select',
  'plan-tab-bank-table',
  'plan-tab-chip-all',
  'plan-tab-chip-earlier',
  'plan-tab-chip-later',
  'plan-tab-chip-next',
  'plan-tab-month-trace',
  'plan-tab-week',
  'plan-tab-week-dark',
  'plan-tab-week-zero',
  'post-approve-busy',
  'post-detail',
  'post-detail-approver',
  'post-more-menu',
  'post-picker',
  'recently-deleted',
  'recently-deleted-empty',
  'reminder-sheet',
  'schedule-sheet',
  'select-open',
  'settings-profile',
  'settings-profile-paused',
  'settings-profile-switch-off',
  'settings-workspace',
  'support-contact-sheet',
  'support-contact-sheet-dark',
  'viewer-remove',
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
  'name: `plan-tab-week${suffix}`': withDark('plan-tab-week'),
  'name: `new-chat-group-limit-owner${suffix}`': withDark('new-chat-group-limit-owner'),
  'name: `new-chat-group-limit-member${suffix}`': withDark('new-chat-group-limit-member'),
  'name: `support-contact-sheet${suffix}`': withDark('support-contact-sheet'),
  'name: `chat-home-chip-${chip.name}${suffix}`': CHIPS.flatMap((c) => withDark(`${CHIP}${c}`)),
  'name: `chat-media-lightbox-details${suffix}`': withDark('chat-media-lightbox-details'),
  // The six ListCard lists, chip by chip (7 Nov 2026).
  'name: `pipeline-chip-${stage}`': ['all', 'draft', 'approved', 'parked', 'rejected'].map(
    (stage) => `pipeline-chip-${stage}`,
  ),
  'name: `assets-tab-${tab}`': ['media', 'pdf', 'docs', 'sheets', 'links'].map(
    (tab) => `assets-tab-${tab}`,
  ),
  'name: `activity-chip-${chip}`': [
    'unread',
    'mentions',
    'briefs',
    'plans',
    'upcoming',
    'snoozed',
  ].map((chip) => `activity-chip-${chip}`),
  'name: `plan-tab-chip-${chip}`': ['next', 'later', 'earlier', 'all'].map(
    (chip) => `plan-tab-chip-${chip}`,
  ),
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
  'pipeline-search-focused',
  'chat-tasks-swipe',
  'chat-composer-keyboard',
];

/**
 * Laptop-only light screens (`only: 'laptop'`): the Cockpit side panel, the Week
 * view, the Bank side panel and table and the chip hover (a hover pointer).
 */
const LAPTOP_LIGHT_NAMES = [
  'pipeline-search-typed',
  'cockpit-panel-needs',
  'cockpit-panel-users',
  'plan-tab-week',
  'plan-tab-bank-panel',
  'plan-tab-month-trace',
  'plan-tab-bank-table',
  'chip-row-hover',
];

/** Laptop dark shots taken in the laptop-light project (`only: 'laptop', dark: true`). */
const LAPTOP_FORCED_DARK_NAMES = [
  'member-sheet-dark',
  'cockpit-dot-green-dark',
  'cockpit-dot-red-dark',
  'cockpit-panel-needs-dark',
  'cockpit-panel-users-dark',
  'plan-tab-week-dark',
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
