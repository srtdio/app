import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  canScheduleDraft,
  pendingCounts,
  scheduledToast,
  scheduleFilesFor,
  SCHEDULING_LABEL,
  withScheduleUpload,
  type Pending,
} from '@/components/chat/Composer';
import {
  filesLabel,
  ScheduleFooter,
  ScheduleMenu,
  ScheduleOptions,
  schedulePreview,
  SCHEDULE_HELPER,
  zoneLine,
} from '@/components/chat/ScheduleSheet';
import {
  ScheduledAttachments,
  ScheduledStrip,
  ScheduleModeStrip,
  thumbTiles,
} from '@/components/chat/ScheduledStrip';
import {
  BodyEditor,
  canEditScheduled,
  scheduledPreviewText,
  showsPreviewBubble,
} from '@/components/chat/ScheduledListSheet';
import { SCHEDULED_FILES_READONLY_COPY, SCHEDULE_UPLOAD_FAILED_COPY } from '@/lib/chat/scheduled';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { IconCalendarClock } from '@/components/ui/icons';
import type { ScheduledRow } from '@/lib/chat/scheduled';

const EM_DASH = String.fromCharCode(0x2014);
// Built from char codes so this file passes the chat token-hygiene scan itself.
const HEX = new RegExp(`${String.fromCharCode(35)}[0-9a-fA-F]{3,8}\\b`);
const DARK = new RegExp(`\\b${'da'}rk${String.fromCharCode(58)}`);

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

function row(partial: Partial<ScheduledRow>): ScheduledRow {
  return {
    id: 'r1',
    channel_id: 'c1',
    workspace_id: 'w1',
    sender_user_id: 'u1',
    body: null,
    mentions: null,
    attachment_asset_ids: null,
    attachment_meta: null,
    shared_post_ids: null,
    shared_brief_ids: null,
    reply_to_message_id: null,
    send_at: new Date(Date.now() + 86_400_000).toISOString(),
    status: 'scheduled',
    failure_reason: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...partial,
  };
}

describe('S2: when a draft may be scheduled', () => {
  it('only with the wiring, a sendable draft (files allowed), not editing', () => {
    const ok = { scheduling: true, editing: false, canSend: true };
    expect(canScheduleDraft(ok)).toBe(true);
    expect(canScheduleDraft({ ...ok, scheduling: false })).toBe(false);
    expect(canScheduleDraft({ ...ok, editing: true })).toBe(false);
    expect(canScheduleDraft({ ...ok, canSend: false })).toBe(false);
  });
});

describe('S2: phone hold and laptop chevron wiring', () => {
  const composer = source('../Composer.tsx');
  it('the hold reuses useLongPress and only rides Send on touch', () => {
    expect(composer).toContain("from '@/components/ui/useLongPress'");
    expect(composer).toContain("const holdToSchedule = layout === 'touch' && schedulable;");
    expect(composer).toContain('{...(holdToSchedule ? sendHold.handlers : {})}');
    // No iOS selection or callout, no context menu, and the hold never submits.
    expect(composer).toContain('holdToSchedule && NO_TOUCH_SELECT');
    expect(composer).toContain('onContextMenu={holdToSchedule ? (event) => event.preventDefault()');
    expect(composer).toContain('if (sendHold.consumeClickSuppression()) event.preventDefault();');
    expect(composer).toContain('swallowTrailingClick();');
  });

  it('the chevron is laptop only, 44px, labelled', () => {
    expect(composer).toContain("const showChevron = layout === 'laptop' && schedulable;");
    expect(composer).toContain('aria-label="Schedule options"');
    expect(composer).toContain('className="shrink-0 rounded-l-none"');
    expect(composer).toMatch(/shape="round"\s+aria-label="Schedule options"/);
  });

  it('the camera input is gone (Photos still offers Take Photo)', () => {
    expect(composer).not.toContain('cameraInputRef');
    expect(composer).not.toContain('capture="environment"');
  });

  it('schedule mode swaps the Send icon and label', () => {
    expect(composer).toMatch(/scheduling\s+\? 'Schedule message'\s+: 'Send'/);
    expect(composer).toContain('<IconCalendarClock size={ICON_SIZE.control} />');
  });
});

describe('S3: the Schedule options', () => {
  it('rows: Tomorrow and Monday with mono times, then Custom time', () => {
    const html = renderToStaticMarkup(
      <ScheduleOptions preview="To Ops: hello" onPick={() => undefined} />,
    );
    expect(html).toContain('data-schedule-row="tomorrow"');
    expect(html).toContain('data-schedule-row="monday"');
    expect(html).toContain('data-schedule-row="custom"');
    expect(html).toContain('Custom time');
    expect(html).toContain('font-mono');
    expect(html).toContain('min-h-[56px]');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('To Ops: hello');
    expect(html).toMatch(/9:00 AM/);
  });

  it('no preview without a draft', () => {
    const html = renderToStaticMarkup(<ScheduleOptions preview={null} onPick={() => undefined} />);
    expect(html).not.toContain('data-schedule-preview');
    expect(schedulePreview('Ops', '   ')).toBeNull();
    expect(schedulePreview('Ops', 'hi\nthere')).toBe('To Ops: hi there');
  });

  it('the footer names the device zone from Intl', () => {
    expect(zoneLine(new Date())).toMatch(/^Times are in your time zone/);
    expect(SCHEDULE_HELPER).toBe('Any time from 1 minute to 1 year ahead.');
  });

  it('the laptop menu fades only (no translate)', () => {
    const html = renderToStaticMarkup(
      <ScheduleMenu open onClose={() => undefined} preview={null} onPick={() => undefined} />,
    );
    expect(html).toContain('data-schedule-menu');
    const surface = /data-schedule-menu="" class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(surface).toContain('transition-opacity');
    expect(surface).not.toMatch(/translate-|rotate-|scale-/);
    expect(html).toContain('right-3');
    expect(html).toContain('bottom-full');
    // Popover radius role: 12px.
    expect(surface).toContain('rounded-xl');
    expect(surface).toContain('duration-base');
    expect(surface).not.toMatch(/duration-\[|ease-out/);
  });

  it('the phone sheet has no footer Cancel; the laptop menu keeps it', () => {
    const phone = renderToStaticMarkup(<ScheduleFooter />);
    expect(phone).toContain('data-schedule-zone');
    expect(phone).not.toContain('Cancel');
    const laptop = renderToStaticMarkup(<ScheduleFooter onCancel={() => undefined} />);
    expect(laptop).toContain('Cancel');
    const menu = renderToStaticMarkup(
      <ScheduleMenu open onClose={() => undefined} preview={null} onPick={() => undefined} />,
    );
    expect(menu).toContain('>Cancel<');
    const src = source('../ScheduleSheet.tsx');
    expect(src).toContain('footer={<ScheduleFooter />}');
    expect(src).toContain('<ScheduleFooter onCancel={props.onClose} />');
  });
});

describe('S4 / S6: strips', () => {
  it('schedule mode: "Sends <label>" and a 44px x', () => {
    const html = renderToStaticMarkup(
      <ScheduleModeStrip label="tomorrow 9:00 AM" onStop={() => undefined} />,
    );
    expect(html).toContain('Sends tomorrow 9:00 AM');
    expect(html).toContain('aria-label="Stop scheduling"');
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('bg-accent-soft');
    const surface = /data-schedule-mode="" class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(surface).toContain('translate-y-full');
    expect(surface).toContain('transition-transform');
    expect(surface).not.toMatch(/translate-x|rotate-|scale-|opacity/);
  });

  it('scheduled strip: 48px button, count, next time in mono, nothing when empty', () => {
    const now = new Date(2026, 9, 3, 12);
    const one = renderToStaticMarkup(
      <ScheduledStrip
        rows={[row({ send_at: new Date(2026, 9, 4, 9).toISOString() })]}
        onOpen={() => undefined}
        now={now}
      />,
    );
    expect(one).toContain('h-12');
    expect(one).toContain('bg-accent-soft');
    expect(one).toContain('border-t');
    expect(one).toContain('1 scheduled message<');
    expect(one).toContain('Tomorrow 9:00 AM');
    expect(one).toContain('font-mono');
    expect(one).not.toMatch(/transition|animate-/);
    const two = renderToStaticMarkup(
      <ScheduledStrip
        rows={[
          row({ id: 'a', send_at: new Date(2026, 9, 7, 11, 30).toISOString() }),
          row({ id: 'b', send_at: new Date(2026, 9, 8, 9).toISOString() }),
        ]}
        onOpen={() => undefined}
        now={now}
      />,
    );
    expect(two).toContain('2 scheduled messages');
    expect(two).toContain('Wed 7 Oct, 11:30 AM');
    expect(renderToStaticMarkup(<ScheduledStrip rows={[]} onOpen={() => undefined} />)).toBe('');
  });
});

describe('S7: card previews', () => {
  const nameOf = (id: string) =>
    id === '0190a000-0000-7000-8000-000000000001' ? 'Asha' : undefined;
  it('body with names, else the attachment / shared post label', () => {
    expect(
      scheduledPreviewText(row({ body: 'hi @[0190a000-0000-7000-8000-000000000001]' }), nameOf),
    ).toBe('hi @Asha');
    expect(scheduledPreviewText(row({ attachment_asset_ids: ['a'] }), nameOf)).toBe('Attachment');
    expect(scheduledPreviewText(row({ shared_post_ids: ['p'] }), nameOf)).toBe('Shared post');
  });
});

describe('icon and toast copy', () => {
  it('IconCalendarClock: a calendar with a clock, stroke 1.7', () => {
    const html = renderToStaticMarkup(<IconCalendarClock />);
    expect(html).toContain('stroke-width="1.7"');
    expect(html).toContain('<circle');
  });

  it('toast reads "Scheduled for tomorrow 9:00 AM"', () => {
    expect(scheduledToast(new Date(2026, 9, 4, 9), new Date(2026, 9, 3, 12))).toBe(
      'Scheduled for tomorrow 9:00 AM',
    );
  });
});

describe('S10: tokens only, no em-dash', () => {
  const files = [
    '../ScheduleSheet.tsx',
    '../ScheduledStrip.tsx',
    '../ScheduledListSheet.tsx',
    '../ScheduleContext.tsx',
    '../../../lib/chat/scheduled.ts',
  ];
  it.each(files)('%s', (file) => {
    const src = source(file);
    expect(src).not.toMatch(HEX);
    expect(src).not.toMatch(DARK);
    expect(src).not.toContain(EM_DASH);
  });
});

// ---------------------------------------------------------------------------
// UI-3: photos and files
// ---------------------------------------------------------------------------

const PHOTO_META = {
  v1: { mime: 'image/jpeg', name: 'one.jpg', size: 1 },
  v2: { mime: 'image/jpeg', name: 'two.jpg', size: 1 },
  v3: { mime: 'image/jpeg', name: 'three.jpg', size: 1 },
  v4: { mime: 'image/jpeg', name: 'four.jpg', size: 1 },
  v5: { mime: 'image/jpeg', name: 'five.jpg', size: 1 },
  v6: { mime: 'image/jpeg', name: 'six.jpg', size: 1 },
  f1: { mime: 'application/pdf', name: 'brief.pdf', size: 1 },
};

function pendingFile(id: string, name: string, type: string): Pending {
  return { id, file: new File([new Uint8Array(1)], name, { type }), previewUrl: null };
}

describe('UI-3 S1: picked files no longer block scheduling', () => {
  const composer = source('../Composer.tsx');
  it('the hold, the chevron and the tray tile do not look at the file count', () => {
    expect(composer).not.toMatch(/fileCount: pending\.length,\s*\}\);\s*const scheduling/);
    expect(canScheduleDraft({ scheduling: true, editing: false, canSend: true })).toBe(true);
  });
  it('voice notes still send only (the recorder never schedules)', () => {
    const stop = composer.slice(composer.indexOf('async function stopSend'));
    expect(stop.slice(0, stop.indexOf('\n  }\n'))).not.toMatch(/schedule/i);
  });
  it('the preview names the files when there is no text', () => {
    expect(filesLabel({ photos: 1, others: 0 })).toBe('1 photo');
    expect(filesLabel({ photos: 3, others: 2 })).toBe('3 photos, 2 files');
    expect(schedulePreview('Ops', '', { photos: 2, others: 0 })).toBe('To Ops: 2 photos');
    expect(schedulePreview('Ops', 'hi', { photos: 2, others: 0 })).toBe('To Ops: hi');
    expect(
      pendingCounts([
        pendingFile('a', 'a.jpg', 'image/jpeg'),
        pendingFile('b', 'b.pdf', 'application/pdf'),
      ]),
    ).toEqual({ photos: 1, others: 1 });
  });
});

describe('UI-3 S2 / S3: upload first, all or nothing', () => {
  const composer = source('../Composer.tsx');
  it('uploads through the normal uploader, then writes with the ids and meta', () => {
    expect(composer).toContain('upload: props.uploadFile,');
    expect(composer).toContain('...attachmentArgs,');
    expect(composer).toContain('scheduleWithFiles<');
  });
  it('the composer locks and Send reads "Scheduling…"', () => {
    expect(SCHEDULING_LABEL).toBe('Scheduling…');
    expect(composer).toContain('readOnly={held || scheduleBusy}');
    expect(composer).toMatch(/function removePending[\s\S]{0,120}if \(scheduleBusy\) return;/);
  });
  it('a chip dims and shows a thin progress bar while it uploads', () => {
    const thumb = composer.slice(composer.indexOf('function PendingThumb'));
    expect(thumb).toContain("uploading && 'opacity-50'");
    expect(thumb).toContain('absolute inset-x-0 bottom-0 h-[3px]');
    expect(thumb).toContain('bg-accent');
  });
  it('a failed upload: the chip takes the failed state, the toast copy is fixed', () => {
    expect(SCHEDULE_UPLOAD_FAILED_COPY).toBe("Couldn't upload. Try again.");
    expect(composer).toContain('scheduleUploads[item.id]?.failed === true');
    expect(composer).toContain('error={scheduleUploads[item.id]?.failed === true}');
  });
  it('the run always unlocks, a failed upload keeps the time, previews go only on success', () => {
    expect(composer).toMatch(/finally \{[\s\S]{0,200}setScheduleBusy\(false\)/);
    expect(composer).toMatch(/'upload-failed'[\s\S]{0,700}setScheduleAt\(sendAt\)/);
    expect(composer).toMatch(
      /if \(outcome\.ok\) \{[\s\S]{0,400}if \(!run\.signal\.aborted\) \{[\s\S]{0,200}revokeObjectURL/,
    );
  });

  it('a retry keeps the version ids already uploaded', () => {
    const pending = [
      pendingFile('a', 'a.jpg', 'image/jpeg'),
      pendingFile('b', 'b.jpg', 'image/jpeg'),
    ];
    let uploads = withScheduleUpload({}, 'a', { versionId: 'v-a', progress: 1 });
    uploads = withScheduleUpload(uploads, 'b', { failed: true });
    expect(scheduleFilesFor(pending, uploads).map((f) => [f.key, f.versionId])).toEqual([
      ['a', 'v-a'],
      ['b', null],
    ]);
  });
  it('leaving the chat aborts the run (cleanup on unmount and chat switch)', () => {
    expect(composer).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*scheduleRunRef\.current\?\.abort\(\);[\s\S]{0,80}\[channelId\]/,
    );
  });
  it('the normal tap-send path is unchanged', () => {
    const send = composer.slice(composer.indexOf('  function send(draft: LinkCardDraft)'));
    expect(send.slice(0, send.indexOf('\n  }\n'))).toContain(
      'attachments: draftAttachments(pending, props.uploadFile),',
    );
  });
});

describe('UI-3 S4: strip and card thumbnails', () => {
  it('up to four photo thumbnails, "+N" on the fourth', () => {
    const images = ['a', 'b', 'c', 'd', 'e', 'f'].map(
      (n): MessageAttachment => ({ assetId: n, name: n, mime: 'image/png' }),
    );
    expect(thumbTiles(images).map((t) => t.more)).toEqual([0, 0, 0, 2]);
    expect(thumbTiles(images.slice(0, 2)).map((t) => t.more)).toEqual([0, 0]);
  });

  it('a card shows photos and files by icon and name; text-only rows are unchanged', () => {
    const r = row({
      attachment_asset_ids: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'f1'],
      attachment_meta: PHOTO_META,
    });
    const html = renderToStaticMarkup(<ScheduledAttachments row={r} size="card" />);
    expect(html.match(/data-scheduled-thumb=""/g)).toHaveLength(4);
    expect(html).toContain('+2');
    expect(html).toContain('brief.pdf');
    expect(html).toContain('bg-overlay');
    const plain = row({ body: 'hello' });
    expect(renderToStaticMarkup(<ScheduledAttachments row={plain} size="card" />)).toBe('');
    expect(showsPreviewBubble(plain)).toBe(true);
    expect(showsPreviewBubble(r)).toBe(false);
  });

  it('the strip shows the first file next to the photos', () => {
    const r = row({ attachment_asset_ids: ['v1', 'f1'], attachment_meta: PHOTO_META });
    const html = renderToStaticMarkup(<ScheduledAttachments row={r} size="strip" />);
    expect(html.match(/data-scheduled-thumb=""/g)).toHaveLength(1);
    expect(html.match(/data-scheduled-file=""/g)).toHaveLength(1);
    expect(html).toContain('brief.pdf');
  });

  it('the strip shows the next message thumbnails', () => {
    const html = renderToStaticMarkup(
      <ScheduledStrip
        rows={[row({ attachment_asset_ids: ['v1'], attachment_meta: PHOTO_META })]}
        onOpen={() => undefined}
      />,
    );
    expect(html).toContain('data-scheduled-thumb');
    expect(html).toContain('h-7 w-7');
  });
});

describe('UI-3 S5: Edit with files is text only', () => {
  it('files are read-only with the line; empty text may save', () => {
    const r = row({ body: '', attachment_asset_ids: ['v1'], attachment_meta: PHOTO_META });
    expect(canEditScheduled(r)).toBe(true);
    expect(canEditScheduled(row({ body: '' }))).toBe(false);
    const html = renderToStaticMarkup(
      <BodyEditor
        row={r}
        nameOf={() => undefined}
        busy={false}
        onDone={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(html).toContain(SCHEDULED_FILES_READONLY_COPY);
    expect(SCHEDULED_FILES_READONLY_COPY).toBe('To change files, cancel and schedule again.');
    expect(html).toContain('data-scheduled-thumb');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Save/);
  });
});

describe('UI-3 S8: the strip refetches on its chat changing', () => {
  const strip = source('../ScheduledStrip.tsx');
  it('subscribes in an effect and returns the unsubscribe', () => {
    expect(strip).toContain(
      'return onScheduledChanged(channelId, () => onChangedRef.current?.());',
    );
  });
  it('stays mounted while empty so a first row still lands', () => {
    const composer = source('../Composer.tsx');
    expect(composer).toContain('rows={schedule.stripVisible ? schedule.rows : NO_SCHEDULED_ROWS}');
    expect(composer).toContain('onChanged={schedule.refetch}');
  });
});

describe('UI-3: no connection wording, no blur', () => {
  it.each(['../Composer.tsx', '../ScheduledStrip.tsx', '../ScheduledListSheet.tsx'])('%s', (f) => {
    const src = source(f);
    expect(src).not.toMatch(/Reconnecting|Offline|backdrop-/);
    expect(src).not.toContain(EM_DASH);
  });
});
