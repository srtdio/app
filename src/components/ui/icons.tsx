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
}

function Svg({ className, size = 18, inline = false, children }: SvgProps) {
  return (
    <svg
      className={className}
      style={inline ? { display: 'inline-block', verticalAlign: '-0.15em' } : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
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
