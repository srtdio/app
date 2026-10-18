// The WebKit e2e areas: each screen family the harness can open, its entry
// files in src, and the e2e/tests specs that exercise it. e2e-select.ts walks
// each area's imports from its entries and runs a spec only when a changed
// file is in the closure of an area that lists it. Every spec in e2e/tests
// must be listed by at least one area (the selector fails loudly otherwise).
//
// A spec belongs to every area whose screens it opens or clicks through, not
// only the route it starts on (a chat spec that taps into Activity is listed
// under both). When unsure, list it: an extra spec costs a minute, a missing
// one lets a regression through.

export interface Area {
  /** Short name, used in the CI log. */
  name: string;
  /** Files in src the area's screens start from (repo-relative). */
  entries: string[];
  /**
   * true for a route page App.tsx (or src/main.tsx) mounts: the app shell's
   * closure stops at it. false for code the shell itself mounts on every
   * route (its changes run the whole suite through the shell rule).
   */
  routed: boolean;
  /**
   * Folders the area owns outright: a file under one that no closure reaches
   * (a new file) still selects this area instead of the whole suite.
   */
  ownedDirs?: string[];
  /** e2e/tests specs (repo-relative) that exercise the area. */
  specs: string[];
}

const t = (name: string): string => `e2e/tests/${name}.spec.ts`;

const CHAT_SPECS = [
  'chat-back-navigation',
  'chat-bell',
  'chat-file-viewer',
  'chat-imessage-threads',
  'chat-keyboard-gap',
  'chat-open-at-once',
  'chat-personal-notes',
  'chat-plan-card-paint',
  'chat-plan-compose-edit',
  'chat-plan-concept-upload',
  'chat-plan-dates',
  'chat-plan-edit',
  'chat-plan-share',
  'chat-plan',
  'chat-remember-messages',
  'chat-reply-focus',
  'chat-scheduled',
  'chat-search',
  'chat-select-text',
  'chat-stars',
  'chat-status-ticker',
  'chat-tasks',
  'chat-thread',
  'chat-tray',
  'chat-username-mentions',
  // The search screen (command palette), opened over the chat home.
  'command-palette',
  // Start on /chat and open plans, files or the onboarding over it.
  'plan-add-move',
  'plan-desktop',
  'plan-draft-open',
  'plan-week-slots',
  'office-viewer',
  'pdf-opens-instantly',
  'onboarding',
  'activity-plan',
  // The onboarding guide routes end on the chat list (Activity).
  'onboarding-creator',
  'onboarding-invited',
  'onboarding-approver',
  // Link cards in a chat, then on a post's comments.
  'link-previews',
  // Delete a message with a file (purge-chat), then Settings > Delete workspace.
  'workspace-delete-chat-purge',
];

export const AREAS: Area[] = [
  {
    name: 'chat',
    entries: ['src/components/pages/ChatPage.tsx'],
    routed: true,
    specs: CHAT_SPECS.map(t),
  },
  {
    // /activity and /plans/:id share ActivityPlanLayout (PlanPage.tsx).
    name: 'activity',
    entries: ['src/components/pages/ActivityPage.tsx', 'src/components/pages/PlanPage.tsx'],
    routed: true,
    specs: [
      'activity-plan',
      'agency-actions',
      'chat-back-navigation',
      'chat-bell',
      'chat-plan-card-paint',
      'chat-plan-dates',
      'chat-tasks',
      'plan-desktop',
      'plan-draft-open',
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
    ].map(t),
  },
  {
    name: 'pipeline',
    entries: ['src/components/pages/PipelinePage.tsx'],
    routed: true,
    specs: [
      'assets-type-tabs',
      'chat-back-navigation',
      'chat-status-ticker',
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
      'plan-desktop',
      'workspace-platform',
    ].map(t),
  },
  {
    // PCS: the post page and its /p/:ref short link.
    name: 'pcs',
    entries: ['src/components/pages/PostDetailPage.tsx', 'src/components/refs/PostRefResolver.tsx'],
    routed: true,
    specs: [
      'agency-actions',
      'chat-plan',
      'chat-status-ticker',
      'files-open-in-viewer',
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
      'link-previews',
      'pdf-opens-instantly',
    ].map(t),
  },
  {
    name: 'briefs',
    entries: [
      'src/components/pages/BriefsPage.tsx',
      'src/components/pages/BriefDetailPage.tsx',
      'src/components/refs/BriefRefResolver.tsx',
    ],
    routed: true,
    specs: [
      'chat-stars',
      'chat-status-ticker',
      'files-open-in-viewer',
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
    ].map(t),
  },
  {
    name: 'assets',
    entries: [
      'src/components/pages/AssetsPage.tsx',
      'src/components/pages/RecentlyDeletedPage.tsx',
    ],
    routed: true,
    specs: [
      'assets-type-tabs',
      'assets-recently-deleted',
      'files-open-in-viewer',
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
      'pdf-opens-instantly',
    ].map(t),
  },
  {
    // The creator route's approver invite gate lands on /settings?panel=members.
    name: 'settings',
    entries: ['src/components/pages/SettingsPage.tsx'],
    routed: true,
    specs: [
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
      'workspace-storage',
      'workspace-delete-chat-purge',
    ].map(t),
  },
  {
    // Routes no spec opens (no Cockpit page exists in src yet).
    name: 'unvisited',
    entries: [
      'src/components/pages/HelpPage.tsx',
      'src/components/auth/SignInPage.tsx',
      'src/components/auth/SignUpPage.tsx',
      'src/components/auth/AuthCallbackPage.tsx',
      'src/components/auth/LegalPolicyPage.tsx',
      'src/components/auth/AcceptInvitePage.tsx',
    ],
    routed: true,
    specs: [],
  },
  {
    // Homepage bundle (/pricing, /demo; "/" is the home.html fixture).
    name: 'home',
    entries: ['src/components/home/HomeEntry.tsx'],
    routed: true,
    ownedDirs: ['src/components/home/'],
    specs: ['home-pages', 'demo-booking'].map(t),
  },
  {
    // Mounted by AppLayout on every route, so the shell rule runs everything.
    name: 'onboarding',
    entries: [
      'src/components/onboarding/OnboardingFlow.tsx',
      'src/components/induction/InductionGuide.tsx',
      'src/components/induction/InductionProvider.tsx',
    ],
    routed: false,
    specs: [
      'onboarding',
      'onboarding-creator',
      'onboarding-invited',
      'onboarding-approver',
      'workspace-platform',
    ].map(t),
  },
  {
    // Public one-click unsubscribe page (/unsubscribe), outside the auth guards.
    name: 'unsubscribe',
    entries: ['src/components/unsubscribe/UnsubscribePage.tsx'],
    routed: true,
    ownedDirs: ['src/components/unsubscribe/'],
    specs: ['unsubscribe'].map(t),
  },
  {
    // The harness's "/" smoke page renders with src/index.css only.
    name: 'smoke',
    entries: ['src/index.css'],
    routed: false,
    specs: ['smoke'].map(t),
  },
];

/**
 * The app shell: its import closure (stopping at routed area entries) runs
 * the whole suite. App.tsx and src/main.tsx reach every provider that wraps
 * every route; the harness entry boots the same tree.
 */
export const SHELL_ROOTS = ['src/main.tsx', 'src/App.tsx', 'e2e/harness/main.tsx'];

/** Path prefixes or exact paths that always run the whole suite. */
export const ALWAYS_FULL = [
  'src/App.tsx',
  'src/main.tsx',
  'src/components/shell/',
  'src/components/ui/',
  'e2e/harness/',
  'e2e/fixtures/',
  'e2e/helpers/',
  'scripts/ci/',
  'playwright.config.ts',
  'tailwind.config.ts',
  'postcss.config.js',
  'vite.config.ts',
  'index.html',
  '.github/workflows/e2e-webkit.yml',
];

/** Any stylesheet runs the whole suite. */
export const FULL_EXTENSIONS = ['.css'];
