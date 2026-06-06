import { z } from 'zod';

export const SessionDeviceSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  fingerprint_hash: z.string(),
  user_agent: z.string().nullable(),
  ip_subnet: z.string().nullable(),
  last_seen_at: z.string(),
  created_at: z.string(),
  revoked_at: z.string().nullable(),
});

export type SessionDevice = z.infer<typeof SessionDeviceSchema>;
