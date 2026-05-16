import { z } from 'zod';

const envSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
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
