import type { ComponentType } from 'react';
import {
  IconActivity,
  IconAssets,
  IconBriefs,
  IconChat,
  IconPipeline,
} from '@/components/ui/icons';

export interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
  /** When set, this item shows the chat unread badge (from the chat store). */
  showChatBadge?: boolean;
  /** When set, this item shows the inbox unread badge (from the inbox store). */
  showActivityBadge?: boolean;
}

/**
 * The primary nav. This single list is the source for both the desktop Sidebar
 * and the mobile BottomTabs, so every surface stays in sync. Assets is a
 * workspace-global library and lives here alongside the other surfaces.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/pipeline', label: 'Pipeline', Icon: IconPipeline },
  { to: '/briefs', label: 'Briefs', Icon: IconBriefs },
  { to: '/assets', label: 'Assets', Icon: IconAssets },
  { to: '/chat', label: 'Chat', Icon: IconChat, showChatBadge: true },
  { to: '/activity', label: 'Activity', Icon: IconActivity, showActivityBadge: true },
];
