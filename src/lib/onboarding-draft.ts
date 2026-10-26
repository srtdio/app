// The pre-app screens' answers, kept on this device until the profile is saved,
// so a refresh (or the browser reopening the tab) lands on the same screen with
// everything already filled in. Per person: another account on the same browser
// never sees it. Storage can be blocked or empty; then the screens just start
// fresh, as before.

import type { OnboardingStep, Side } from '@/lib/onboarding';

interface OnboardingDraft {
  step: OnboardingStep;
  side: Side | null;
  name: string;
  username: string;
  usernameEdited: boolean;
  role: string;
  roleOther: string;
  /** The uploaded photo's public URL; '' when none finished uploading. */
  avatarUrl: string;
  teamEmail: string;
  brandName: string;
}

const KEY_PREFIX = 'srtd.onboarding.draft.';

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Rebuild a draft from stored JSON, field by field; undefined when it is not one. */
function parseDraft(raw: string | null): OnboardingDraft | undefined {
  if (raw === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const row = value as Record<string, unknown>;
  const step = text(row.step);
  if (step === '') return undefined;
  const side = row.side === 'creator' || row.side === 'approver' ? row.side : null;
  return {
    step: step as OnboardingStep,
    side,
    name: text(row.name),
    username: text(row.username),
    usernameEdited: row.usernameEdited === true,
    role: text(row.role),
    roleOther: text(row.roleOther),
    avatarUrl: text(row.avatarUrl),
    teamEmail: text(row.teamEmail),
    brandName: text(row.brandName),
  };
}

export function readDraft(userId: string | null): OnboardingDraft | undefined {
  if (userId === null) return undefined;
  try {
    return parseDraft(window.localStorage.getItem(keyFor(userId)));
  } catch {
    return undefined;
  }
}

export function writeDraft(userId: string | null, draft: OnboardingDraft): void {
  if (userId === null) return;
  try {
    window.localStorage.setItem(keyFor(userId), JSON.stringify(draft));
  } catch {
    // Blocked or full storage: a refresh starts the screens fresh.
  }
}

export function clearDraft(userId: string | null): void {
  if (userId === null) return;
  try {
    window.localStorage.removeItem(keyFor(userId));
  } catch {
    // Nothing kept, nothing to clear.
  }
}
