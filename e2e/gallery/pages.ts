import type { GalleryModule } from './frame';

// /gallery/<Part> -> its page module, loaded on demand so each gallery screen
// pulls only its own part (the screen-to-files map stays per part).
export const PAGES: Readonly<Record<string, () => Promise<GalleryModule>>> = {
  Text: () => import('./Text'),
  Button: () => import('./Button'),
  IconButton: () => import('./IconButton'),
  Chip: () => import('./Chip'),
  Tag: () => import('./Tag'),
  CountBadge: () => import('./CountBadge'),
  Avatar: () => import('./Avatar'),
  ListCard: () => import('./ListCard'),
  HeaderBar: () => import('./HeaderBar'),
  Toolbar: () => import('./Toolbar'),
  LoadMore: () => import('./LoadMore'),
  Input: () => import('./Input'),
};
