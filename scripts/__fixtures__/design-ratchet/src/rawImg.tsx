// Design ratchet fixture (rawImg): not app code, scanned only by design-ratchet.test.ts.
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
      <img src="a" alt="" />
      <img src="b" alt="" width={10} height={10} />
      <img src="c" alt="" className="h-10 w-10" />
      <img src="d" alt="" width={10} />
    </div>
  );
}
