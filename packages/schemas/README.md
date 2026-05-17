# @srtdio/schemas

Single source of truth for data shapes shared by the Sorted v2 frontend and
backend.

- `src/supabase.generated.ts` — Postgres row/insert/update types generated
  from the live Supabase schema. Auto-generated; never edit by hand.
- `src/zod/` — Zod schemas (one file per top-level domain) that mirror table
  row shapes for runtime validation.

## Regenerate Supabase types

From the repo root, run `pnpm types:supabase`. Requires `SUPABASE_PROJECT_ID`
(see `.env.example`) and a logged-in Supabase CLI (`SUPABASE_ACCESS_TOKEN`).

## Add a new Zod schema

1. Create `src/zod/<table>.ts` exporting a `z.object({...})` schema with
   snake_case fields that match the database row.
2. Export the inferred type: `export type X = z.infer<typeof XSchema>`.
3. Re-export the file from `src/index.ts`.

## Drift gate

CI workflow `schema-drift.yml` regenerates Supabase types against the live
database and fails if they differ from the committed
`src/supabase.generated.ts`. To fix a drift failure, run `pnpm types:supabase`
and commit the updated file.
