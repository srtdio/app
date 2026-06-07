import { useEffect, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Chip } from '@/components/ui/Chip';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { briefCreate } from '@srtdio/rpc';
import { POST_FORMATS } from '@srtdio/posts';
import type { Json } from '@srtdio/schemas';

interface CreateBriefSheetProps {
  open: boolean;
  workspaceId: string | null;
  onClose: () => void;
  onCreated: () => void;
}

/** Title-case a snake_case enum value for display (single_image -> Single Image). */
function humanize(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// 'Any' is the absence of a format requirement: when selected, format_requested
// is omitted from the payload rather than sent. It is not a POST_FORMATS value.
const FORMAT_ANY = '';

export function CreateBriefSheet({ open, workspaceId, onClose, onCreated }: CreateBriefSheetProps) {
  const newTrace = useNewTrace();
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [format, setFormat] = useState<string>(FORMAT_ANY);
  const [brandRequirements, setBrandRequirements] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [referenceLink, setReferenceLink] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset the form each time the sheet opens so a prior draft never lingers.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setObjective('');
    setFormat(FORMAT_ANY);
    setBrandRequirements('');
    setTargetDate('');
    setReferenceLink('');
    setFieldErrors({});
    setSubmitError(null);
    setSubmitting(false);
  }, [open]);

  // @srtdio/briefs exports CreateBriefInput as a type only (no runtime schema),
  // so title/objective are validated inline: both must be non-empty.
  const canSubmit =
    workspaceId !== null && title.trim() !== '' && objective.trim() !== '' && !submitting;

  async function handleSubmit(): Promise<void> {
    if (workspaceId === null) return;

    const errors: Record<string, string> = {};
    if (title.trim() === '') errors.title = 'Title is required.';
    if (objective.trim() === '') errors.objective = 'Objective is required.';
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    setSubmitError(null);

    // Shape the snake_case jsonb payload brief_create reads. Optional keys are
    // included only when the user supplied them. No created_by / actor id is
    // ever sent: the proc derives the actor from auth.uid() server-side.
    const payload: Record<string, Json> = {
      title: title.trim(),
      objective: objective.trim(),
    };
    if (format !== FORMAT_ANY) payload.format_requested = format;
    if (brandRequirements.trim() !== '') payload.brand_requirements = brandRequirements.trim();
    if (targetDate !== '') payload.target_date = targetDate;
    if (referenceLink.trim() !== '') payload.reference_links = [referenceLink.trim()];

    const result = await briefCreate(supabase, {
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
      title="New brief"
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
              {submitting ? 'Creating' : 'Create brief'}
            </Button>
          </span>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs text-fg-3">
          Briefs are written by clients and are read-only once created.
        </p>

        <Field label="Title" htmlFor="brief-title" required>
          <Input
            id="brief-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Brief title"
          />
          {fieldErrors.title !== undefined ? (
            <p className="text-[11px] text-bad mt-1.5">{fieldErrors.title}</p>
          ) : null}
        </Field>

        <Field label="Objective" htmlFor="brief-objective" required>
          <Textarea
            id="brief-objective"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="What should this brief achieve?"
          />
          {fieldErrors.objective !== undefined ? (
            <p className="text-[11px] text-bad mt-1.5">{fieldErrors.objective}</p>
          ) : null}
        </Field>

        <Field label="Format requested">
          <div className="flex flex-wrap gap-2">
            <Chip
              label="Any"
              selected={format === FORMAT_ANY}
              size="tap"
              onClick={() => setFormat(FORMAT_ANY)}
            />
            {POST_FORMATS.map((value) => (
              <Chip
                key={value}
                label={humanize(value)}
                selected={format === value}
                size="tap"
                onClick={() => setFormat(value)}
              />
            ))}
          </div>
        </Field>

        <Field label="Brand requirements" htmlFor="brief-brand">
          <Textarea
            id="brief-brand"
            value={brandRequirements}
            onChange={(event) => setBrandRequirements(event.target.value)}
            placeholder="Tone, do's and don'ts, mandatory mentions"
          />
        </Field>

        <Field label="Target date" htmlFor="brief-target-date">
          <Input
            id="brief-target-date"
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
          />
        </Field>

        <Field label="Reference link" htmlFor="brief-reference">
          <Input
            id="brief-reference"
            type="url"
            value={referenceLink}
            onChange={(event) => setReferenceLink(event.target.value)}
            placeholder="https://example.com"
          />
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
