import { z } from 'zod';

export const UserPrivateSchema = z.object({
  user_id: z.string().uuid(),
  age_range: z.enum(['18-24', '25-34', '35-44', '45-54', '55+']).nullable(),
  heard_from: z
    .enum(['friend', 'ad', 'instagram', 'linkedin', 'google', 'client', 'other'])
    .nullable(),
  updated_at: z.string(),
  induction_step: z
    .string()
    .regex(/^[a-z0-9_]{1,40}$/)
    .nullable(),
  induction_done_at: z.string().nullable(),
});

export type UserPrivate = z.infer<typeof UserPrivateSchema>;
