import type { CSSProperties, ReactNode } from 'react';
import {
  AdjustmentsHorizontalIcon,
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowRightStartOnRectangleIcon,
  ArrowUpIcon,
  ArrowUpRightIcon,
  ArrowUpTrayIcon,
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  ArrowsRightLeftIcon,
  ArrowsUpDownIcon,
  AtSymbolIcon,
  Bars3Icon,
  Bars3BottomLeftIcon,
  BellAlertIcon,
  BookmarkIcon,
  CalendarIcon,
  CalendarDaysIcon,
  CameraIcon,
  ChatBubbleOvalLeftIcon,
  CheckCircleIcon,
  CheckIcon,
  CheckBadgeIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  DocumentIcon,
  DocumentDuplicateIcon,
  DocumentTextIcon,
  EllipsisVerticalIcon,
  ExclamationTriangleIcon,
  EyeIcon,
  EyeSlashIcon,
  FaceSmileIcon,
  FilmIcon,
  InboxIcon,
  InboxStackIcon,
  InformationCircleIcon,
  LinkIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  MicrophoneIcon,
  MoonIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  PaperClipIcon,
  PauseIcon,
  PencilIcon,
  PencilSquareIcon,
  PhotoIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  RectangleStackIcon,
  ScaleIcon,
  StarIcon,
  SunIcon,
  TrashIcon,
  UserIcon,
  ViewColumnsIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  PauseIcon as PauseSolid,
  PlayIcon as PlaySolid,
  StarIcon as StarSolid,
} from '@heroicons/react/24/solid';

/**
 * The one icon size scale. 16 beside text or in a chip, 18 sidebar (the
 * default), 20 alone in a 44 button or the tab bar, 22 tray tiles, composer
 * and long-press menu, 28 status glyphs (empty states, file tiles).
 */
export const ICON_SIZE = { inline: 16, nav: 18, control: 20, tray: 22, status: 28 } as const;

export interface IconProps {
  className?: string;
  size?: number;
  /**
   * Render the icon inline with surrounding text instead of as a block.
   * Tailwind preflight sets `svg { display: block }`, which drops an icon
   * placed inside running text onto its own line. Opt in with `inline` so an
   * in-text icon (e.g. a title edit pencil) sits beside the last word.
   * Defaults to false; all existing call sites keep their block layout.
   */
  inline?: boolean;
}

interface SvgProps extends IconProps {
  children: ReactNode;
  /** Non-square glyphs (the message ticks): the box in viewBox units. Defaults to 24x24. */
  box?: { width: number; height: number };
}

/** Hand-drawn glyphs, kept only where Heroicons has no equivalent. */
function Svg({ className, size = ICON_SIZE.nav, inline = false, box, children }: SvgProps) {
  return (
    <svg
      className={className}
      style={inline ? { display: 'inline-block', verticalAlign: '-0.15em' } : undefined}
      width={box !== undefined ? box.width : size}
      height={box !== undefined ? box.height : size}
      viewBox={box !== undefined ? `0 0 ${box.width} ${box.height}` : '0 0 24 24'}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type HeroIcon = typeof ViewColumnsIcon;

/**
 * A Heroicons glyph on the same contract as Svg: size (default 18), decorative,
 * and the same inline layout. 24/outline gets stroke 1.7 over Heroicons' own
 * 1.5; `solid` (24/solid, filled states only) has no stroke.
 */
function Hero({
  icon: C,
  solid = false,
  className,
  size = ICON_SIZE.nav,
  inline = false,
}: IconProps & { icon: HeroIcon; solid?: boolean }) {
  const style: CSSProperties = inline
    ? { width: size, height: size, display: 'inline-block', verticalAlign: '-0.15em' }
    : { width: size, height: size };
  return (
    <C
      width={size}
      height={size}
      style={style}
      strokeWidth={solid ? undefined : 1.7}
      className={className}
      aria-hidden="true"
    />
  );
}

export function IconX(props: IconProps) {
  return <Hero icon={XMarkIcon} {...props} />;
}

export function IconUser(props: IconProps) {
  return <Hero icon={UserIcon} {...props} />;
}

export function IconCheck(props: IconProps) {
  return <Hero icon={CheckIcon} {...props} />;
}

/** Select mode (chat list): a tick in a circle. Tasks keep IconTaskSquare. */
export function IconCheckCircle(props: IconProps) {
  return <Hero icon={CheckCircleIcon} {...props} />;
}

export function IconSearch(props: IconProps) {
  return <Hero icon={MagnifyingGlassIcon} {...props} />;
}

export function IconPlus(props: IconProps) {
  return <Hero icon={PlusIcon} {...props} />;
}

export function IconPipeline(props: IconProps) {
  return <Hero icon={ViewColumnsIcon} {...props} />;
}

export function IconBriefs(props: IconProps) {
  return <Hero icon={DocumentTextIcon} {...props} />;
}

export function IconDraft(props: IconProps) {
  return <Hero icon={PencilSquareIcon} {...props} />;
}

export function IconPlan(props: IconProps) {
  return <Hero icon={CalendarDaysIcon} {...props} />;
}

export function IconChat(props: IconProps) {
  return <Hero icon={ChatBubbleOvalLeftIcon} {...props} />;
}

export function IconNotifications(props: IconProps) {
  return <Hero icon={InboxStackIcon} {...props} />;
}

export function IconActivity(props: IconProps) {
  return <Hero icon={InboxIcon} {...props} />;
}

export function IconAssets(props: IconProps) {
  return <Hero icon={PhotoIcon} {...props} />;
}

export function IconSettings(props: IconProps) {
  return <Hero icon={Cog6ToothIcon} {...props} />;
}

export function IconTrash(props: IconProps) {
  return <Hero icon={TrashIcon} {...props} />;
}

export function IconEdit(props: IconProps) {
  return <Hero icon={PencilIcon} {...props} />;
}

export function IconSignOut(props: IconProps) {
  return <Hero icon={ArrowRightStartOnRectangleIcon} {...props} />;
}

export function IconSun(props: IconProps) {
  return <Hero icon={SunIcon} {...props} />;
}

export function IconMoon(props: IconProps) {
  return <Hero icon={MoonIcon} {...props} />;
}

export function IconChevronDown(props: IconProps) {
  return <Hero icon={ChevronDownIcon} {...props} />;
}

export function IconSort(props: IconProps) {
  return <Hero icon={ArrowsUpDownIcon} {...props} />;
}

export function IconFilterLines(props: IconProps) {
  return <Hero icon={AdjustmentsHorizontalIcon} {...props} />;
}

export function IconUpload(props: IconProps) {
  return <Hero icon={ArrowUpTrayIcon} {...props} />;
}

export function IconSwitch(props: IconProps) {
  return <Hero icon={ArrowsRightLeftIcon} {...props} />;
}

export function IconFile(props: IconProps) {
  return <Hero icon={DocumentIcon} {...props} />;
}

export function IconLink(props: IconProps) {
  return <Hero icon={LinkIcon} {...props} />;
}

export function IconArrowUpRight(props: IconProps) {
  return <Hero icon={ArrowUpRightIcon} {...props} />;
}

export function IconDownload(props: IconProps) {
  return <Hero icon={ArrowDownTrayIcon} {...props} />;
}

export function IconCopy(props: IconProps) {
  return <Hero icon={DocumentDuplicateIcon} {...props} />;
}

export function IconChevronRight(props: IconProps) {
  return <Hero icon={ChevronRightIcon} {...props} />;
}

export function IconChevronLeft(props: IconProps) {
  return <Hero icon={ChevronLeftIcon} {...props} />;
}

/** A pushpin (pin a version or message). Hand-drawn: Heroicons has no pushpin; MapPinIcon means a place. */
export function IconPin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 7 3 3H7l3-3-1-7z" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return <Hero icon={ClockIcon} {...props} />;
}

export function IconMore(props: IconProps) {
  return <Hero icon={EllipsisVerticalIcon} {...props} />;
}

export function IconReply(props: IconProps) {
  return <Hero icon={ArrowUturnLeftIcon} {...props} />;
}

export function IconForward(props: IconProps) {
  return <Hero icon={ArrowUturnRightIcon} {...props} />;
}

/** Add an image: a photo with a plus. Hand-drawn: Heroicons has no photo-plus. */
export function IconImagePlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
      <circle cx={8.5} cy={9} r={1.4} />
      <path d="M4 16l4-4 3.5 3.5" />
      <path d="M18 15v6M15 18h6" />
    </Svg>
  );
}

export function IconSend(props: IconProps) {
  return <Hero icon={PaperAirplaneIcon} {...props} />;
}

export function IconMic(props: IconProps) {
  return <Hero icon={MicrophoneIcon} {...props} />;
}

export function IconText(props: IconProps) {
  return <Hero icon={Bars3BottomLeftIcon} {...props} />;
}

export function IconCamera(props: IconProps) {
  return <Hero icon={CameraIcon} {...props} />;
}

export function IconImage(props: IconProps) {
  return <Hero icon={PhotoIcon} {...props} />;
}

/** A carousel badge: stacked cards. Hand-drawn: Square2StackIcon reads as copy at badge size. */
export function IconCarousel(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={8} y={8} width={12} height={12} rx={2} />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </Svg>
  );
}

export function IconVideo(props: IconProps) {
  return <Hero icon={FilmIcon} {...props} />;
}

export function IconPlay(props: IconProps) {
  return <Hero icon={PlaySolid} solid {...props} />;
}

export function IconPause(props: IconProps) {
  return <Hero icon={PauseIcon} {...props} />;
}

export function IconPauseFill(props: IconProps) {
  return <Hero icon={PauseSolid} solid {...props} />;
}

export function IconCalendar(props: IconProps) {
  return <Hero icon={CalendarIcon} {...props} />;
}

/** Calendar outline with a small clock at the bottom-right: scheduled sends (never reminders). Hand-drawn: Heroicons has no calendar-clock. */
export function IconCalendarClock(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 10.5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4.5" />
      <path d="M4 9h16M8 3v4M16 3v4" />
      <circle cx={17} cy={17} r={4.5} />
      <path d="M17 15v2l1.4 1" />
    </Svg>
  );
}

export function IconAt(props: IconProps) {
  return <Hero icon={AtSymbolIcon} {...props} />;
}

export function IconSignpost(props: IconProps) {
  return <Hero icon={ScaleIcon} {...props} />;
}

export function IconTarget(props: IconProps) {
  return <Hero icon={CheckBadgeIcon} {...props} />;
}

export function IconScrollText(props: IconProps) {
  return <Hero icon={QuestionMarkCircleIcon} {...props} />;
}

export function IconHistory(props: IconProps) {
  return <Hero icon={RectangleStackIcon} {...props} />;
}

export function IconRotateCcw(props: IconProps) {
  return <Hero icon={ArrowPathIcon} {...props} />;
}

export function IconEye(props: IconProps) {
  return <Hero icon={EyeIcon} {...props} />;
}

/** Pending (status drawer). Hand-drawn: Heroicons has no hourglass, and ClockIcon is IconClock. */
export function IconHourglass(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4h12M6 20h12" />
      <path d="M8 4v1.5l4 6.5 4-6.5V4" />
      <path d="M8 20v-1.5l4-6.5 4 6.5V20" />
    </Svg>
  );
}

export function IconPaperclip(props: IconProps) {
  return <Hero icon={PaperClipIcon} {...props} />;
}

export function IconLock(props: IconProps) {
  return <Hero icon={LockClosedIcon} {...props} />;
}

/** Single message tick (recorded), a fixed 16x12 glyph; `size` is ignored. Hand-drawn: Heroicons has no message ticks. */
export function IconTickSingle(props: IconProps) {
  return (
    <Svg {...props} box={{ width: 16, height: 12 }}>
      <path d="M2 7l3.5 3.5L14 2" />
    </Svg>
  );
}

/** Double message tick (read), a fixed 20x12 glyph; `size` is ignored. Hand-drawn: Heroicons has no message ticks. */
export function IconTickDouble(props: IconProps) {
  return (
    <Svg {...props} box={{ width: 20, height: 12 }}>
      <path d="M2 7l3.5 3.5L11 2" />
      <path d="M8 7l3.5 3.5L18 2" />
    </Svg>
  );
}

export function IconSmile(props: IconProps) {
  return <Hero icon={FaceSmileIcon} {...props} />;
}

export function IconArrowUp(props: IconProps) {
  return <Hero icon={ArrowUpIcon} {...props} />;
}

export function IconAlarmClock(props: IconProps) {
  return <Hero icon={BellAlertIcon} {...props} />;
}

/** The chat task list: a rounded square with a tick. Hand-drawn: Heroicons has no checkbox-square. */
export function IconTaskSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={4} y={4} width={16} height={16} rx={4} />
      <path d="M8.3 12.2l2.6 2.6 4.8-5.3" />
    </Svg>
  );
}

export function IconStar(props: IconProps) {
  return <Hero icon={StarIcon} {...props} />;
}

export function IconStarFilled(props: IconProps) {
  return <Hero icon={StarSolid} solid {...props} />;
}

/** Select text: an iMessage-style crop, a handle dot at either end. Hand-drawn: Heroicons has no text-selection glyph. */
export function IconSelectText(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="4.5" r="1.3" fill="currentColor" />
      <path d="M6 6.5V16a1 1 0 0 0 1 1h10.5" />
      <path d="M3 7h13a1 1 0 0 1 1 1v10.5" />
      <circle cx="17" cy="20" r="1.3" fill="currentColor" />
    </Svg>
  );
}

export function IconBookmark(props: IconProps) {
  return <Hero icon={BookmarkIcon} {...props} />;
}

/** Six dots: the Plan list's drag handle (laptop). Hand-drawn: Heroicons has no grip. */
export function IconGrip(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={9} cy={6} r={1} />
      <circle cx={15} cy={6} r={1} />
      <circle cx={9} cy={12} r={1} />
      <circle cx={15} cy={12} r={1} />
      <circle cx={9} cy={18} r={1} />
      <circle cx={15} cy={18} r={1} />
    </Svg>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return <Hero icon={ExclamationTriangleIcon} {...props} />;
}

export function IconInfo(props: IconProps) {
  return <Hero icon={InformationCircleIcon} {...props} />;
}

export function IconEyeOff(props: IconProps) {
  return <Hero icon={EyeSlashIcon} {...props} />;
}

export function IconBan(props: IconProps) {
  return <Hero icon={NoSymbolIcon} {...props} />;
}

export function IconMenu(props: IconProps) {
  return <Hero icon={Bars3Icon} {...props} />;
}
