import { useEffect, useRef } from 'react';

/**
 * The 29 s problem film on the public homepage: client work cutting into a
 * personal WhatsApp. All copy lives inside the phone (bottom caption overlay,
 * stories-style progress bars on top). Static structure is JSX; one
 * requestAnimationFrame loop drives styles imperatively so the page does not
 * re-render 60 times a second. Motion axes: translateY only, no X, no rotate.
 */

export const FILM_LENGTH = 29;
export const SCENES: ReadonlyArray<readonly [number, number]> = [
  [0, 6.5],
  [6.5, 14],
  [14, 20],
  [20, 26],
  [26, 29],
];
export const CAPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['Work keeps cutting in.', 'Four unread from a client, between your mother and your cousins.'],
  [
    'You pin it. It still gets buried.',
    'Three files, two "which one?", one pin nobody scrolls up to.',
  ],
  ['You search. You get 23.', 'Across four chats. None of them is the answer.'],
  ['The people who matter wait.', 'Mom asked at 8:40. It is 9:14.'],
  ['', ''],
];

/** Pure: which scene is on screen at time t (seconds, wrapped to the loop). */
export function sceneAt(t: number): number {
  const w = ((t % FILM_LENGTH) + FILM_LENGTH) % FILM_LENGTH;
  const i = SCENES.findIndex(([a, b]) => w >= a && w < b);
  return i < 0 ? 0 : i;
}

const clamp = (v: number): number => Math.min(1, Math.max(0, v));
const prog = (t: number, a: number, b: number): number => clamp((t - a) / (b - a));
const easeOut = (x: number): number => 1 - Math.pow(1 - x, 3);

type Tone = 'peach' | 'sky' | 'mint' | 'wa' | 'slate' | 'amber' | 'green';

const CHATS: ReadonlyArray<{ id: string; name: string; tone: Tone; msg: string; time: string }> = [
  { id: 'mom', name: 'Mom', tone: 'peach', msg: 'Dinner at 9?', time: '8:40 pm' },
  { id: 'cou', name: 'Cousins', tone: 'sky', msg: 'Who is getting the sweets 😂', time: '8:38 pm' },
  { id: 'pri', name: 'Priya', tone: 'mint', msg: 'Call you after 10', time: '8:31 pm' },
  { id: 'kite', name: 'Kite & Co', tone: 'wa', msg: 'ok sending the files', time: '7:55 pm' },
  { id: 'bank', name: 'Bank alerts', tone: 'slate', msg: 'Your OTP is 4471', time: '7:10 pm' },
];
const LIST_EVENTS: ReadonlyArray<readonly [number, string, string, number]> = [
  [1.4, 'kite', 'is the diwali post approved?', 1],
  [2.6, 'kite', 'final_FINAL_v3.jpg', 2],
  [3.6, 'mom', '?', 0],
  [4.6, 'kite', 'or the v2 one?', 3],
  [5.4, 'kite', '??', 4],
];

interface ThreadMsg {
  at: number;
  out?: boolean;
  who?: string;
  text?: string;
  file?: { name: string; alt?: boolean };
  time: string;
}
const THREAD: ReadonlyArray<ThreadMsg> = [
  { at: 6.6, who: 'Arjun', file: { name: 'final_v2.jpg' }, time: '7:52' },
  { at: 7.2, who: 'Arjun', file: { name: 'final_FINAL_v3.jpg', alt: true }, time: '7:53' },
  { at: 7.9, who: 'Riya', text: 'which one is approved?', time: '7:58' },
  { at: 8.6, out: true, text: 'the second one', time: '8:01' },
  { at: 9.3, who: 'Meera', text: 'second of which? 😅', time: '8:03' },
  { at: 9.9, who: 'Dev', text: '👍', time: '8:04' },
  { at: 12.4, who: 'Riya', text: 'sorry which caption are we going with', time: '8:52' },
  { at: 13.2, who: 'Arjun', file: { name: 'final_v4_real.jpg' }, time: '8:58' },
];
const PINNED_INDEX = 3;

const QUERY = 'approved';
const RESULTS: ReadonlyArray<{
  chat: string;
  tone: Tone;
  before: string;
  hit: string;
  after: string;
}> = [
  {
    chat: 'Kite & Co',
    tone: 'wa',
    before: 'Riya: is the diwali post ',
    hit: 'approved',
    after: '?',
  },
  { chat: 'Kite & Co', tone: 'wa', before: 'you: ', hit: 'approved', after: ', go ahead' },
  {
    chat: 'Mehta Sweets',
    tone: 'amber',
    before: 'Sam: not ',
    hit: 'approved',
    after: ' yet pls hold',
  },
  {
    chat: 'Tara Jewels',
    tone: 'green',
    before: 'you: which one did you ',
    hit: 'approve',
    after: '?',
  },
  { chat: 'Kite & Co', tone: 'wa', before: 'Meera: wait was that ', hit: 'approved', after: '' },
  { chat: 'Mehta Sweets', tone: 'amber', before: 'you: ', hit: 'approved', after: ' 👍' },
];

const MOM: ReadonlyArray<readonly [number, string, string]> = [
  [20, 'Dinner at 9?', '8:40 pm'],
  [20.6, '?', '8:55 pm'],
  [21.1, 'hello', '9:02 pm'],
  [21.6, 'beta are you coming', '9:11 pm'],
];
const TYPED = 'coming in 10 mi';

function Tick() {
  return (
    <svg className="tick" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

export function HomeFilm() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const root = rootRef.current;
    if (!wrap || !root) return;
    const q = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector<T>(sel);
      if (!el) throw new Error(`HomeFilm: missing ${sel}`);
      return el;
    };
    const qa = (sel: string): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(sel));

    const scenes = qa('[data-scene]');
    const bars = qa('.prog b');
    const overlay = q('.ov');
    const capL = q('.ov .l');
    const capS = q('.ov .s');
    const progEl = q('.prog');
    const rows = new Map(CHATS.map((c) => [c.id, q(`[data-row="${c.id}"]`)]));
    const threadEls = qa('[data-thread]');
    const pinbar = q('.pinbar');
    const queryEl = q('[data-query]');
    const countEl = q('[data-count]');
    const resultEls = qa('[data-result]');
    const momEls = qa('[data-mom]');
    const typedEl = q('[data-typed]');
    const notiEl = q('.noti');

    let current = -1;
    let t = 0;
    let last: number | null = null;
    let raf = 0;

    const scene1 = (time: number): void => {
      const order = CHATS.map((c) => c.id);
      const text: Record<string, string> = {};
      const badge: Record<string, number> = {};
      for (const [at, id, msg, b] of LIST_EVENTS) {
        if (time >= at) {
          order.splice(order.indexOf(id), 1);
          order.unshift(id);
          text[id] = msg;
          badge[id] = b;
        }
      }
      order.forEach((id, i) => {
        const row = rows.get(id);
        if (!row) return;
        row.classList.toggle('snap', time < 0.1);
        row.style.transform = `translateY(${i * 74}px)`;
        const span = row.querySelector<HTMLElement>('.tx span');
        const bd = row.querySelector<HTMLElement>('.bd');
        const chat = CHATS.find((c) => c.id === id);
        if (span && chat) span.textContent = text[id] ?? chat.msg;
        if (bd) {
          const n = badge[id];
          bd.hidden = !n;
          bd.textContent = n ? String(n) : '';
        }
      });
    };
    const scene2 = (time: number): void => {
      THREAD.forEach((m, i) => {
        const el = threadEls[i];
        if (!el) return;
        const k = easeOut(prog(time, m.at, m.at + 0.35));
        el.style.display = time >= m.at ? '' : 'none';
        el.style.opacity = String(k);
        el.style.transform = `translateY(${12 * (1 - k)}px)`;
        el.classList.toggle('pinned', i === PINNED_INDEX && time >= 10.6 && time < 11.6);
      });
      pinbar.style.transform = `translateY(${-100 * (1 - easeOut(prog(time, 11.4, 11.8)))}%)`;
    };
    const scene3 = (time: number): void => {
      queryEl.textContent = QUERY.slice(0, Math.floor(prog(time, 14.3, 15.6) * QUERY.length));
      countEl.textContent = time > 15.7 ? '23 results in 4 chats' : '';
      resultEls.forEach((el, i) => {
        const k = easeOut(prog(time, 15.8 + i * 0.22, 16.1 + i * 0.22));
        el.style.opacity = String(k);
        el.style.transform = `translateY(${10 * (1 - k)}px)`;
      });
    };
    const scene4 = (time: number): void => {
      MOM.forEach(([at], i) => {
        const el = momEls[i];
        if (!el) return;
        el.style.display = time >= at ? '' : 'none';
        el.style.opacity = String(easeOut(prog(time, at, at + 0.35)));
      });
      const n = Math.floor(prog(time, 22.2, 23.8) * TYPED.length);
      typedEl.textContent = n ? TYPED.slice(0, n) : 'Message';
      typedEl.classList.toggle('typing', n > 0);
      notiEl.style.transform = `translateY(${-130 * (1 - easeOut(prog(time, 24, 24.4)))}%)`;
    };
    const renderers = [scene1, scene2, scene3, scene4];

    const draw = (): void => {
      const si = sceneAt(t);
      scenes.forEach((s, i) => {
        s.hidden = i !== si;
      });
      if (si !== current) {
        current = si;
        const cap = CAPTIONS[si];
        capL.textContent = cap ? cap[0] : '';
        capS.textContent = cap ? cap[1] : '';
      }
      const start = SCENES[si]?.[0] ?? 0;
      const k = si === 4 ? 0 : easeOut(prog(t, start + 0.5, start + 1));
      overlay.style.opacity = String(k);
      overlay.style.transform = `translateY(${10 * (1 - k)}px)`;
      progEl.style.opacity = si === 4 ? '0' : '1';
      bars.forEach((b, i) => {
        const span = SCENES[i];
        if (span) b.style.width = `${prog(t, span[0], span[1]) * 100}%`;
      });
      renderers[si]?.(t);
    };
    const loop = (ts: number): void => {
      if (last !== null) {
        t += (ts - last) / 1000;
        if (t >= FILM_LENGTH) t = 0;
      }
      last = ts;
      draw();
      raf = requestAnimationFrame(loop);
    };

    const phone = q('.phone');
    const fit = (): void => {
      phone.style.transform = `scale(${wrap.clientWidth / 340})`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      t = 5.5;
      draw();
    } else {
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <section
      className="film"
      id="problem"
      aria-label="A short film showing client work interrupting personal WhatsApp"
    >
      <div className="wrap">
        <div className="phone-wrap" ref={wrapRef}>
          <div ref={rootRef}>
            <div className="phone">
              <div className="scr">
                <div className="prog" aria-hidden="true">
                  {SCENES.map(([a]) => (
                    <i key={a}>
                      <b />
                    </i>
                  ))}
                </div>

                <div className="scn" data-scene>
                  <div className="wah">Chats</div>
                  <div className="rows">
                    {CHATS.map((c) => (
                      <div className="row snap" data-row={c.id} key={c.id}>
                        <div className={`pa ${c.tone}`}>{c.name[0]}</div>
                        <div className="tx">
                          <b>
                            {c.name}
                            <small>{c.time}</small>
                          </b>
                          <span>{c.msg}</span>
                        </div>
                        <div className="bd" hidden />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="scn" data-scene hidden>
                  <div className="wah">
                    <span className="bk">‹</span>
                    <div>
                      Kite &amp; Co<span className="sub">Riya, Arjun, Meera, Dev, you</span>
                    </div>
                  </div>
                  <div className="pinbar">
                    📌{' '}
                    <span>
                      Pinned: <b>the second one</b>
                    </span>
                  </div>
                  <div className="thr">
                    {THREAD.map((m) => (
                      <div className={`m${m.out ? ' o' : ''}`} data-thread key={m.at}>
                        {m.who && <span className="n">{m.who}</span>}
                        {m.text}
                        {m.file && (
                          <div className="f">
                            <i className={m.file.alt ? 'alt' : undefined} />
                            {m.file.name}
                          </div>
                        )}
                        <div className="tm">{m.time}</div>
                      </div>
                    ))}
                  </div>
                  <div className="comp">
                    <div className="in">Message</div>
                    <div className="mic" />
                  </div>
                </div>

                <div className="scn srch" data-scene hidden>
                  <div className="bar">
                    <span>🔍</span>
                    <span className="q" data-query />
                    <span className="cancel">Cancel</span>
                  </div>
                  <div className="cnt" data-count />
                  <div>
                    {RESULTS.map((r, i) => (
                      <div className="r" data-result key={i}>
                        <div className={`pa ${r.tone}`}>{r.chat[0]}</div>
                        <div>
                          <b>{r.chat}</b>
                          <span>
                            {r.before}
                            <mark>{r.hit}</mark>
                            {r.after}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="scn" data-scene hidden>
                  <div className="wah">
                    <span className="bk">‹</span>
                    <div>
                      Mom<span className="sub">last seen 9:12 pm</span>
                    </div>
                  </div>
                  <div className="thr">
                    {MOM.map(([at, text, time]) => (
                      <div className="m" data-mom key={at}>
                        {text}
                        <div className="tm">{time}</div>
                      </div>
                    ))}
                  </div>
                  <div className="comp">
                    <div className="in" data-typed>
                      Message
                    </div>
                    <div className="mic" />
                  </div>
                  <div className="noti">
                    <div className="ic" />
                    <div>
                      <b>Kite &amp; Co</b>
                      <span>Riya: so is it approved or not?</span>
                    </div>
                  </div>
                </div>

                <div className="scn end" data-scene hidden>
                  <div>
                    <div className="ck">
                      <Tick />
                    </div>
                    <div className="l">
                      Work chat belongs
                      <br />
                      in a <em>work</em> app.
                    </div>
                    <div className="s">Your WhatsApp goes back to being WhatsApp.</div>
                    <div className="logo">
                      srtd<b>.</b>
                    </div>
                  </div>
                </div>

                <div className="ov" aria-live="off">
                  <div className="l" />
                  <div className="s" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
