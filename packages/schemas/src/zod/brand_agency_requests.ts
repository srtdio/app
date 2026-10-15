import { z } from 'zod';

export const BrandAgencyRequestSchema = z.object({
  id: z.string().uuid(),
  requested_by: z.string().uuid(),
  agency_email: z.string().regex(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i),
  brand_name: z.string().min(1).max(80).nullable(),
  send_count: z.number().int().min(1).max(5),
  last_sent_at: z.string(),
  fulfilled_at: z.string().nullable(),
  created_at: z.string(),
});

export type BrandAgencyRequest = z.infer<typeof BrandAgencyRequestSchema>;
