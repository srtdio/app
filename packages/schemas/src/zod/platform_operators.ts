import { z } from 'zod';

export const PlatformOperatorSchema = z.object({
  user_id: z.string().uuid(),
  granted_at: z.string(),
  granted_by: z.string().uuid().nullable(),
  revoked_at: z.string().nullable(),
  passkey_credential_id: z.string().nullable(),
});

export type PlatformOperator = z.infer<typeof PlatformOperatorSchema>;
