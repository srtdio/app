// Design ratchet fixture (dotSizes): not app code, scanned only by design-ratchet.test.ts.
export declare const Button: (props: Record<string, unknown>) => null;
export declare const IconButton: (props: Record<string, unknown>) => null;
export declare const IconX: (props: Record<string, unknown>) => null;
export declare const IconChevronLeft: (props: Record<string, unknown>) => null;
export declare const IconPlus: (props: Record<string, unknown>) => null;
export declare const IconCheck: (props: Record<string, unknown>) => null;
export declare const IconStar: (props: Record<string, unknown>) => null;
export declare const ICON_SIZE: Record<string, number>;
export declare const f: () => void;
export declare const items: Array<{ id: string }>;

export function Fixture() {
  return (
    <div>
      <span className="rounded-full h-2 w-2" />
      <span className="rounded-full h-2 w-2" />
      <span className="rounded-full size-1.5" />
      <span className="rounded-full h-6 w-6" />
      <span className="rounded-full px-2 h-2 w-2" />
    </div>
  );
}
