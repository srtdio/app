// Design ratchet fixture (keyIndex): not app code, scanned only by design-ratchet.test.ts.
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
      {items.map((item, i) => (
        <span key={i}>{item.id}</span>
      ))}
      {items.map((item, index) => (
        <span key={index}>{item.id}</span>
      ))}
      {items.map((item, idx) => (
        <span key={idx}>{item.id}</span>
      ))}
      {items.map((item) => (
        <span key={item.id}>{item.id}</span>
      ))}
    </div>
  );
}
