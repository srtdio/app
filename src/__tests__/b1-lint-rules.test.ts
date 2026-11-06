import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// B1 lint guards (eslint.config.js): one fixture per rule, linted as if it
// lived at the given path. A rule with zero hits in src/** is an error; the
// rest warn and scripts/design-ratchet.ts blocks new ones.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

async function messages(filePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => ({ id: m.ruleId, sev: m.severity, text: m.message }));
}

const PAGE = 'src/components/pages/B1Fixture.tsx';
const CHAT = 'src/components/chat/B1Fixture.tsx';

describe('B1 lint: type roles', () => {
  it('leading-*, tracking-* and text-[..] error outside ui/Text.tsx', async () => {
    const m = await messages(
      PAGE,
      'export const A = () => <span className="leading-5 tracking-wide text-[color:var(--x)]" />;\n',
    );
    expect(m.filter((x) => x.text.includes('text role')).length).toBeGreaterThan(0);
    expect(m.every((x) => !x.text.includes('text role') || x.sev === 2)).toBe(true);
  });
});

describe('B1 lint: IconMore only in ActionMenu', () => {
  it('errors at a call site', async () => {
    const m = await messages(
      PAGE,
      "import { IconMore } from '@/components/ui/icons';\nexport const A = () => <IconMore />;\n",
    );
    expect(m.some((x) => x.text.includes('ActionMenuTrigger') && x.sev === 2)).toBe(true);
  });
});

describe('B1 lint: no hand-placed IconButton', () => {
  it('absolute or negative margin warns', async () => {
    const m = await messages(
      PAGE,
      'import { IconButton } from \'@/components/ui/IconButton\';\nexport const A = () => <IconButton label="x" className="absolute -mr-3" />;\n',
    );
    expect(m.some((x) => x.text.includes('trailing rule'))).toBe(true);
  });
});

describe('B1 lint: raw elements', () => {
  it('<input>, <textarea>, <select>, <h2> and <div onClick> warn outside ui/', async () => {
    const m = await messages(
      PAGE,
      'export const A = (p: { f: () => void }) => (\n  <div onClick={p.f}>\n    <input />\n    <textarea />\n    <select />\n    <h2>t</h2>\n  </div>\n);\n',
    );
    expect(m.filter((x) => x.text.includes('ui/Input')).length).toBe(4);
    expect(m.some((x) => x.text.includes('<div onClick>'))).toBe(true);
  });
  it('raw <button> stays an error', async () => {
    const m = await messages(PAGE, 'export const A = () => <button type="button" />;\n');
    expect(m.some((x) => x.text.includes('Use Button') && x.sev === 2)).toBe(true);
  });
});

describe('B1 lint: ChatCard is the bubble', () => {
  it('a rounded + bg wrapper around ChatCard errors in chat/', async () => {
    const m = await messages(
      CHAT,
      'import { ChatCard } from \'@/components/ui/ChatCard\';\nimport { IconBriefs } from \'@/components/ui/icons\';\nexport const A = () => (\n  <div className="rounded-xl bg-panel">\n    <ChatCard icon={IconBriefs} title="x" />\n  </div>\n);\n',
    );
    expect(m.some((x) => x.text.includes('ChatCard is the bubble') && x.sev === 2)).toBe(true);
  });
});
