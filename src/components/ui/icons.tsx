import type { ReactNode } from 'react';

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

function Svg({ className, size = 18, inline = false, box, children }: SvgProps) {
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
    >
      {children}
    </svg>
  );
}

export function IconX(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={8} r={3.4} />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12l5 5L20 6" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={11} cy={11} r={7} />
      <path d="M21 21l-4.3-4.3" />
    </Svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconPipeline(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={3} y={4} width={5} height={16} rx={1} />
      <rect x={10} y={4} width={5} height={10} rx={1} />
      <rect x={17} y={4} width={4} height={13} rx={1} />
    </Svg>
  );
}

export function IconBriefs(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
      <path d="M9 12h6M9 16h4" />
    </Svg>
  );
}

/** A draft: a page with a pencil over its corner. */
export function IconDraft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3H6v18h12v-7" />
      <path d="M9 12h3M9 16h4" />
      <path d="M17.5 4.5l2 2L14 12h-2v-2z" />
    </Svg>
  );
}

/** A plan: two layered sheets. */
export function IconPlan(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Svg>
  );
}

export function IconChat(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 4h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3v-3H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 13l2.5-7h11L20 13" />
      <path d="M4 13h4l1 2h6l1-2h4v5H4z" />
    </Svg>
  );
}

export function IconAssets(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={4} y={5} width={16} height={14} rx={2} />
      <circle cx={9} cy={10} r={1.6} />
      <path d="M5 17l4-4 3 3 3-4 4 5" />
    </Svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h9" />
      <path d="M17 8h3" />
      <circle cx={15} cy={8} r={2} />
      <path d="M4 16h3" />
      <path d="M11 16h9" />
      <circle cx={9} cy={16} r={2} />
    </Svg>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V5h6v2" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </Svg>
  );
}

export function IconSignOut(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h3" />
      <path d="M16 8l4 4-4 4" />
      <path d="M20 12H9" />
    </Svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={12} r={4} />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </Svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14a8 8 0 0 1-10-10 8 8 0 1 0 10 10z" />
    </Svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

export function IconSort(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4v16M7 20l-3-3M7 20l3-3" />
      <path d="M17 20V4M17 4l-3 3M17 4l3 3" />
    </Svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 16V5" />
      <path d="M8 9l4-4 4 4" />
      <path d="M5 19h14" />
    </Svg>
  );
}

export function IconSwitch(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h13l-3-3" />
      <path d="M20 16H7l3 3" />
    </Svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
    </Svg>
  );
}

export function IconFile(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
    </Svg>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </Svg>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 16L16 8" />
      <path d="M9 8h7v7" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v11" />
      <path d="M8 12l4 4 4-4" />
      <path d="M5 19h14" />
    </Svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={9} y={9} width={11} height={11} rx={2} />
      <path d="M5 15V5a1 1 0 0 1 1-1h9" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 6l6 6-6 6" />
    </Svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 6l-6 6 6 6" />
    </Svg>
  );
}

export function IconZoomIn(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={11} cy={11} r={7} />
      <path d="M21 21l-4.3-4.3" />
      <path d="M11 8v6M8 11h6" />
    </Svg>
  );
}

export function IconZoomOut(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={11} cy={11} r={7} />
      <path d="M21 21l-4.3-4.3" />
      <path d="M8 11h6" />
    </Svg>
  );
}

export function IconPin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 7 3 3H7l3-3-1-7z" />
    </Svg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={12} r={8} />
      <path d="M12 8v4l3 2" />
    </Svg>
  );
}

export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={5} r={1.2} />
      <circle cx={12} cy={12} r={1.2} />
      <circle cx={12} cy={19} r={1.2} />
    </Svg>
  );
}

/** Horizontal ⋯, the hover "more actions" control. */
export function IconEllipsis(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={5} cy={12} r={1.2} />
      <circle cx={12} cy={12} r={1.2} />
      <circle cx={19} cy={12} r={1.2} />
    </Svg>
  );
}

export function IconReply(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h11a5 5 0 0 1 5 5v1" />
    </Svg>
  );
}

export function IconForward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 7l5 5-5 5" />
      <path d="M20 12H9a5 5 0 0 0-5 5v1" />
    </Svg>
  );
}

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
  return (
    <Svg {...props}>
      <path d="M21 4L3 11l6 2 2 6 10-15z" />
      <path d="M9 13l4-4" />
    </Svg>
  );
}

export function IconMic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <path d="M12 18v4" />
      <path d="M8 22h8" />
    </Svg>
  );
}

export function IconText(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 7h14M5 12h14M5 17h9" />
    </Svg>
  );
}

export function IconCamera(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
      <circle cx={12} cy={13} r={3.5} />
    </Svg>
  );
}

export function IconImage(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={3} y={5} width={18} height={14} rx={2} />
      <circle cx={8.5} cy={10} r={1.5} />
      <path d="M4 17l5-5 4 4 3-3 4 4" />
    </Svg>
  );
}

export function IconCarousel(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={8} y={8} width={12} height={12} rx={2} />
      <path d="M4 16V6a2 2 0 0 1 2-2h10" />
    </Svg>
  );
}

export function IconVideo(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={3} y={6} width={18} height={12} rx={2} />
      <path d="M10 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPause(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 5v14M15 5v14" />
    </Svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x={4} y={5} width={16} height={16} rx={2} />
      <path d="M4 9h16M8 3v4M16 3v4" />
    </Svg>
  );
}

/** Calendar outline with a small clock at the bottom-right: scheduled sends (never reminders). */
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
  return (
    <Svg {...props}>
      <circle cx={12} cy={12} r={4} />
      <path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12A9 9 0 1 0 16.5 19" />
    </Svg>
  );
}

export function IconListOrdered(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M11 6h10M11 12h10M11 18h10" />
      <path d="M4 5l1.5-1v5" />
      <path d="M3.5 14.5a1.5 1.5 0 0 1 2.8.6c0 1.3-2.6 1.8-2.6 3.4h2.8" />
    </Svg>
  );
}

export function IconQuote(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 8H6a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h3v2a2 2 0 0 1-2 2" />
      <path d="M19 8h-3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h3v2a2 2 0 0 1-2 2" />
    </Svg>
  );
}

export function IconStamp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4a3 3 0 0 1 3 3c0 1.6-1.2 2.2-1.2 3.6V12H10.2v-1.4C10.2 9.2 9 8.6 9 7a3 3 0 0 1 3-3z" />
      <rect x={6} y={12} width={12} height={4} rx={1} />
      <path d="M5 20h14" />
    </Svg>
  );
}

export function IconSignpost(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v16" />
      <path d="M12 7h6l2.5 2.5L18 12h-6z" />
    </Svg>
  );
}

export function IconTarget(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={12} r={8} />
      <circle cx={12} cy={12} r={2} fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconScrollText(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 19V6a2 2 0 0 0-2-2H5" />
      <path d="M9 20h9a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v1a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2" />
      <path d="M9 8h6M9 12h4" />
    </Svg>
  );
}

export function IconScroll(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 19V6a2 2 0 0 0-2-2H5" />
      <path d="M9 20h9a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v1a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2V6a2 2 0 0 0-2-2" />
    </Svg>
  );
}

export function IconFrame(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 8h16M4 16h16M8 4v16M16 4v16" />
    </Svg>
  );
}

export function IconHistory(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </Svg>
  );
}

export function IconRotateCcw(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M3 4.5 6.3 6.4 4.4 9.7" />
    </Svg>
  );
}

export function IconDoorOpen(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 5.5l8-1.5v16l-8-1.5z" />
      <path d="M14 4h3a1 1 0 0 1 1 1v13" />
      <path d="M4 20h16" />
      <circle cx={11.5} cy={12} r={0.7} fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx={12} cy={12} r={3} />
    </Svg>
  );
}

export function IconHourglass(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 4h12M6 20h12" />
      <path d="M8 4v1.5l4 6.5 4-6.5V4" />
      <path d="M8 20v-1.5l4-6.5 4 6.5V20" />
    </Svg>
  );
}

export function IconReceipt(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h12v17l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5z" />
      <path d="M13.6 9.1A2 2 0 0 0 11.8 8c-1.1 0-1.9.6-1.9 1.5 0 2 3.7 1 3.7 3 0 .9-.9 1.5-2 1.5a2 2 0 0 1-1.8-1.1" />
      <path d="M12 6.5v1.5M12 14v1.5" />
    </Svg>
  );
}

export function IconBroadcast(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={12} r={1.6} fill="currentColor" stroke="none" />
      <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M6 6a9 9 0 0 0 0 12M18 6a9 9 0 0 1 0 12" />
    </Svg>
  );
}

export function IconPaperclip(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 11l-7.8 7.8a4 4 0 0 1-5.7-5.7L13.5 6a2.7 2.7 0 0 1 3.8 3.8L9.8 17.3a1.3 1.3 0 0 1-1.9-1.9L15 8.3" />
    </Svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={9} cy={8} r={3.2} />
      <path d="M3 19a6 6 0 0 1 12 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M18 13.5a6 6 0 0 1 3 5.5" />
    </Svg>
  );
}

/** Single message tick (recorded), a fixed 16x12 glyph; `size` is ignored. */
export function IconTickSingle(props: IconProps) {
  return (
    <Svg {...props} box={{ width: 16, height: 12 }}>
      <path d="M2 7l3.5 3.5L14 2" />
    </Svg>
  );
}

/** Double message tick (read), a fixed 20x12 glyph; `size` is ignored. */
export function IconTickDouble(props: IconProps) {
  return (
    <Svg {...props} box={{ width: 20, height: 12 }}>
      <path d="M2 7l3.5 3.5L11 2" />
      <path d="M8 7l3.5 3.5L18 2" />
    </Svg>
  );
}

export function IconSmile(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={12} r={9} />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </Svg>
  );
}

export function IconArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Svg>
  );
}

export function IconAlarmClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx={12} cy={13} r={7} />
      <path d="M12 9.5V13l2.5 1.5M4.5 5.5 7 3.5M19.5 5.5 17 3.5M7 19.5 5.5 21M17 19.5l1.5 1.5" />
    </Svg>
  );
}

const STAR_PATH = 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z';

export function IconStar(props: IconProps) {
  return (
    <Svg {...props}>
      <path d={STAR_PATH} />
    </Svg>
  );
}

export function IconStarFilled(props: IconProps) {
  return (
    <Svg {...props}>
      <path d={STAR_PATH} fill="currentColor" />
    </Svg>
  );
}

/** Select text: an iMessage-style crop, a handle dot at either end. */
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

/** A page with a folded corner and two lines (Save to notes, the notes tile). */
export function IconNotePage(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4M9 12h7M9 16h5" />
    </Svg>
  );
}

/** A bookmark (Mark as, the marks empty states). */
export function IconBookmark(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3h12v18l-6-4-6 4z" />
    </Svg>
  );
}
