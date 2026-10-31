// Add to a plan on a picked day, from the empty-day menu: the Plan screen's
// own Add sheet ("Add to <day>": New concept or Pick a post), its Concept
// sheet with that day set, and its post picker whose picks all go on that
// day. The writes are the Plan screen's: one plan_concept_add, or one
// plan_posts_add with the day; the same toasts and failure copy. Nothing is
// sent to any chat. A write tells every open plan surface (PLAN_CHANGED_EVENT).

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { PostCardFields } from '@srtdio/posts';
import { planConceptAdd, planPostsAdd } from '@srtdio/rpc';
import { ConceptSheet, EMPTY_CONCEPT, type ConceptForm } from '@/components/chat/ConceptSheet';
import { PlanAddSheet } from '@/components/chat/PlanAddSheet';
import { PostPicker } from '@/components/chat/PostPicker';
import {
  ADD_FAILED,
  addedToast,
  dayHeaderOf,
  planWriteErrorCopy,
} from '@/components/chat/plan-card';
import { useToast } from '@/components/ui/toast';
import { conceptAddArgs, dispatchPlanChanged, type PlanBundle } from '@/lib/chat/plans';
import { useCommentAttachments } from '@/lib/chat/use-chat-attachments';
import { logger } from '@/lib/logger';
import { civilToday } from '@/lib/plan-week';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

/** A plan and the day to add on. */
export interface AddTarget {
  bundle: PlanBundle;
  day: string;
}

type Stage = 'menu' | 'concept' | 'pick';

export function PlanTabAdd(props: {
  target: AddTarget | null;
  timeZone: string;
  onClose: () => void;
}): ReactElement {
  const toast = useToast();
  const { canAttach, uploadFile } = useCommentAttachments();
  const [stage, setStage] = useState<Stage | null>(null);
  // The last target stays while the sheets animate out.
  const [shown, setShown] = useState<AddTarget | null>(null);
  const [form, setForm] = useState<ConceptForm>(EMPTY_CONCEPT);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<PostCardFields[]>([]);
  const target = props.target;

  useEffect(() => {
    if (target === null) return;
    setShown(target);
    setStage('menu');
  }, [target]);

  const close = (): void => {
    setStage(null);
    props.onClose();
  };

  const planId = shown?.bundle.plan.id ?? '';
  const day = shown?.day ?? null;
  const range =
    shown !== null
      ? { startsOn: shown.bundle.plan.starts_on, endsOn: shown.bundle.plan.ends_on }
      : undefined;
  const inPlan = useMemo(
    () =>
      new Set((shown?.bundle.items ?? []).flatMap((i) => (i.post_id !== null ? [i.post_id] : []))),
    [shown],
  );

  const saveConcept = async (): Promise<void> => {
    if (busy || shown === null) return;
    const date = form.date === '' ? null : form.date;
    setBusy(true);
    const traceId = generateTraceId();
    const result = await planConceptAdd(
      supabase,
      conceptAddArgs(
        planId,
        {
          key: '',
          title: form.title.trim(),
          description: form.description.trim(),
          versionIds: form.files.map((f) => f.versionId),
          targetDate: date,
        },
        traceId,
      ),
    );
    setBusy(false);
    if (!result.ok) {
      logger.warn('plan tab: concept add failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: planWriteErrorCopy(result.error.message, ADD_FAILED) });
      return;
    }
    close();
    toast.show({ title: addedToast('concept', dayHeaderOf(date)) });
    dispatchPlanChanged(window, planId);
  };

  // Dismissing the picker (X, backdrop, swipe, Escape, Back) drops the ticks
  // and adds nothing; only Done adds them.
  const dismissPicker = (): void => {
    close();
    setPicked([]);
  };

  const addPicked = async (): Promise<void> => {
    const posts = picked;
    close();
    setPicked([]);
    if (posts.length === 0 || day === null) return;
    const traceId = generateTraceId();
    const result = await planPostsAdd(supabase, {
      p_plan_id: planId,
      p_post_ids: posts.map((p) => p.id),
      p_trace_id: traceId,
      p_target_date: day,
    });
    if (!result.ok) {
      logger.warn('plan tab: posts add failed', {
        trace_id: traceId,
        plan_id: planId,
        error: result.error.message,
      });
      toast.show({ title: planWriteErrorCopy(result.error.message, ADD_FAILED) });
      return;
    }
    toast.show({ title: addedToast('post', dayHeaderOf(day)) });
    dispatchPlanChanged(window, planId);
  };

  return (
    <>
      <PlanAddSheet
        open={stage === 'menu'}
        dayHeader={dayHeaderOf(day)}
        onNewConcept={() => {
          setForm({ ...EMPTY_CONCEPT, date: day ?? '' });
          setStage('concept');
        }}
        onPickPost={() => {
          setPicked([]);
          setStage('pick');
        }}
        onClose={close}
      />
      <ConceptSheet
        open={stage === 'concept'}
        mode="add"
        form={form}
        onChange={setForm}
        onSubmit={() => void saveConcept()}
        onClose={() => {
          if (!busy) close();
        }}
        busy={busy}
        {...(range !== undefined ? { range, today: civilToday(new Date(), props.timeZone) } : {})}
        {...(canAttach ? { uploadFile } : {})}
      />
      <PostPicker
        open={stage === 'pick'}
        onClose={dismissPicker}
        onDone={() => void addPicked()}
        mode="posts"
        selected={picked}
        onToggle={(post) =>
          setPicked((prev) =>
            prev.some((p) => p.id === post.id)
              ? prev.filter((p) => p.id !== post.id)
              : [...prev, post],
          )
        }
        selectedBriefs={[]}
        onToggleBrief={() => {}}
        channelHasClient={false}
        excludePostIds={inPlan}
      />
    </>
  );
}
