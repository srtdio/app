import type { Config } from 'tailwindcss';
import plugin from 'tailwindcss/plugin';

// Spacing steps (CLAUDE.md "Spacing", 8 Nov 2026): padding, margin, gap and
// space take 4 / 8 / 12 / 16 / 24 (plus 32+ layout values). The off-steps
// 0.5 (2), 1.5 (6), 5 (20) and 7 (28) stay in width / height / inset only, so a
// p-0.5 / gap-1.5 / mt-5 / pl-7 class no longer exists and CI rejects it.
const OFF_STEP = new Set(['0.5', '1.5', '5', '7']);
function onStep(spacing: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(spacing).filter(([k]) => !OFF_STEP.has(k)));
}
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  // hover: styles apply only where a real hover pointer exists
  // (@media (hover: hover)), so a tap on a touch screen never leaves a hover
  // colour stuck on the control. focus-visible: and active: are unaffected.
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    // Value lock (CLAUDE.md Design and Layout rules). These keys REPLACE
    // Tailwind's defaults, so only the listed values exist as classes.
    //
    // Type scale. Each size carries its line height; no leading-* overrides.
    fontSize: {
      xs: ['11px', '14px'],
      sm: ['12px', '16px'],
      md: ['13px', '18px'],
      base: ['14px', '20px'],
      lg: ['15px', '20px'],
      xl: ['17px', '22px'],
      '2xl': ['20px', '26px'],
      '3xl': ['28px', '34px'],
      // Inputs below md: 16px so iOS never zooms on focus (md:text-base above).
      input: ['16px', '22px'],
    },
    // Spacing: the 4px grid (step N = 4N px) as used in src, plus px (hairline),
    // 0.5 (2px, inside badges and pills) and 1.5 (6px). 2.5 and 3.5 are gone.
    spacing: {
      px: '1px',
      0: '0px',
      0.5: '0.125rem',
      1: '0.25rem',
      1.5: '0.375rem',
      2: '0.5rem',
      3: '0.75rem',
      4: '1rem',
      5: '1.25rem',
      6: '1.5rem',
      7: '1.75rem',
      8: '2rem',
      9: '2.25rem',
      10: '2.5rem',
      11: '2.75rem',
      12: '3rem',
      // 52: the task / media text column (40 glyph column + 12 gap).
      13: '3.25rem',
      14: '3.5rem',
      // 60: the row text edge and divider inset (16 gutter + 32 avatar + 12 gap).
      15: '3.75rem',
      16: '4rem',
      // 68: the plan day text column.
      17: '4.25rem',
      // 72: the two-line row.
      18: '4.5rem',
      20: '5rem',
      24: '6rem',
      28: '7rem',
      32: '8rem',
      36: '9rem',
      40: '10rem',
      44: '11rem',
      48: '12rem',
      52: '13rem',
      56: '14rem',
      60: '15rem',
      64: '16rem',
      72: '18rem',
      80: '20rem',
    },
    // The spacing steps only (OFF_STEP above): width / height keep every value.
    padding: ({ theme }) => onStep(theme('spacing') as Record<string, string>),
    margin: ({ theme }) => ({
      auto: 'auto',
      ...onStep(theme('spacing') as Record<string, string>),
    }),
    gap: ({ theme }) => onStep(theme('spacing') as Record<string, string>),
    space: ({ theme }) => onStep(theme('spacing') as Record<string, string>),
    // Radius roles (CLAUDE.md). Rendered values are unchanged by the lock.
    borderRadius: {
      // rounded: controls and fields (8).
      DEFAULT: '8px',
      none: '0',
      // rounded-sm: badges (ui/Tag), checkbox, highlights, dots, grabbers (6).
      sm: '6px',
      // rounded-md / rounded-lg: controls, fields, cards (8).
      md: '8px',
      lg: '8px',
      // rounded-xl: cards, popovers, menus (12).
      xl: '12px',
      // rounded-2xl: sheets and dialogs (16), the same as rounded-sheet.
      '2xl': '16px',
      full: '9999px',
      // rounded-card: the card role (8).
      card: '8px',
      // rounded-sheet: sheet tops and dialogs (16).
      sheet: '16px',
      // rounded-pill: pills (full).
      pill: '9999px',
      // A picture inset inside a card (ui/Card media inset).
      inset: '4px',
      // rounded-picture: a list row's 40 picture squircle (10), Slack style.
      picture: '10px',
      // rounded-plus-box: the phone top bar "+" outlined square (shell/topbar-actions TopbarPlus).
      'plus-box': '7px',
    },
    // Edges: 1 (DEFAULT) and 2; 0 removes a side. The named widths are the only
    // thicker lines.
    borderWidth: {
      DEFAULT: '1px',
      0: '0px',
      2: '2px',
      // The ring that cuts a small badge out of a profile-size avatar (NotesBits).
      cutout: '3px',
      // The ring that cuts the camera badge out of the group photo (GroupInfoSheet).
      'cutout-lg': '4px',
      // The quote rail on an annotation draft (Pin / Caption annotation composers).
      rail: '4px',
      // The phone top bar "+" outlined square's line (shell/topbar-actions TopbarPlus).
      'plus-box': '1.75px',
    },
    // No line-height utilities: font sizes carry theirs (CLAUDE.md L9).
    // leading-emoji: an emoji glyph with no line box (chat-type.ts emoji roles).
    lineHeight: {
      emoji: '1',
    },
    // Only the type roles track (ui/Text.tsx): display (tight), section (label).
    letterSpacing: {
      tight: '-0.025em',
      label: '0.06em',
    },
    // Stacking scale (CLAUDE.md Stacking). Never z-[N]; values keep the old order.
    zIndex: {
      // In-flow base layer (the safe-area fill under a sticky header).
      base: '0',
      // A part lifted over its siblings (media overlays, press surfaces);
      // -z-raised sinks a selection tint under its row.
      raised: '10',
      // Sticky section heads, composer trays, in-page popovers, the side panel.
      sticky: '20',
      // Top bar, phone nav, in-screen panels over a sticky head.
      nav: '30',
      // Fixed docks and full-screen panels over the nav; menu click-catchers.
      dock: '40',
      // Menus, popovers, sheets, dialogs, modal pages (the overlay height).
      sheet: '50',
      // The induction guide, above sheets.
      guide: '55',
      // A date picker over a sheet or the guide: its click-catcher, then the picker.
      'picker-catch': '56',
      picker: '57',
      // A sheet or popover opened from a sheet (file prompt, range calendar, emoji).
      dialog: '60',
      // Toasts and the undo strip.
      toast: '70',
      // Full-screen viewers (file viewer, image lightbox).
      viewer: '80',
      // The test-site badge, above everything.
      top: '2147483000',
    },
    extend: {
      // Hex tokens read their --x-rgb triplet so /opacity works (bg-bad/10,
      // text-accent/80). rgba tokens are already translucent and stay var().
      colors: {
        bg: 'rgb(var(--bg-rgb) / <alpha-value>)',
        panel: 'rgb(var(--panel-rgb) / <alpha-value>)',
        'panel-2': 'rgb(var(--panel-2-rgb) / <alpha-value>)',
        'panel-3': 'rgb(var(--panel-3-rgb) / <alpha-value>)',
        border: 'rgb(var(--border-rgb) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong-rgb) / <alpha-value>)',
        fg: 'rgb(var(--fg-rgb) / <alpha-value>)',
        'fg-2': 'rgb(var(--fg-2-rgb) / <alpha-value>)',
        'fg-3': 'rgb(var(--fg-3-rgb) / <alpha-value>)',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        'accent-hover': 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
        'accent-fg': 'rgb(var(--accent-fg-rgb) / <alpha-value>)',
        'accent-soft': 'var(--accent-soft)',
        'accent-line': 'var(--accent-line)',
        'bubble-own': 'rgb(var(--bubble-own-rgb) / <alpha-value>)',
        // Lines and fills inside the own bubble (on-bubble/45, on-bubble/12).
        'on-bubble': 'rgb(var(--on-bubble-rgb) / <alpha-value>)',
        knob: 'rgb(var(--knob-rgb) / <alpha-value>)',
        'hover-fill': 'var(--hover-fill)',
        'press-fill': 'var(--press-fill)',
        good: 'rgb(var(--good-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
        bad: 'rgb(var(--bad-rgb) / <alpha-value>)',
        'good-solid': 'rgb(var(--good-solid-rgb) / <alpha-value>)',
        'bad-solid': 'rgb(var(--bad-solid-rgb) / <alpha-value>)',
        'good-soft': 'var(--good-soft)',
        'bad-soft': 'var(--bad-soft)',
        'warn-soft': 'rgb(var(--warn-soft-rgb) / <alpha-value>)',
        'search-mark': 'rgb(var(--search-mark-bg-rgb) / <alpha-value>)',
        'stage-review': 'rgb(var(--stage-review-rgb) / <alpha-value>)',
        'stage-approved': 'rgb(var(--stage-approved-rgb) / <alpha-value>)',
        'stage-rejected': 'rgb(var(--stage-rejected-rgb) / <alpha-value>)',
        'stage-parked': 'rgb(var(--stage-parked-rgb) / <alpha-value>)',
        overlay: 'var(--overlay)',
        'overlay-fg': 'rgb(var(--overlay-fg-rgb) / <alpha-value>)',
        'overlay-fg-dim': 'var(--overlay-fg-dim)',
        'overlay-surface': 'var(--overlay-surface)',
        'overlay-line': 'var(--overlay-line)',
        'overlay-dot': 'var(--overlay-dot)',
        'overlay-badge': 'var(--overlay-badge)',
        'overlay-badge-hover': 'var(--overlay-badge-hover)',
        'avatar-ink': 'rgb(var(--avatar-ink-rgb) / <alpha-value>)',
        'avatar-1': 'rgb(var(--avatar-1-rgb) / <alpha-value>)',
        'avatar-2': 'rgb(var(--avatar-2-rgb) / <alpha-value>)',
        'avatar-3': 'rgb(var(--avatar-3-rgb) / <alpha-value>)',
        'avatar-4': 'rgb(var(--avatar-4-rgb) / <alpha-value>)',
        'avatar-5': 'rgb(var(--avatar-5-rgb) / <alpha-value>)',
        'avatar-6': 'rgb(var(--avatar-6-rgb) / <alpha-value>)',
        scrim: 'var(--scrim)',
        // Platform preview mocks (components/preview/platform-look.ts) draw each
        // platform's own light feed or black full screen. The same in light and
        // dark (the mock shows the platform's look, like the --overlay scale).
        // Neutral values only: no blue or violet (palette rules), no logos.
        // pv-card: the feed card ground on every feed platform.
        'pv-card': '#ffffff',
        // pv-screen: the full-screen ground (Reel, Story, TikTok, Shorts) and its inks.
        'pv-screen': '#000000',
        'pv-screen-ink': '#ffffff',
        'pv-screen-ink-2': 'rgba(255, 255, 255, 0.8)',
        // pv-cut: the shade over the strips a platform cuts off (Show cut).
        'pv-cut': 'rgba(0, 0, 0, 0.55)',
        // Instagram feed: ink, secondary ink (4.7:1 on the card), hairline.
        'pv-ig-ink': '#000000',
        'pv-ig-ink-2': '#737373',
        'pv-ig-line': '#dbdbdb',
        // Facebook feed: grey page behind the card, ink, secondary ink (5.7:1), hairline.
        'pv-fb-page': '#f0f2f5',
        'pv-fb-ink': '#050505',
        'pv-fb-ink-2': '#65676b',
        'pv-fb-line': '#ced0d4',
        // LinkedIn feed: warm page behind the card, ink, secondary ink (5.7:1), hairline.
        'pv-li-page': '#f4f2ee',
        'pv-li-ink': '#191919',
        'pv-li-ink-2': '#666666',
        'pv-li-line': '#e0dfdc',
        // X feed: ink, secondary ink (6.1:1), hairline.
        'pv-x-ink': '#0f1419',
        'pv-x-ink-2': '#536471',
        'pv-x-line': '#eff3f4',
        // Threads feed: ink, secondary ink (4.9:1), hairline.
        'pv-th-ink': '#000000',
        'pv-th-ink-2': '#707070',
        'pv-th-line': '#e5e5e5',
      },
      // accent splits by use: ink reads --accent-text, fills --accent-fill
      // (under white accent-fg). border-accent and ring-accent keep --accent.
      textColor: {
        accent: 'rgb(var(--accent-text-rgb) / <alpha-value>)',
        strip: 'var(--strip-fg)',
        'strip-action': 'var(--strip-action)',
        'warn-ink': 'var(--warn-ink)',
        // Chat meta ink (times, ticks, media pills), one name per index.css token.
        'bubble-meta': 'var(--bubble-meta)',
        'bubble-meta-own': 'var(--bubble-meta-own)',
        'tick-read': 'var(--tick-read)',
        'media-meta': 'var(--media-meta-fg)',
      },
      backgroundColor: {
        accent: 'rgb(var(--accent-fill-rgb) / <alpha-value>)',
        strip: 'var(--strip-bg)',
        'tab-active': 'var(--lit-tab-active-bg)',
        'warn-ink': 'var(--warn-ink)',
      },
      // border-field: the field line (ink light, white dark) on every input,
      // select, date and code box at rest.
      borderColor: {
        field: 'var(--field-line)',
        strip: 'var(--strip-border)',
        'surface-top': 'var(--lit-surface-top)',
        'warn-line': 'var(--warn-line)',
      },
      // A solid success tint for floating surfaces (good-soft over panel).
      backgroundImage: {
        'good-tint': 'linear-gradient(var(--good-soft), var(--good-soft))',
        // Hover inside the own bubble: the resting on-bubble/12 fill with an
        // on-bubble/10 overlay stacked on top (same pattern as --hover-fill).
        'on-bubble-hover':
          'linear-gradient(rgb(var(--on-bubble-rgb) / 0.1), rgb(var(--on-bubble-rgb) / 0.1)), linear-gradient(rgb(var(--on-bubble-rgb) / 0.12), rgb(var(--on-bubble-rgb) / 0.12))',
        // Platform preview: the dark fade under a full-screen caption (same in both themes).
        'pv-scrim': 'linear-gradient(to top, rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0))',
      },
      // Named panel and popover sizes: one name per surface, never w-[Npx] at a call site.
      width: {
        // Chat list column on laptop (xl), ChatConnected.
        'chat-list': '352px',
        // Emoji popover from the message action menu (MessageActionMenu).
        emoji: '352px',
        // Emoji tray above the composer (ComposerEmoji).
        'emoji-tray': '368px',
        // Plan panel beside chat: narrow laptop, then full from 972px (PlanScreen).
        'plan-narrow': '360px',
        'plan-panel': '440px',
        // Schedule-send popover above the composer (ScheduleSheet).
        schedule: '340px',
        // Sheet as a centred dialog from sm (ui/Sheet), and the wide sheet (tasks, composer).
        sheet: '540px',
        'sheet-wide': '960px',
        // ui/SidePanel on laptop (CLAUDE.md: 380px).
        'side-panel': '380px',
        // The thread rail glyph in ui/icons (the rail geometry is 13px).
        'rail-glyph': '13px',
        // Catch up's centred window on laptop (components/catch-up, 9 Nov 2026: 640 wide).
        'catch-up': '640px',
        // The phone top bar "+" outlined square's face (shell/topbar-actions TopbarPlus).
        'plus-box': '22px',
        // A phone top bar key's hit strip: 36 wide, 44 tall, 36 apart (shell/Topbar).
        'topbar-key': '36px',
      },
      height: {
        // Catch up's centred window on laptop: at most 85vh (9 Nov 2026).
        'catch-up': '85vh',
        // Emoji popover from the message action menu (MessageActionMenu).
        emoji: '400px',
        // PressableRow dense: laptop Plan month item lines (decided 28 Oct 2026).
        dense: '22px',
        // The thread rail glyph in ui/icons.
        'rail-glyph': '13px',
        // The phone top bar "+" outlined square's face (shell/topbar-actions TopbarPlus).
        'plus-box': '22px',
      },
      margin: {
        // Room for the plan panel beside the page (PlanBesideLayout, ChatConnected).
        'plan-panel': '440px',
      },
      padding: {
        // Text field vertical inset (10px): a one-line Textarea / MentionInput is 44 with its edge.
        'field-y': '0.625rem',
        // Compact list row inset (10px): 10 + 40 picture + 10 = the 60 Compact row (ui/ListCard).
        'row-inset': '0.625rem',
      },
      // Auto-fill grids that fill the laptop width (ui/Tile TILE_GRID, ui/Card CARD_GRID).
      gridTemplateColumns: {
        tiles: 'repeat(auto-fill, minmax(158px, 1fr))',
        cards: 'repeat(auto-fill, minmax(320px, 1fr))',
        // ui/ListCard LIST_CARD_GRID: list cards in columns on laptop, 360 wide at least.
        'list-cards': 'repeat(auto-fill, minmax(360px, 1fr))',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
          '"Noto Color Emoji"',
        ],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      transitionDuration: {
        fast: 'var(--dur-fast)',
        base: 'var(--dur-base)',
        slow: 'var(--dur-slow)',
        push: 'var(--dur-push)',
        back: 'var(--dur-back)',
        grow: 'var(--dur-grow)',
        'grow-back': 'var(--dur-grow-back)',
        'sheet-in': 'var(--dur-sheet-in)',
        'sheet-out': 'var(--dur-sheet-out)',
        menu: 'var(--dur-menu)',
        toast: 'var(--dur-toast)',
        wipe: 'var(--dur-wipe)',
        sweep: 'var(--dur-sweep)',
      },
      transitionTimingFunction: {
        enter: 'var(--ease-enter)',
        exit: 'var(--ease-exit)',
        ios: 'var(--ease-ios)',
        move: 'var(--ease-move)',
        pop: 'var(--ease-pop)',
      },
    },
  },
  plugins: [
    // Density (Compact / Cozy / Calm, users.density): <html data-density> is set
    // at boot from the device cache (src/lib/density.ts). Cozy is the default
    // class; compact: and calm: override it. Parts only (ListCard, Chip, Avatar
    // 'card', plan spacing), never a screen.
    plugin(({ addVariant }) => {
      addVariant('compact', 'html[data-density="compact"] &');
      addVariant('calm', 'html[data-density="calm"] &');
    }),
  ],
} satisfies Config;
