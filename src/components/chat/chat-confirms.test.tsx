import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// The chat's import graph pulls the real agora-chat browser SDK. Mock it so
// importing the hook-free confirm builders in node never touches browser globals.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { deleteMessagesConfirm, deleteOneConfirm } from '@/components/chat/SelectionBar';
import { deleteConfirmCopy } from '@/lib/chat/delete-flow';

type DialogProps = {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function dialog(el: ReactElement | null): DialogProps {
  expect(el).not.toBeNull();
  expect(el?.type).toBe(ConfirmDialog);
  return el?.props as DialogProps;
}

describe('delete messages confirm', () => {
  it('renders nothing while closed', () => {
    expect(
      deleteMessagesConfirm({
        open: false,
        count: 2,
        busy: false,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    ).toBeNull();
  });

  it('is a destructive ConfirmDialog wired to the delete and cancel handlers', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const props = dialog(
      deleteMessagesConfirm({ open: true, count: 2, busy: false, onCancel, onConfirm }),
    );
    expect(props).toMatchObject({
      title: 'Delete 2 messages?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    props.onConfirm();
    expect(onConfirm).toHaveBeenCalledOnce();
    props.onCancel();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('a selection with files takes the files copy and "Delete for everyone"', () => {
    const copy = deleteConfirmCopy([
      { attachments: [{ assetId: 'a1', name: 'brief.pdf', mime: 'application/pdf' }] },
    ]);
    const props = dialog(
      deleteMessagesConfirm({
        open: true,
        count: 1,
        copy,
        busy: false,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(props).toMatchObject({
      title: 'Delete this message?',
      message:
        "brief.pdf is permanently deleted for privacy. Files shared in chat never go to Recently deleted and can't be restored.",
      confirmLabel: 'Delete for everyone',
      destructive: true,
    });
  });

  it('text-only (null copy) keeps the existing copy', () => {
    const props = dialog(
      deleteMessagesConfirm({
        open: true,
        count: 2,
        copy: deleteConfirmCopy([{ attachments: [] }, { attachments: [] }]),
        busy: false,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(props).toMatchObject({ title: 'Delete 2 messages?', confirmLabel: 'Delete' });
  });
});

describe('delete one message confirm (the action menu Delete)', () => {
  it('renders nothing while closed', () => {
    expect(
      deleteOneConfirm({ open: false, busy: false, onCancel: vi.fn(), onConfirm: vi.fn() }),
    ).toBeNull();
  });

  it('is a destructive "Delete for everyone" dialog that runs on confirm and closes on cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const props = dialog(deleteOneConfirm({ open: true, busy: false, onCancel, onConfirm }));
    expect(props).toMatchObject({
      title: 'Delete message?',
      message: 'It is removed for everyone in this chat.',
      confirmLabel: 'Delete for everyone',
      destructive: true,
      busy: false,
    });
    props.onConfirm();
    expect(onConfirm).toHaveBeenCalledOnce();
    props.onCancel();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
