import type { ComponentType } from 'react';
import {
  IconActivity,
  IconBriefs,
  IconChat,
  IconPipeline,
} from '@/components/ui/icons';

export interface NavItem {
  to: string;
  label: string;
  Icon: ComponentType<{ size?: number; className?: string }>;
}

/**
 * The primary nav. Same four surfaces in the desktop Sidebar and the mobile
 * BottomTabs. Assets is intentionally NOT here; it is reached from the Pipeline
 * and Briefs page heads.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/pipeline', label: 'Pipeline', Icon: IconPipeline },
  { to: '/briefs', label: 'Briefs', Icon: IconBriefs },
  { to: '/chat', label: 'Chat', Icon: IconChat },
  { to: '/activity', label: 'Activity', Icon: IconActivity },
];
