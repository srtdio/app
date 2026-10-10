// The concept sheet: title, description, date and library files. One
// component for both "Add concept" (the New plan screen) and "Edit concept"
// (a concept's item screen); the parent owns the form and the submit. The
// files picker opens over it and closes with it. Tokens only; the Sheet's
// translateY motion only.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { IconX } from '@/components/ui/icons';
import { Thumbnail } from '@/components/media/Thumbnail';
import { AssetPicker } from '@/components/chat/AssetPicker';
import { PRESIGN_ENABLED, sharedCardPresignCache } from '@/components/chat/PostCard';
import { ConceptDateField } from '@/components/chat/PlanScreen';
import { CONCEPT_FILES_MAX, PLAN_TITLE_MAX } from '@/components/chat/plan-card';
import { cn } from '@/lib/cn';

/** A concept file as the sheet shows it (a library pick, or a recorded version). */
export interface ConceptFile {
  versionId: string;
  name: string;
}

/** The concept being added or edited. */
export interface ConceptForm {
  title: string;
  description: string;
  files: ConceptFile[];
  /** "YYYY-MM-DD", or '' for no date. */
  date: string;
}

export const EMPTY_CONCEPT: ConceptForm = { title: '', description: '', files: [], date: '' };

/** Max description length (the proc's limit). */
export const CONCEPT_DESCRIPTION_MAX = 5000;

export const FIELD =
  'min-h-[48px] w-full rounded-lg border border-border bg-panel px-3.5 text-base text-fg placeholder:text-fg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60';

/** Whether the form can be submitted: a title of 1 to 200 characters. Pure. */
export function conceptFormValid(form: Pick<ConceptForm, 'title'>): boolean {
  const t = form.title.trim();
  return t !== '' && t.length <= PLAN_TITLE_MAX;
}

export function ConceptSheet(props: {
  open: boolean;
  mode: 'add' | 'edit';
  form: ConceptForm;
  onChange: (update: (form: ConceptForm) => ConceptForm) => void;
  onSubmit: () => void;
  onClose: () => void;
  busy?: boolean;
  /** A muted line above the buttons; none when null or absent. */
  note?: string | null;
  /** False while the concept's current files are not known (edit only). */
  filesReady?: boolean;
}): ReactElement {
  const { form, onChange } = props;
  const busy = props.busy === true;
  const filesReady = props.filesReady !== false;
  const [assetsOpen, setAssetsOpen] = useState(false);
  // A closed sheet closes its picker too.
  useEffect(() => {
    if (!props.open) setAssetsOpen(false);
  }, [props.open]);
  const edit = props.mode === 'edit';
  return (
    <>
      <Sheet
        open={props.open}
        onClose={props.onClose}
        title={edit ? 'Edit concept' : 'Add concept'}
        footer={
          <div className="flex w-full flex-col gap-2">
            {props.note !== undefined && props.note !== null ? (
              <p data-plan-concept-reset="" className="text-[13px] leading-[18px] text-fg-3">
                {props.note}
              </p>
            ) : null}
            <div className="grid w-full grid-cols-2 gap-2">
              <Button size="lg" variant="ghost" disabled={busy} onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                size="lg"
                variant="primary"
                data-plan-concept-save=""
                disabled={busy || !conceptFormValid(form)}
                onClick={props.onSubmit}
              >
                {edit ? 'Save' : 'Add'}
              </Button>
            </div>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-3">Title</span>
            <input
              data-plan-concept-title=""
              value={form.title}
              maxLength={PLAN_TITLE_MAX}
              autoComplete="off"
              disabled={busy}
              onChange={(e) => {
                const title = e.target.value;
                onChange((f) => ({ ...f, title }));
              }}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] text-fg-3">Description</span>
            <textarea
              data-plan-concept-description=""
              value={form.description}
              maxLength={CONCEPT_DESCRIPTION_MAX}
              rows={3}
              disabled={busy}
              onChange={(e) => {
                const description = e.target.value;
                onChange((f) => ({ ...f, description }));
              }}
              className={cn(FIELD, 'py-2.5')}
            />
          </label>
          <ConceptDateField
            value={form.date}
            disabled={busy}
            onChange={(date) => onChange((f) => ({ ...f, date }))}
          />
          {form.files.length > 0 ? (
            <div className="grid grid-cols-4 gap-1.5">
              {form.files.map((f) => (
                <div
                  key={f.versionId}
                  data-plan-concept-file=""
                  className="relative overflow-hidden rounded-md border border-border bg-panel-2"
                >
                  <Thumbnail
                    assetVersionId={f.versionId}
                    cache={sharedCardPresignCache()}
                    presignEnabled={PRESIGN_ENABLED}
                    fallback={{ kind: 'glyph' }}
                    alt={f.name}
                  />
                  <button
                    type="button"
                    data-plan-concept-file-remove=""
                    aria-label={`Remove ${f.name}`}
                    disabled={busy}
                    onClick={() =>
                      onChange((x) => ({
                        ...x,
                        files: x.files.filter((y) => y.versionId !== f.versionId),
                      }))
                    }
                    className="absolute right-0 top-0 flex h-11 w-11 items-start justify-end p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-panel text-fg-2">
                      <IconX size={14} />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <Button
            size="lg"
            data-plan-concept-files=""
            disabled={busy || !filesReady || form.files.length >= CONCEPT_FILES_MAX}
            onClick={() => setAssetsOpen(true)}
          >
            Add files
          </Button>
        </div>
      </Sheet>

      <AssetPicker
        open={props.open && assetsOpen}
        onClose={() => setAssetsOpen(false)}
        onConfirm={(picks) => {
          setAssetsOpen(false);
          onChange((f) => {
            const seen = new Set(f.files.map((x) => x.versionId));
            const next = [
              ...f.files,
              ...picks
                .filter((p) => !seen.has(p.versionId))
                .map((p): ConceptFile => ({ versionId: p.versionId, name: p.name })),
            ];
            return { ...f, files: next.slice(0, CONCEPT_FILES_MAX) };
          });
        }}
      />
    </>
  );
}
