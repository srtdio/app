// Design ratchet fixture (handTap): not app code, scanned only by design-ratchet.test.ts.
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
      <div onClick={f} className="h-8" />
      <span role="button" className="h-[30px]" />
      <Button onClick={f} className="h-8" />
      <div onClick={f} className="h-11" />
      <IconButton label="Pick">
        <span className="h-6 w-6" />
      </IconButton>
      <IconButton label="Big">
        <span className="h-11 w-11" />
      </IconButton>
    </div>
  );
}
