// Pure presentation helpers for Activity cards: a compact relative timestamp, a
// one-line summary per event, and a neutral title fallback. No hooks, no I/O.

import type { ActivityItem } from './types';

/** Compact relative time: just now / 5m / 3h / 2d / 4w. */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const diffMs = Math.max(0, nowMs - Date.parse(iso));
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

function actor(item: ActivityItem): string {
  return item.actorName ?? 'Someone';
}

/** A short, human line for the latest event in a card. No em-dashes. */
export function eventSummary(item: ActivityItem): string {
  switch (item.eventType) {
    case 'comment':
      return `${actor(item)} left a comment`;
    case 'mention':
      return `${actor(item)} mentioned you`;
    case 'stage_change':
      return item.toStage !== null ? `Moved to ${item.toStage}` : 'Stage updated';
    case 'decision_marked':
      return `${actor(item)} marked a decision`;
    case 'brief_created':
      return `${actor(item)} created a brief`;
    case 'brief_closed':
      return `${actor(item)} closed the brief`;
    case 'asset_uploaded':
      return 'A new asset was uploaded';
    case 'asset_version_added':
      return 'A new version was added';
    case 'invite':
      return `${actor(item)} invited you`;
    case 'trial_warning':
      return 'Your trial is ending soon';
    case 'billing_failure':
      return 'A payment could not be processed';
    case 'system':
      return 'System update';
    default:
      return item.eventType.replace(/_/g, ' ');
  }
}

/** Card title: the resolved entity title, else a neutral per-type fallback. */
export function cardTitle(item: ActivityItem): string {
  if (item.entityTitle !== null && item.entityTitle.length > 0) return item.entityTitle;
  if (item.entityType === 'post') return 'Untitled post';
  if (item.entityType === 'brief') return 'Untitled brief';
  return 'Activity';
}
