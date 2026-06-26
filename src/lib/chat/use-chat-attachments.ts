// React adapter that binds chat attachments to the app's runtime: the active
// workspace, the session token, the trace factory, and the asset Worker URLs.
// It mirrors AssetsPage's wiring (one PresignCache for the surface, an upload
// command that mints a fresh trace) so the composer and renderer stay free of
// the env / supabase / fetch import chain and remain unit-testable in isolation.

import { useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { PresignCache } from '@/lib/asset-presign';
import { uploadChatAttachment, type ChatAttachmentUpload } from '@/lib/chat/attachments';
import { transcribeAudio, type TranscribeResult } from '@/lib/chat/transcribe';

export interface ChatAttachments {
  /** Whether the composer can upload (endpoint configured + a workspace selected). */
  canAttach: boolean;
  /** Whether thumbnails can be presigned (asset-read endpoint configured). */
  presignEnabled: boolean;
  /** One cache for the thread: bounds presign concurrency and caches URLs (no N+1). */
  presignCache: PresignCache;
  /** Upload one picked file; never throws (asset-upload Result contract). */
  uploadFile: (file: File) => Promise<ChatAttachmentUpload>;
  /** Transcribe a recorded voice note; never throws (Result contract). */
  transcribe: (blob: Blob) => Promise<TranscribeResult>;
  /** Whether transcription is configured (transcribe endpoint set). */
  canTranscribe: boolean;
}

export function useChatAttachments(): ChatAttachments {
  const { workspaceId } = useWorkspace();
  const newTrace = useNewTrace();
  const uploadEndpoint = env.VITE_ASSET_UPLOAD_URL;
  const transcribeEndpoint = env.VITE_CHAT_TRANSCRIBE_URL;
  const canTranscribe = transcribeEndpoint !== undefined && transcribeEndpoint !== '';
  const presignEnabled = env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';

  const presignCache = useMemo(
    () =>
      new PresignCache({
        endpoint: env.VITE_ASSET_READ_URL ?? null,
        getAccessToken: async () =>
          (await supabase.auth.getSession()).data.session?.access_token ?? null,
        fetcher: (input, init) => fetchWithTrace(input, init),
      }),
    [],
  );

  const uploadFile = useCallback(
    async (file: File): Promise<ChatAttachmentUpload> => {
      if (uploadEndpoint === undefined || uploadEndpoint === '') {
        return { ok: false, message: 'Upload failed. Check your connection and retry' };
      }
      if (workspaceId === null) {
        return { ok: false, message: 'No workspace selected.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return uploadChatAttachment({
        file,
        workspaceId,
        token,
        endpoint: uploadEndpoint,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    },
    [uploadEndpoint, workspaceId, newTrace],
  );

  const transcribe = useCallback(
    async (blob: Blob): Promise<TranscribeResult> => {
      if (transcribeEndpoint === undefined || transcribeEndpoint === '') {
        return { ok: false, message: 'Transcription is unavailable.' };
      }
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') {
        return { ok: false, message: 'Your session expired. Sign in again.' };
      }
      return transcribeAudio({
        blob,
        endpoint: transcribeEndpoint,
        token,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
    },
    [transcribeEndpoint, newTrace],
  );

  const canAttach = uploadEndpoint !== undefined && uploadEndpoint !== '' && workspaceId !== null;
  return { canAttach, presignEnabled, presignCache, uploadFile, transcribe, canTranscribe };
}
