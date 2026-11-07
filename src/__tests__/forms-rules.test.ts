import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Forms rule: a submit button is never disabled for "not valid yet". Tapping it
// shows the field's line (ui/ErrorNote) and focuses the first bad field (the
// CreatePostSheet focusErrorField pattern). The only hold is busy: ui/Button's
// `busy` prop (disabled + aria-busy, label kept, spinner beside it).
//
// Static scan of src/components/**/*.tsx (test files skipped): every <Button
// opening tag whose disabled={...} expression negates a validity flag (!valid,
// !canSubmit, !canSave, !isValid, !formValid, !canSend, !canCreate) is an
// offender. busy-only disabled (disabled={busy}, busy={saving}) passes, and so
// does a choice not made yet (disabled={slotAt === null}).
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));

/**
 * Known cases, as "file: most offenders allowed". It only shrinks: fix a site,
 * then lower or drop its entry.
 *
 * Legit, not a form submit: a composer's Send with nothing typed has nothing
 * to send (the chat and comment send convention).
 *
 * Debt outside the forms-and-drafts pass (each still needs the tap-says-why
 * treatment): the schedule and reminder time pickers, the plan rename row,
 * the concept sheet, the username field and New post's footer.
 */
const ALLOWED: Readonly<Record<string, number>> = {
  // Legit: composer Send.
  'comments/CommentComposer.tsx': 1,
  'comments/SlotComposer.tsx': 1,
  'chat/Composer.tsx': 1,
  // Debt.
  // The schedule and reminder time pickers' one shared frame.
  'chat/WhenOptions.tsx': 1,
  'chat/PlanScreen.tsx': 1,
  'chat/ConceptSheet.tsx': 1,
  'settings/UsernameField.tsx': 1,
  'pages/CreatePostSheet.tsx': 3,
};

/** A negated validity flag inside a disabled expression. */
export const NOT_VALID_YET =
  /!\s*\(?\s*(?:valid|canSubmit|canSave|isValid|formValid|canSend|canCreate)\b/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

const FILES: { rel: string; src: string }[] = tsxFiles(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join('/') }))
  .filter(({ rel }) => !/\.test\.tsx$/.test(rel))
  .map(({ path, rel }) => ({ rel, src: readFileSync(path, 'utf8') }));

/** The JSX opening tag starting at `start`, up to its closing `>` outside any `{...}`. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** The balanced `{...}` body after `disabled=` in a tag, or null when there is none. */
export function disabledExpression(tag: string): string | null {
  const at = tag.search(/\bdisabled=\{/);
  if (at < 0) return null;
  const open = tag.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < tag.length; i += 1) {
    if (tag[i] === '{') depth += 1;
    else if (tag[i] === '}') {
      depth -= 1;
      if (depth === 0) return tag.slice(open + 1, i);
    }
  }
  return tag.slice(open + 1);
}

/** "file:line" for each <Button disabled for "not valid yet" in one source. */
export function notValidYetButtons(rel: string, src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<Button\b/g)) {
    const expr = disabledExpression(openingTag(src, m.index));
    if (expr === null || !NOT_VALID_YET.test(expr)) continue;
    out.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
  }
  return out;
}

describe('forms: submit buttons are never disabled for "not valid yet"', () => {
  it('the scan finds the patterns it is meant to find', () => {
    expect(notValidYetButtons('x.tsx', '<Button disabled={!valid}>Save</Button>')).toEqual([
      'x.tsx:1',
    ]);
    expect(notValidYetButtons('x.tsx', '<Button\n  disabled={busy || !valid}\n>')).toEqual([
      'x.tsx:1',
    ]);
    expect(notValidYetButtons('x.tsx', '<Button disabled={!canSubmit} onClick={go}>')).toEqual([
      'x.tsx:1',
    ]);
    expect(notValidYetButtons('x.tsx', '<Button disabled={!(canSave)}>')).toEqual(['x.tsx:1']);
  });

  it('busy-only and a choice not made yet pass', () => {
    expect(notValidYetButtons('x.tsx', '<Button disabled={busy}>Save</Button>')).toEqual([]);
    expect(notValidYetButtons('x.tsx', '<Button busy={saving}>Save</Button>')).toEqual([]);
    expect(notValidYetButtons('x.tsx', '<Button disabled={slotAt === null}>Book</Button>')).toEqual(
      [],
    );
    expect(notValidYetButtons('x.tsx', '<Button onClick={() => go(!valid)}>Go</Button>')).toEqual(
      [],
    );
  });

  it('no <Button in src/components is disabled for "not valid yet" outside the allowlist', () => {
    const over: string[] = [];
    for (const { rel, src } of FILES) {
      const found = notValidYetButtons(rel, src);
      if (found.length > (ALLOWED[rel] ?? 0)) over.push(...found);
    }
    expect(over).toEqual([]);
  });

  it('the forms fixed in this pass stay fixed', () => {
    const fixed = [
      'auth/SignInPage.tsx',
      'auth/SignUpPage.tsx',
      'onboarding/OnboardingFlow.tsx',
      'pages/assets/AddLinkSheet.tsx',
      'pages/assets/AssetRenameSheet.tsx',
      'pages/CreateBriefSheet.tsx',
      'settings/ProfileSettingsPanel.tsx',
    ];
    for (const rel of fixed) {
      expect(ALLOWED[rel]).toBeUndefined();
      const file = FILES.find((f) => f.rel === rel);
      expect(file, rel).toBeDefined();
      expect(notValidYetButtons(rel, file!.src)).toEqual([]);
    }
  });

  it('busy keeps the label: no "Saving" / "Sending" / "Adding" label swap at the fixed sites', () => {
    const swaps: Record<string, RegExp> = {
      'auth/SignInPage.tsx': /sendingCode/,
      'auth/SignUpPage.tsx': /sendingCode/,
      'pages/assets/AddLinkSheet.tsx': /'Adding'/,
      'pages/assets/AssetRenameSheet.tsx': /'Saving'/,
      'settings/ProfileSettingsPanel.tsx': /'Saving\.\.\.'/,
      'onboarding/OnboardingFlow.tsx': /\?\s*'(?:Saving|Sending)'/,
    };
    for (const [rel, swap] of Object.entries(swaps)) {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, rel).toBeDefined();
      expect(swap.test(file!.src), rel).toBe(false);
    }
  });

  it('email inputs on the sign-in, sign-up and onboarding forms skip spellcheck and capitals', () => {
    for (const rel of [
      'auth/SignInPage.tsx',
      'auth/SignUpPage.tsx',
      'onboarding/OnboardingFlow.tsx',
    ]) {
      const src = FILES.find((f) => f.rel === rel)!.src;
      for (const m of src.matchAll(/<Input\b/g)) {
        const tag = openingTag(src, m.index);
        if (!/type="email"/.test(tag)) continue;
        expect(tag, rel).toContain('spellCheck={false}');
        expect(tag, rel).toContain('autoCapitalize="none"');
        expect(tag, rel).toMatch(/\bname="/);
      }
    }
  });
});
