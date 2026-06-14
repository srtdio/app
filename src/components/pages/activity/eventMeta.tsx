// Maps an Activity event_type to its icon and a tone (tinted by meaning). Pure,
// token-only: tones resolve to existing fg/good/warn/bad/accent classes so both
// themes render correctly with no new colors.

import type { ReactElement } from 'react';
import {
  IconAlert,
  IconBriefs,
  IconCheckCircle,
  IconClock,
  IconComment,
  IconFlag,
  IconInfo,
  IconLayers,
  IconMention,
  IconStageMove,
  IconUpload,
  IconUserPlus,
} from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import type { ActivityItem } from './types';

type IconComponent = (props: IconProps) => ReactElement;

const EVENT_ICON: Record<string, IconComponent> = {
  comment: IconComment,
  mention: IconMention,
  stage_change: IconStageMove,
  decision_marked: IconFlag,
  brief_created: IconBriefs,
  brief_closed: IconCheckCircle,
  asset_uploaded: IconUpload,
  asset_version_added: IconLayers,
  invite: IconUserPlus,
  trial_warning: IconClock,
  billing_failure: IconAlert,
  system: IconInfo,
};

export type Tone = 'good' | 'bad' | 'warn' | 'accent' | 'neutral';

/** Tinted-circle classes per tone (existing tokens only, light/dark parity). */
export const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-panel-2 text-good',
  bad: 'bg-panel-2 text-bad',
  warn: 'bg-panel-2 text-warn',
  accent: 'bg-accent-soft text-accent',
  neutral: 'bg-panel-2 text-fg-2',
};

export function eventIcon(eventType: string, size = 16): ReactElement {
  const Icon = EVENT_ICON[eventType] ?? IconInfo;
  return <Icon size={size} />;
}

export function eventTone(item: ActivityItem): Tone {
  if (item.eventType === 'mention') return 'accent';
  if (item.eventType === 'decision_marked' || item.eventType === 'brief_closed') return 'good';
  if (item.eventType === 'billing_failure') return 'bad';
  if (item.eventType === 'trial_warning') return 'warn';
  if (item.eventType === 'stage_change') {
    if (item.toStage === 'approved') return 'good';
    if (item.toStage === 'rejected') return 'bad';
    if (item.toStage === 'parked') return 'warn';
  }
  return 'neutral';
}
