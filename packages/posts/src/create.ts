// postCreate: the client-facing write path for a new post. It validates a small
// set of named fields with Zod, shapes them into the snake_case jsonb payload
// the public.post_create SECURITY DEFINER proc expects, then delegates to the
// @srtdio/rpc wrapper. The proc is the single insert authority: it gates
// post.create capability and active membership, applies the format/owner
// defaults, and creates version 1 in the same transaction. Do NOT call
// postVersionCreate after this; v1 already exists.
//
// The actor is always auth.uid() server-side. ownerUserId is the post's owner,
// never the acting identity, and is never trusted as the writer.

import {
  postCreate as postCreateRpc,
  type Client,
  type DomainError,
  type Result,
} from '@srtdio/rpc';
import type { Json } from '@srtdio/schemas';
import { z } from 'zod';
import { resolveTraceId } from './trace';

/** The supported platforms. One workspace targets exactly one of these. */
export const POST_PLATFORMS = ['linkedin', 'x', 'instagram', 'facebook', 'threads'] as const;
/** The supported post formats. The proc defaults an absent format to `text`. */
export const POST_FORMATS = ['text', 'single_image', 'carousel', 'video', 'link'] as const;
/** Where the post originated. The proc defaults an absent origin to `manual`. */
export const POST_ORIGINS = ['manual', 'brief'] as const;

/**
 * The create payload, validated before it leaves the client. Defaults for
 * format and owner are applied server-side, so they are optional here.
 */
export const PostCreatePayloadSchema = z.object({
  title: z.string().min(1).max(200),
  platform: z.enum(POST_PLATFORMS),
  caption: z.string().optional(),
  format: z.enum(POST_FORMATS).optional(),
  ownerUserId: z.string().uuid().optional(),
  targetDate: z.string().optional(),
  origin: z.enum(POST_ORIGINS).optional(),
  briefId: z.string().uuid().optional(),
  bucketId: z.string().uuid().optional(),
});

export type PostCreatePayload = z.infer<typeof PostCreatePayloadSchema>;

export interface PostCreateInput {
  /** Workspace the post belongs to. RLS + the proc gate membership. */
  workspaceId: string;
  payload: PostCreatePayload;
  /** Optional; a uuid_v7 is minted at entry when omitted. */
  traceId?: string;
}

function invalidPayload(message: string): DomainError {
  return { code: 'invalid_payload', message };
}

/**
 * Create a draft post (and its automatic version 1) via public.post_create.
 * Client-side Zod failures surface as the same `invalid_payload` domain error
 * the proc raises, so callers branch on one shape regardless of where the
 * rejection happened.
 */
export async function postCreate(client: Client, input: PostCreateInput): Promise<Result<string>> {
  const parsed = PostCreatePayloadSchema.safeParse(input.payload);
  if (!parsed.success) return { ok: false, error: invalidPayload(parsed.error.message) };
  const p = parsed.data;

  // Optional fields are omitted rather than sent as null so the proc's COALESCE
  // defaults apply. Keys are snake_case to match the columns post_create reads.
  const payload: Record<string, Json | undefined> = {
    title: p.title,
    platform: p.platform,
  };
  if (p.caption !== undefined) payload.caption = p.caption;
  if (p.format !== undefined) payload.format = p.format;
  if (p.ownerUserId !== undefined) payload.owner_user_id = p.ownerUserId;
  if (p.targetDate !== undefined) payload.target_date = p.targetDate;
  if (p.origin !== undefined) payload.origin = p.origin;
  if (p.briefId !== undefined) payload.brief_id = p.briefId;
  if (p.bucketId !== undefined) payload.bucket_id = p.bucketId;

  return postCreateRpc(client, {
    p_workspace_id: input.workspaceId,
    p_payload: payload as Json,
    p_trace_id: resolveTraceId(input.traceId),
  });
}
