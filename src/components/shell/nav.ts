import type { ComponentType } from 'react';
import { IconAssets, IconBriefs, IconChat, IconPipeline, IconPlan } from '@/components/ui/icons';

interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  /** When set, this item shows the chat unread badge (from the chat store). */
  showChatBadge?: boolean;
}

/**
 * The primary nav. This single list is the source for both the desktop Sidebar
 * and the mobile BottomTabs, so every surface stays in sync. Assets is a
 * workspace-global library and lives here alongside the other surfaces.
 * Activity is not in this list: on laptop it is the top bar's button; on phone
 * BottomTabs puts it last in the floating pill and Chat (the badge item) in its
 * own circle to the right.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/pipeline', label: 'Pipeline', Icon: IconPipeline },
  { to: '/briefs', label: 'Briefs', Icon: IconBriefs },
  { to: '/assets', label: 'Assets', Icon: IconAssets },
  { to: '/plan', label: 'Plan', Icon: IconPlan },
  { to: '/chat', label: 'Chat', Icon: IconChat, showChatBadge: true },
];
