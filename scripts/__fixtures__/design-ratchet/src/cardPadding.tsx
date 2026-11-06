// Design ratchet fixture (cardPadding): not app code, scanned only by design-ratchet.test.ts.
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
      <div className="bg-panel rounded-xl p-4" />
      <div className="bg-panel rounded-lg p-4" />
      <div className="bg-panel rounded-xl px-4 py-3" />
      <div className="bg-panel p-6" />
    </div>
  );
}
