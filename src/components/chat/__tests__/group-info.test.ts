import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { ChatInfoTabs } from '@/components/chat/ChatInfoTabs';
import {
  canEditFromReads,
  canEditGroupInfo,
  GROUP_ACTION_FALLBACK,
  GROUP_INFO_ADMIN_ONLY,
  GroupInfoNotice,
  groupActionMessage,
  groupInfoPage,
  groupInfoSections,
  groupInfoTabs,
  groupPhotoSheetProps,
  LeaveGroupRow,
  MEMBERS_REFRESH_FAILED,
  MembersRefreshNotice,
  membersAfterRefresh,
  requestRename,
  withGroupBusy,
  type GroupInfoSection,
  type GroupInfoTabsWiring,
  type MembersState,
} from '@/components/chat/GroupInfoSheet';
import { PresignCache } from '@/lib/asset-presign';

describe('group info permission (mirrors group_rename)', () => {
  const me = 'user-1';

  it('the creator may edit', () => {
    expect(canEditGroupInfo({ currentUserId: me, creatorId: me, role: 'agency' })).toBe(true);
  });

  it('a workspace owner or admin may edit', () => {
    expect(canEditGroupInfo({ currentUserId: me, creatorId: 'u2', role: 'owner' })).toBe(true);
    expect(canEditGroupInfo({ currentUserId: me, creatorId: null, role: 'admin' })).toBe(true);
  });

  it('anyone else may not', () => {
    expect(canEditGroupInfo({ currentUserId: me, creatorId: 'u2', role: 'agency' })).toBe(false);
    expect(canEditGroupInfo({ currentUserId: me, creatorId: 'u2', role: 'client' })).toBe(false);
    expect(canEditGroupInfo({ currentUserId: me, creatorId: null, role: null })).toBe(false);
  });

  it("maps 'group_manage_denied' to the WhatsApp line; never the raw code", () => {
    expect(GROUP_INFO_ADMIN_ONLY).toBe(
      "Only the group's creator or an admin can edit this group's info",
    );
    expect(groupActionMessage({ code: 'unknown', message: 'group_manage_denied' })).toBe(
      GROUP_INFO_ADMIN_ONLY,
    );
    expect(groupActionMessage({ code: 'group_manage_denied', message: 'x' })).toBe(
      GROUP_INFO_ADMIN_ONLY,
    );
  });
});

describe('F1: every group failure is a readable sentence', () => {
  const known: Array<[string, string]> = [
    ['group_name_taken', 'A group with this name already exists'],
    ['group_name_invalid', 'Enter a valid group name'],
    ['group_not_found', 'This group no longer exists'],
    ['member_not_in_workspace', "This person isn't in the workspace"],
    ['group_manage_denied', "Only the group's creator or an admin can edit this group's info"],
  ];

  it.each(known)('%s reads "%s", by code or as a bare message', (code, sentence) => {
    expect(groupActionMessage({ code, message: 'raw detail' })).toBe(sentence);
    expect(groupActionMessage({ code: 'unknown', message: code })).toBe(sentence);
  });

  it('an unknown code (and any raw message) reads the fallback, never the raw text', () => {
    expect(GROUP_ACTION_FALLBACK).toBe('Something went wrong. Try again.');
    for (const error of [
      { code: 'weird_code', message: 'weird_code' },
      { code: 'unknown', message: 'Network down' },
      { code: '', message: 'permission denied for table groups' },
    ]) {
      const shown = groupActionMessage(error);
      expect(shown).toBe(GROUP_ACTION_FALLBACK);
      expect(shown).not.toContain(error.code || 'x');
      expect(shown).not.toContain(error.message);
    }
  });
});

describe('F2: a failed or pending role read never blocks the rename', () => {
  const me = 'user-1';
  const creator = (id: string | null) => ({ data: { created_by: id }, error: null });

  it('a failed role read or a failed creator read is unknown (null)', () => {
    expect(canEditFromReads({ currentUserId: me, role: null, creator: creator('u2') })).toBeNull();
    expect(
      canEditFromReads({ currentUserId: me, role: 'agency', creator: { data: null, error: {} } }),
    ).toBeNull();
    expect(canEditFromReads({ currentUserId: me, role: 'agency', creator: creator('u2') })).toBe(
      false,
    );
    expect(canEditFromReads({ currentUserId: me, role: 'agency', creator: creator(me) })).toBe(
      true,
    );
  });

  it('failed or pending read: the RPC is called and its denial maps to the sentence', async () => {
    const rename = vi.fn(() => Promise.resolve({ code: 'group_manage_denied', message: 'x' }));
    const outcome = await requestRename({ canEditInfo: null, rename });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'failed', message: GROUP_INFO_ADMIN_ONLY });
  });

  it('both reads succeeded and the viewer is a known non-admin: not called', async () => {
    const rename = vi.fn(() => Promise.resolve(null));
    expect(await requestRename({ canEditInfo: false, rename })).toEqual({ kind: 'blocked' });
    expect(rename).not.toHaveBeenCalled();
  });

  it('an allowed viewer renames', async () => {
    const rename = vi.fn(() => Promise.resolve(null));
    expect(await requestRename({ canEditInfo: true, rename })).toEqual({ kind: 'done' });
    expect(rename).toHaveBeenCalledTimes(1);
  });
});

describe('F10: the admin-only notice', () => {
  it('uses the chat sheet notice size (13/18/400), not text-sm', () => {
    const notice = GroupInfoNotice();
    const props = notice.props as { className: string; children: string };
    expect({ className: props.className, text: props.children }).toMatchSnapshot();
    expect(renderToStaticMarkup(notice)).not.toContain('text-sm');
  });
});

describe('R6: the group sheet never sticks busy and never shows raw text', () => {
  it('a thrown error resets busy and reads the fallback', async () => {
    const busy: boolean[] = [];
    const failure = await withGroupBusy({
      setBusy: (value) => busy.push(value),
      run: () => Promise.reject(new Error('fetch failed: raw detail')),
      onThrow: { code: '', message: '' },
    });
    expect(busy).toEqual([true, false]);
    const shown = groupActionMessage(failure);
    expect(shown).toBe(GROUP_ACTION_FALLBACK);
    expect(shown).not.toContain('raw detail');
  });

  it('a resolved action resets busy and passes its result through', async () => {
    const busy: boolean[] = [];
    const result = await withGroupBusy({
      setBusy: (value) => busy.push(value),
      run: () => Promise.resolve(null),
      onThrow: { code: '', message: '' },
    });
    expect(result).toBeNull();
    expect(busy).toEqual([true, false]);
  });

  it("maps 'workspace_member_only' to its sentence", () => {
    expect(groupActionMessage({ code: 'workspace_member_only', message: 'x' })).toBe(
      'Only workspace members can do this',
    );
    expect(groupActionMessage({ code: 'unknown', message: 'workspace_member_only' })).toBe(
      'Only workspace members can do this',
    );
  });
});

describe('G4: a failed member refresh after an add or remove', () => {
  const shown: MembersState = {
    options: [{ userId: 'u1', displayName: 'Asha', avatarUrl: null }],
    loading: false,
    error: null,
  };

  it('keeps the current list and flags the failure', () => {
    const failed: MembersState = { options: [], loading: false, error: GROUP_ACTION_FALLBACK };
    const outcome = membersAfterRefresh(shown, failed);
    expect(outcome.members).toBe(shown);
    expect(outcome.refreshFailed).toBe(true);
  });

  it('a successful refresh replaces the list and clears the flag', () => {
    const next: MembersState = { ...shown, options: [] };
    expect(membersAfterRefresh(shown, next)).toEqual({ members: next, refreshFailed: false });
  });

  it('shows "Couldn\'t refresh members, try again" as a 44px retry', () => {
    expect(MEMBERS_REFRESH_FAILED).toBe("Couldn't refresh members, try again");
    const onRetry = vi.fn();
    const el = MembersRefreshNotice({ onRetry });
    expect(el.props.children).toBe(MEMBERS_REFRESH_FAILED);
    expect(String(el.props.className)).toContain('min-h-[44px]');
    (el.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('group info full page', () => {
  const nodes: Record<GroupInfoSection, string> = {
    hero: 'HERO',
    tabs: 'TABS',
    name: 'NAME',
    members: 'MEMBERS',
    leave: 'LEAVE',
  };
  const page = (canEdit: boolean): string =>
    renderToStaticMarkup(
      groupInfoPage({
        onClose: vi.fn(),
        error: null,
        sections: groupInfoSections(canEdit, true),
        nodes,
      }),
    );
  const order = (html: string): string[] =>
    [...html.matchAll(/data-section="([a-z]+)"/g)].map((match) => match[1] ?? '');

  it('admin: hero, tabs, name, members, leave; plain member: no name', () => {
    expect(order(page(true))).toEqual(['hero', 'tabs', 'name', 'members', 'leave']);
    expect(order(page(false))).toEqual(['hero', 'tabs', 'members', 'leave']);
    expect(groupInfoSections(true, false)).toEqual(['hero', 'tabs', 'name', 'members']);
  });

  it('is a full-screen page with a back button and safe-area bottom padding, no vh', () => {
    const html = page(true);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('fixed inset-0 z-50');
    expect(html).toContain('bg-bg');
    expect(html).toContain('aria-label="Close group info"');
    expect(html).toContain('>Group info</h2>');
    expect(html).toContain('env(safe-area-inset-bottom)');
    expect(html).not.toMatch(/\d+vh|h-screen/);
  });

  it('has no inline PHOTO section, no second photo Sheet and no hidden file inputs', () => {
    const html = page(true);
    expect(html).not.toContain('data-section="photo"');
    expect(html).not.toContain('Take photo');
    const source = readFileSync(
      fileURLToPath(new URL('../GroupInfoSheet.tsx', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain("from '@/components/ui/Sheet'");
    expect(source).not.toContain('type="file"');
    expect(source).toContain('<PhotoOptionsSheet');
  });

  it('the photo sheet is titled "Group photo"; onFile uploads, onRemove removes', () => {
    const upload = vi.fn();
    const remove = vi.fn();
    const onClose = vi.fn();
    for (const hasPhoto of [true, false]) {
      const sheet = groupPhotoSheetProps({ open: true, onClose, hasPhoto, upload, remove });
      expect(sheet.title).toBe('Group photo');
      expect(sheet.hasPhoto).toBe(hasPhoto);
    }
    const sheet = groupPhotoSheetProps({ open: true, onClose, hasPhoto: true, upload, remove });
    const file = new File(['x'], 'g.png', { type: 'image/png' });
    sheet.onFile(file);
    expect(upload).toHaveBeenCalledWith(file);
    sheet.onRemove();
    expect(remove).toHaveBeenCalledOnce();
  });

  const wiring = (onJump: (id: string) => void): GroupInfoTabsWiring => ({
    channelId: 'ch-1',
    profiles: new Map(),
    currentUserId: 'me',
    timeZone: 'UTC',
    cache: new PresignCache({
      endpoint: null,
      getAccessToken: () => Promise.resolve(null),
      fetcher: () => Promise.reject(new Error('unused')),
    }),
    presignEnabled: false,
    marks: null,
    onJump,
  });

  it('mounts ChatInfoTabs in preview mode keyed by channel; a jump closes first', () => {
    const calls: string[] = [];
    const onClose = () => calls.push('close');
    const el = groupInfoTabs({
      tabs: wiring((id) => calls.push(`jump:${id}`)),
      open: true,
      onClose,
      escape: onClose,
      frame: (tabs) => tabs,
    });
    expect(el.type).toBe(ChatInfoTabs);
    expect(el.key).toBe('ch-1');
    const tabProps = el.props as {
      mode: string;
      open: boolean;
      onJump: (id: string) => void;
      onEscape?: () => void;
    };
    expect(tabProps.mode).toBe('preview');
    expect(tabProps.open).toBe(true);
    expect(tabProps.onEscape).toBe(onClose);
    tabProps.onJump('m9');
    expect(calls).toEqual(['close', 'jump:m9']);
  });

  it('Escape is left to another overlay while one is up', () => {
    const el = groupInfoTabs({
      tabs: wiring(vi.fn()),
      open: true,
      onClose: vi.fn(),
      escape: null,
      frame: (tabs) => tabs,
    });
    expect('onEscape' in (el.props as object)).toBe(false);
  });

  it('Leave group is a 56px outlined row with destructive text, no filled red', () => {
    const row = LeaveGroupRow({ disabled: false, onClick: vi.fn() });
    const className = String(row.props.className);
    expect(className).toContain('min-h-[56px]');
    expect(className).toContain('w-full');
    expect(className).toContain('text-bad');
    expect(className).toContain('border-border');
    expect(className).not.toContain('bg-bad');
    expect({
      admin: groupInfoSections(true, true),
      member: groupInfoSections(false, true),
      leaveRow: className,
    }).toMatchSnapshot();
  });
});
