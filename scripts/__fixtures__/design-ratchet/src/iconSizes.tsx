// Design ratchet fixture (iconSizes): not app code, scanned only by design-ratchet.test.ts.
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
  return (
    <div>
      <IconX size={ICON_SIZE.inline} />
      <IconX size={ICON_SIZE.alone} />
      <IconX size={ICON_SIZE.inline} />
      <IconPlus size={16} />
      <IconStar size={ICON_SIZE.inline} />
    </div>
  );
}
