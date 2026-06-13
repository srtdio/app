import { z } from 'zod';

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  // Asset-read Worker base URL: mints short-lived presigned GET URLs for asset
  // versions. Optional - when unset, asset thumbnails and downloads degrade
  // gracefully (the library still lists and filters).
  VITE_ASSET_READ_URL: z.string().url().optional(),
  // Asset-upload Worker URL: accepts multipart {file, workspace_id} + Bearer JWT
  // and stores the asset. Optional - when unset, the Assets add menu still opens
  // the sheet but the commit path stays disabled (naming only).
  VITE_ASSET_UPLOAD_URL: z.string().url().optional(),
  VITE_SENTRY_DSN_FRONTEND: z.string().url().optional(),
  VITE_SENTRY_ENVIRONMENT: z.enum(['development', 'production']).default('development'),
  VITE_SENTRY_RELEASE: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(import.meta.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(
    `Invalid environment configuration. Check your .env.local against .env.example:\n${issues}`,
  );
}

export const env: Env = parsed.data;
