# Sorted v2

Social media operations platform for agencies.

## Stack

- Vite 5 + React 18 + TypeScript 5 (strict)
- Tailwind CSS 3 (PostCSS, autoprefixer)
- ESLint 9 (flat config) + Prettier 3
- Node 20 LTS, pnpm

## Prerequisites

- Node 20 (`.nvmrc`)
- pnpm

## Setup

```sh
pnpm install
```

## Commands

| Command             | Description                     |
| ------------------- | ------------------------------- |
| `pnpm dev`          | Start the dev server            |
| `pnpm build`        | Type-check and build to `dist/` |
| `pnpm preview`      | Preview the production build    |
| `pnpm typecheck`    | Run `tsc --noEmit`              |
| `pnpm lint`         | Run ESLint                      |
| `pnpm format`       | Format with Prettier            |
| `pnpm format:check` | Check formatting with Prettier  |
