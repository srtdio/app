// Shared error-to-string serializer for worker logging. Consolidates the
// private copies previously duplicated in avatar-upload, chat-transcribe, and
// chat-webhook-mirror. Errors keep name/message/stack; Supabase-style error
// objects keep their structured fields; anything else is stringified.

export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  }
  if (typeof error === 'object' && error !== null) {
    const e = error as Record<string, unknown>;
    return JSON.stringify({
      code: e.code,
      message: e.message,
      details: e.details,
      hint: e.hint,
    });
  }
  return String(error);
}
