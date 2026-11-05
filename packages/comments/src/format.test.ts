import { describe, expect, it } from 'vitest';
import {
  closingMarkerTail,
  parseFormat,
  parseFormatRuns,
  stripFormat,
  toggleFormat,
  type FormatSegment,
} from './format';

const seg = (text: string, ...styles: FormatSegment['styles'][number][]): FormatSegment => ({
  text,
  styles,
});
const UUID = '0b7c8a1e-1234-4abc-8def-0123456789ab';

describe('parseFormat: the five styles', () => {
  it('bold, italic, strike, underline, mono', () => {
    expect(parseFormat('*a*')).toEqual([seg('a', 'bold')]);
    expect(parseFormat('_a_')).toEqual([seg('a', 'italic')]);
    expect(parseFormat('~a~')).toEqual([seg('a', 'strike')]);
    expect(parseFormat('+a+')).toEqual([seg('a', 'underline')]);
    expect(parseFormat('```a```')).toEqual([seg('a', 'mono')]);
  });

  it('styles words inside a sentence', () => {
    expect(parseFormat('ship *today* please')).toEqual([
      seg('ship '),
      seg('today', 'bold'),
      seg(' please'),
    ]);
  });

  it('multi-word spans', () => {
    expect(parseFormat('_two words_')).toEqual([seg('two words', 'italic')]);
  });

  it('opens after punctuation and closes before punctuation', () => {
    expect(parseFormat('(*a*).')).toEqual([seg('('), seg('a', 'bold'), seg(').')]);
  });
});

describe('parseFormat: never mid-word', () => {
  it.each(['snake_case_name', 'file_name_v2.pdf', '2*3*4', 'a+b+c', 'C++ rocks', 'x~y~z'])(
    '%s stays plain',
    (body) => {
      expect(parseFormat(body)).toEqual([seg(body)]);
    },
  );
});

describe('parseFormat: literal cases', () => {
  it('unclosed markers stay literal', () => {
    expect(parseFormat('*open only')).toEqual([seg('*open only')]);
    expect(parseFormat('close only*')).toEqual([seg('close only*')]);
  });

  it('empty markers stay literal', () => {
    expect(parseFormat('**')).toEqual([seg('**')]);
    expect(parseFormat('* *')).toEqual([seg('* *')]);
    expect(parseFormat('``````')).toEqual([seg('``````')]);
  });

  it('a space after the opener or before the closer keeps it literal', () => {
    expect(parseFormat('* a*')).toEqual([seg('* a*')]);
    expect(parseFormat('*a *')).toEqual([seg('*a *')]);
  });

  it('no style crosses a newline', () => {
    expect(parseFormat('*a\nb*')).toEqual([seg('*a\nb*')]);
    expect(parseFormat('*a*\n_b_')).toEqual([seg('a', 'bold'), seg('\n'), seg('b', 'italic')]);
  });
});

describe('parseFormat: nesting', () => {
  it('*_both_* is bold and italic', () => {
    expect(parseFormat('*_both_*')).toEqual([seg('both', 'bold', 'italic')]);
  });

  it('partial nesting', () => {
    expect(parseFormat('*a _b_ c*')).toEqual([
      seg('a ', 'bold'),
      seg('b', 'bold', 'italic'),
      seg(' c', 'bold'),
    ]);
  });

  it('crossing markers: the inner unclosed one stays literal', () => {
    expect(parseFormat('*a _b* c_')).toEqual([seg('a _b', 'bold'), seg(' c_')]);
  });
});

describe('parseFormat: mono is literal inside', () => {
  it('no nested styles inside mono', () => {
    expect(parseFormat('```*not bold*```')).toEqual([seg('*not bold*', 'mono')]);
  });

  it('a mention token inside mono stays raw text', () => {
    expect(parseFormat(`\`\`\`@[${UUID}]\`\`\``)).toEqual([seg(`@[${UUID}]`, 'mono')]);
  });

  it('a link inside mono stays part of the mono text', () => {
    expect(parseFormat('```https://x.com/a_b_c```')).toEqual([seg('https://x.com/a_b_c', 'mono')]);
  });

  it('mono inside bold', () => {
    expect(parseFormat('*see ```code```*')).toEqual([
      seg('see ', 'bold'),
      seg('code', 'bold', 'mono'),
    ]);
  });
});

describe('parseFormat: protected spans', () => {
  it('urls with underscores stay plain', () => {
    const body = 'see https://x.com/a_b_c_d and https://y.com/*x*';
    expect(parseFormat(body)).toEqual([seg(body)]);
  });

  it('a marker can not close inside a url', () => {
    expect(parseFormat('_go https://x.com/a_b')).toEqual([seg('_go https://x.com/a_b')]);
  });

  it('a styled span may contain a link: bold link', () => {
    expect(parseFormat('*see https://x.com*')).toEqual([seg('see https://x.com', 'bold')]);
  });

  it('a closing marker after a url with trailing punctuation', () => {
    expect(parseFormat('*see https://x.com*.')).toEqual([seg('see https://x.com', 'bold'), seg('.')]);
  });

  it('mentions inside a style', () => {
    expect(parseFormat(`*hey @[${UUID}]*`)).toEqual([seg(`hey @[${UUID}]`, 'bold')]);
    expect(parseFormat('_ping @[all]_')).toEqual([seg('ping @[all]', 'italic')]);
  });

  it('a marker can not open or close inside a mention token', () => {
    expect(parseFormat('@[all]_x')).toEqual([seg('@[all]_x')]);
  });
});

describe('parseFormat: scripts', () => {
  it('Hindi / Devanagari', () => {
    expect(parseFormat('*नमस्ते* दोस्त')).toEqual([seg('नमस्ते', 'bold'), seg(' दोस्त')]);
    expect(parseFormat('_कल मिलते हैं_')).toEqual([seg('कल मिलते हैं', 'italic')]);
  });

  it('Hinglish mixed text', () => {
    expect(parseFormat('aaj *post* karna hai')).toEqual([
      seg('aaj '),
      seg('post', 'bold'),
      seg(' karna hai'),
    ]);
  });

  it('emoji', () => {
    expect(parseFormat('*🎉 done 🎉*')).toEqual([seg('🎉 done 🎉', 'bold')]);
    expect(parseFormat('🔥*hot*')).toEqual([seg('🔥'), seg('hot', 'bold')]);
  });
});

describe('parseFormatRuns', () => {
  it('joins back to the raw text exactly', () => {
    const body = '*a* _b_ ~c~ +d+ ```e``` snake_case https://x.com/_y_ @[all]\n*z*';
    expect(
      parseFormatRuns(body)
        .map((r) => r.text)
        .join(''),
    ).toBe(body);
  });

  it('flags markers and carries the outer styles on them', () => {
    expect(parseFormatRuns('*_a_*')).toEqual([
      { kind: 'marker', text: '*', styles: [] },
      { kind: 'marker', text: '_', styles: ['bold'] },
      { kind: 'text', text: 'a', styles: ['bold', 'italic'] },
      { kind: 'marker', text: '_', styles: ['bold'] },
      { kind: 'marker', text: '*', styles: [] },
    ]);
  });
});

describe('stripFormat', () => {
  it('removes markers, keeps words', () => {
    expect(stripFormat('*bold* _italic_ ~strike~ +under+ ```mono```')).toBe(
      'bold italic strike under mono',
    );
  });

  it('leaves literal markers alone', () => {
    expect(stripFormat('snake_case_name 2*3*4 *open')).toBe('snake_case_name 2*3*4 *open');
  });

  it('keeps links and mentions', () => {
    expect(stripFormat(`*see https://x.com* @[${UUID}]`)).toBe(`see https://x.com @[${UUID}]`);
  });

  it('plain text passes through unchanged', () => {
    expect(stripFormat('hello there')).toBe('hello there');
  });
});

describe('closingMarkerTail', () => {
  it('counts a closing marker opened earlier on the line', () => {
    const body = '*see https://x.com*';
    expect(closingMarkerTail(body, 5, 'https://x.com*')).toBe(1);
  });

  it('is 0 without an opener', () => {
    expect(closingMarkerTail('see https://x.com/a_', 4, 'https://x.com/a_')).toBe(0);
  });

  it('ignores an opener on an earlier line', () => {
    expect(closingMarkerTail('*a\nhttps://x.com*', 3, 'https://x.com*')).toBe(0);
  });
});

describe('toggleFormat', () => {
  it('wraps the selection and keeps it on the words', () => {
    expect(toggleFormat('ship today', 5, 10, 'bold')).toMatchObject({
      from: 5,
      to: 10,
      mode: 'wrap',
      insert: '*today*',
      selStart: 6,
      selEnd: 11,
    });
  });

  it('unwraps when markers sit just outside the selection', () => {
    expect(toggleFormat('ship *today*', 6, 11, 'bold')).toMatchObject({
      from: 5,
      to: 12,
      insert: 'today',
      selStart: 5,
      selEnd: 10,
    });
  });

  it('unwraps when the selection includes the markers', () => {
    expect(toggleFormat('ship _today_', 5, 12, 'italic')).toMatchObject({
      from: 5,
      to: 12,
      insert: 'today',
      selStart: 5,
      selEnd: 10,
    });
  });

  it('keeps edge spaces outside the markers', () => {
    expect(toggleFormat('a word b', 1, 7, 'strike').insert).toBe('~word~');
  });

  it('mono uses three backticks', () => {
    expect(toggleFormat('x', 0, 1, 'mono').insert).toBe('```x```');
  });
});
