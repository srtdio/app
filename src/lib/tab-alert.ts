// The desktop tab alert: while Sorted is in a background tab, new activity or a
// chat message makes the tab speak. The title alternates every ALERT_STEP_MS
// between "(N) <base title>" and each new event's own words in turn ("Chitra
// commented on Diwali reel", "Chat · Aditya sent a message"), and the tab icon
// gains a dot: amber for Activity, blue for chat (the newest event's kind). It
// stops the moment the tab is visible again, restoring the title and icon.
//
// Browsers draw tab text in their own font and colour, so only the words and
// the icon change. Callers never push the viewer's own actions, and chat
// alerts never carry message text (who wrote, not what).
//
// The pure rules (titleFor, dotColor) are unit-tested; the controller below only
// wires them to document.title, a canvas-drawn favicon and visibilitychange.

import { tabTitle } from '@/lib/chat/notify-sound';

export type TabAlertKind = 'activity' | 'chat';

export interface TabAlert {
  kind: TabAlertKind;
  /** The words the tab shows for this event. */
  text: string;
}

/** One title step: even steps show the count, odd steps the next event. */
export const ALERT_STEP_MS = 1_400;

/** Icon dot colours: amber for Activity, blue for chat (prototype values). */
export const ALERT_DOT: Readonly<Record<TabAlertKind, string>> = {
  activity: '#C26A00',
  chat: '#2457D6',
};

/** Pure: the title for a step, given the base title and the pending events. */
export function titleFor(base: string, queue: readonly TabAlert[], step: number): string {
  if (queue.length === 0) return base;
  if (step % 2 === 0) return tabTitle(base, queue.length);
  const event = queue[Math.floor(step / 2) % queue.length];
  return event?.text ?? tabTitle(base, queue.length);
}

/** Pure: the dot colour, from the newest pending event; null when nothing is pending. */
export function dotColor(queue: readonly TabAlert[]): string | null {
  const newest = queue[queue.length - 1];
  return newest !== undefined ? ALERT_DOT[newest.kind] : null;
}

/** Pure: the chat alert's words. Never the message text. */
export function chatAlertText(channelType: string, title: string): string {
  return channelType === 'group'
    ? `Chat · New message in ${title}`
    : `Chat · ${title} sent a message`;
}

// ---------------------------------------------------------------------------
// Controller (browser only). One shared queue for the whole app.

const ICON_ID = 'srtd-tab-alert-icon';
const ICON_SRC = '/favicon.svg';
const ICON_SIZE = 64;

let queue: TabAlert[] = [];
let step = 0;
let timer: number | null = null;
let base: string | null = null;
let lastSet: string | null = null;
let listening = false;
let iconImage: HTMLImageElement | null = null;

function setTitle(next: string): void {
  lastSet = next;
  document.title = next;
}

/** The title someone else (the chat's unread prefix) last set, else the remembered one. */
function currentBase(): string {
  if (base === null || (document.title !== lastSet && document.title !== base)) {
    base = document.title;
  }
  return base;
}

function loadIcon(): Promise<HTMLImageElement> {
  if (iconImage !== null && iconImage.complete) return Promise.resolve(iconImage);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      iconImage = img;
      resolve(img);
    };
    img.onerror = () => reject(new Error('tab alert: icon failed to load'));
    img.src = ICON_SRC;
  });
}

function removeDotIcon(): void {
  document.getElementById(ICON_ID)?.remove();
}

function drawDotIcon(color: string): void {
  void loadIcon()
    .then((img) => {
      if (queue.length === 0) return;
      const canvas = document.createElement('canvas');
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return;
      ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
      ctx.beginPath();
      ctx.arc(ICON_SIZE - 13, 13, 12, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ICON_SIZE - 13, 13, 9, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      let link = document.getElementById(ICON_ID) as HTMLLinkElement | null;
      if (link === null) {
        link = document.createElement('link');
        link.id = ICON_ID;
        link.rel = 'icon';
        link.type = 'image/png';
        document.head.appendChild(link);
      }
      link.href = canvas.toDataURL('image/png');
    })
    .catch(() => undefined);
}

function render(): void {
  setTitle(titleFor(currentBase(), queue, step));
}

/** Stop alerting: restore the title and icon. Safe to call any time. */
export function clearTabAlert(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  queue = [];
  step = 0;
  removeDotIcon();
  if (base !== null && document.title === lastSet) document.title = base;
  base = null;
  lastSet = null;
}

function listen(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) clearTabAlert();
  });
}

/** Alert for one new event, only while the tab is in the background. */
export function pushTabAlert(alert: TabAlert): void {
  if (typeof document === 'undefined' || !document.hidden) return;
  listen();
  queue = [...queue, alert];
  step = 1;
  render();
  const color = dotColor(queue);
  if (color !== null) drawDotIcon(color);
  if (timer === null) {
    timer = window.setInterval(() => {
      if (!document.hidden) {
        clearTabAlert();
        return;
      }
      step += 1;
      render();
    }, ALERT_STEP_MS);
  }
}
