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
      colors: {
        bg: 'var(--bg)',
        panel: 'var(--panel)',
        'panel-2': 'var(--panel-2)',
        'panel-3': 'var(--panel-3)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        fg: 'var(--fg)',
        'fg-2': 'var(--fg-2)',
        'fg-3': 'var(--fg-3)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-fg': 'var(--accent-fg)',
        'accent-soft': 'var(--accent-soft)',
        'accent-line': 'var(--accent-line)',
        'bubble-own': 'var(--bubble-own)',
        good: 'var(--good)',
        warn: 'var(--warn)',
        bad: 'var(--bad)',
        'good-soft': 'var(--good-soft)',
        'bad-soft': 'var(--bad-soft)',
        'warn-soft': 'var(--warn-soft)',
        'annotation-bg': 'var(--annotation-bg)',
        'annotation-line': 'var(--annotation-line)',
        'stage-review': 'var(--stage-review)',
        'stage-approved': 'var(--stage-approved)',
        'stage-rejected': 'var(--stage-rejected)',
        'stage-parked': 'var(--stage-parked)',
        overlay: 'var(--overlay)',
        'overlay-fg': 'var(--overlay-fg)',
        'overlay-fg-dim': 'var(--overlay-fg-dim)',
        'overlay-surface': 'var(--overlay-surface)',
        'overlay-line': 'var(--overlay-line)',
        'overlay-dot': 'var(--overlay-dot)',
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
      },
      transitionTimingFunction: {
        enter: 'var(--ease-enter)',
        exit: 'var(--ease-exit)',
      },
    },
  },
  plugins: [],
} satisfies Config;
