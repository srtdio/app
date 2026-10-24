import type { Config } from 'tailwindcss';
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
        good: 'rgb(var(--good-rgb) / <alpha-value>)',
        warn: 'rgb(var(--warn-rgb) / <alpha-value>)',
        bad: 'rgb(var(--bad-rgb) / <alpha-value>)',
        'good-solid': 'rgb(var(--good-solid-rgb) / <alpha-value>)',
        'bad-solid': 'rgb(var(--bad-solid-rgb) / <alpha-value>)',
        'good-soft': 'var(--good-soft)',
        'bad-soft': 'var(--bad-soft)',
        'warn-soft': 'rgb(var(--warn-soft-rgb) / <alpha-value>)',
        'annotation-bg': 'rgb(var(--annotation-bg-rgb) / <alpha-value>)',
        'annotation-line': 'rgb(var(--annotation-line-rgb) / <alpha-value>)',
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
        'avatar-1': 'rgb(var(--avatar-1-rgb) / <alpha-value>)',
        'avatar-2': 'rgb(var(--avatar-2-rgb) / <alpha-value>)',
        'avatar-3': 'rgb(var(--avatar-3-rgb) / <alpha-value>)',
        'avatar-4': 'rgb(var(--avatar-4-rgb) / <alpha-value>)',
        'avatar-5': 'rgb(var(--avatar-5-rgb) / <alpha-value>)',
        'avatar-6': 'rgb(var(--avatar-6-rgb) / <alpha-value>)',
        scrim: 'var(--scrim)',
      },
      // accent splits by use: ink reads --accent-text, fills --accent-fill
      // (under white accent-fg). border-accent and ring-accent keep --accent.
      textColor: {
        accent: 'rgb(var(--accent-text-rgb) / <alpha-value>)',
      },
      backgroundColor: {
        accent: 'rgb(var(--accent-fill-rgb) / <alpha-value>)',
      },
      // Type scale (Design rules in CLAUDE.md). Overrides Tailwind's defaults on
      // purpose. legacy-* freeze the old Tailwind sizes until the type
      // migration PR moves every screen onto the scale and removes them.
      fontSize: {
        xs: ['11px', '14px'],
        sm: ['12px', '16px'],
        md: ['13px', '18px'],
        base: ['14px', '20px'],
        lg: ['15px', '20px'],
        xl: ['17px', '22px'],
        '2xl': ['20px', '26px'],
        '3xl': ['28px', '34px'],
        'legacy-xs': ['12px', '16px'],
        'legacy-sm': ['14px', '20px'],
        'legacy-base': ['16px', '24px'],
        'legacy-lg': ['18px', '28px'],
        'legacy-xl': ['20px', '28px'],
        'legacy-2xl': ['24px', '32px'],
        'legacy-3xl': ['30px', '36px'],
      },
      // One radius for controls and cards (8), 12 popovers, 16 sheet tops.
      borderRadius: {
        DEFAULT: '8px',
        none: '0',
        sm: '6px',
        md: '8px',
        lg: '8px',
        xl: '12px',
        '2xl': '16px',
        full: '9999px',
        card: '8px',
        sheet: '16px',
        pill: '9999px',
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
        fast: 'rgb(var(--dur-fast-rgb) / <alpha-value>)',
        base: 'rgb(var(--dur-base-rgb) / <alpha-value>)',
        slow: 'rgb(var(--dur-slow-rgb) / <alpha-value>)',
      },
      transitionTimingFunction: {
        enter: 'rgb(var(--ease-enter-rgb) / <alpha-value>)',
        exit: 'rgb(var(--ease-exit-rgb) / <alpha-value>)',
      },
    },
  },
  plugins: [],
} satisfies Config;
