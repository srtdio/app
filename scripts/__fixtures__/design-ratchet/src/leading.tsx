// Design ratchet fixture (leading): not app code, scanned only by design-ratchet.test.ts.
declare const Button: (props: Record<string, unknown>) => null;
declare const IconButton: (props: Record<string, unknown>) => null;
declare const IconX: (props: Record<string, unknown>) => null;
declare const IconChevronLeft: (props: Record<string, unknown>) => null;
declare const IconPlus: (props: Record<string, unknown>) => null;
declare const IconCheck: (props: Record<string, unknown>) => null;
declare const IconStar: (props: Record<string, unknown>) => null;
declare const ICON_SIZE: Record<string, number>;
declare const f: () => void;
declare const items: Array<{ id: string }>;

export function Fixture() {
  return <p className="leading-5 leading-tight md:leading-[22px]" />;
}
