import { z } from 'zod';

// Optional URL var that treats an unset GitHub Actions Variable (injected as the
// empty string "") as "not provided". An empty string coerces to undefined so
// the var passes as absent; a genuinely invalid non-empty value is still
// rejected. This guards against the blank-screen bug where "" failed url().
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional());

export const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  // Asset-read Worker base URL: mints short-lived presigned GET URLs for asset
  // versions. Optional - when unset, asset thumbnails and downloads degrade
  // gracefully (the library still lists and filters).
  VITE_ASSET_READ_URL: optionalUrl,
  // Asset-upload Worker URL: accepts multipart {file, workspace_id} + Bearer JWT
  // and stores the asset. Optional - when unset, the Assets add menu still opens
  // the sheet but the commit path stays disabled (naming only).
  VITE_ASSET_UPLOAD_URL: optionalUrl,
  // Avatar-upload Worker URL: accepts a multipart {file} + Bearer JWT, stores the
  // cropped avatar and returns { avatar_url }. Optional - when unset, onboarding
  // disables the save and shows that photo upload is not configured.
  VITE_AVATAR_UPLOAD_URL: optionalUrl,
  // Chat-token Worker URL: mints short-lived Agora Chat user tokens for the
  // signed-in workspace member. Optional - when unset, chat is unavailable and
  // the rest of the app keeps working.
  VITE_CHAT_TOKEN_URL: optionalUrl,
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
