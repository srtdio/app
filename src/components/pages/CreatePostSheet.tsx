import { useEffect, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { IconUpload } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { postCreate } from '@srtdio/rpc';
import { POST_FORMATS, POST_PLATFORMS, PostCreatePayloadSchema } from '@srtdio/posts';
import type { Json } from '@srtdio/schemas';

interface CreatePostSheetProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

/** Title-case a snake_case enum value for display (e.g. single_image -> Single Image). */
function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

const DEFAULT_FORMAT = POST_FORMATS[0];

export function CreatePostSheet({ open, workspaceId, onClose, onCreated }: CreatePostSheetProps) {
  const newTrace = useNewTrace();
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [platform, setPlatform] = useState('');
  const [format, setFormat] = useState<string>(DEFAULT_FORMAT);
  const [targetDate, setTargetDate] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form each time the sheet opens so a prior draft never lingers.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setCaption('');
    setPlatform('');
    setFormat(DEFAULT_FORMAT);
    setTargetDate('');
    setFieldErrors({});
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  const canSubmit =
    workspaceId !== null &&
    title.trim() !== '' &&
    caption.trim() !== '' &&
    platform !== '' &&
    !submitting;

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null) return;

    const candidate = {
      title: title.trim(),
      caption: caption.trim(),
      platform,
      format,
      ...(targetDate !== '' ? { targetDate } : {}),
    };

    const parsed = PostCreatePayloadSchema.safeParse(candidate);
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (next[key] === undefined) next[key] = issue.message;
      }
      setFieldErrors(next);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setSubmitError(null);

    const data = parsed.data;
    // Shape the snake_case jsonb payload the post_create proc reads. Owner,
    // origin and brief link are deliberately not sent in this PR.
    const payload: Record<string, Json> = {
      title: data.title,
      caption: data.caption ?? '',
      platform: data.platform,
      format: data.format ?? DEFAULT_FORMAT,
    };
    if (data.targetDate !== undefined) payload.target_date = data.targetDate;

    const result = await postCreate(supabase, {
      p_workspace_id: workspaceId,
      p_payload: payload as Json,
      p_trace_id: newTrace(),
    });

    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    onCreated();
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New post"
      footer={
        <>
          <Button size="lg" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <span className="ml-auto">
            <Button
              variant="primary"
              size="lg"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              {submitting ? 'Creating' : 'Save as draft'}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Title" htmlFor="post-title" required>
          <Input
            id="post-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Post title"
          />
          {fieldErrors.title !== undefined ? (
            <p className="text-[11px] text-bad mt-1.5">{fieldErrors.title}</p>
          ) : null}
        </Field>

        <Field label="Caption" htmlFor="post-caption" required>
          <Textarea
            id="post-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Write the caption"
          />
          {fieldErrors.caption !== undefined ? (
            <p className="text-[11px] text-bad mt-1.5">{fieldErrors.caption}</p>
          ) : null}
        </Field>

        <Field label="Channel" required>
          <div className="flex flex-wrap gap-2">
            {POST_PLATFORMS.map((value) => (
              <Chip
                key={value}
                label={humanize(value)}
                selected={platform === value}
                onClick={() => setPlatform(value)}
              />
            ))}
          </div>
          {fieldErrors.platform !== undefined ? (
            <p className="text-[11px] text-bad mt-1.5">{fieldErrors.platform}</p>
          ) : null}
        </Field>

        <Field label="Format">
          <div className="flex flex-wrap gap-2">
            {POST_FORMATS.map((value) => (
              <Chip
                key={value}
                label={humanize(value)}
                selected={format === value}
                onClick={() => setFormat(value)}
              />
            ))}
          </div>
        </Field>

        <Field label="Target date" htmlFor="post-target-date">
          <Input
            id="post-target-date"
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
          />
        </Field>

        <Field label="Origin">
          <div className="flex h-11 items-center px-3 rounded-md border border-border bg-panel-2 text-sm text-fg-3">
            None
          </div>
        </Field>

        <Field label="Assets">
          <div className="flex flex-col items-center justify-center gap-1.5 min-h-[88px] rounded-md border border-dashed border-border bg-panel-2 text-fg-3 text-sm px-3 py-4">
            <IconUpload size={20} />
            <span>Drag and drop, or browse</span>
          </div>
        </Field>

        {submitError !== null ? (
          <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
            {submitError}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
