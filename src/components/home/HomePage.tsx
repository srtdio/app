import { useEffect, useRef, useState, type FormEvent } from 'react';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { ClipVideo } from './ClipVideo';
import { SiteShell, Tick } from './Chrome';
import { DEMO_HREF } from './config';
import { FEATURES, featureFromHash, featureId, showFeature } from './features';
import { HOME_MEDIA_BASE, clipFor, mediaUrl } from './media';
import './home.css';

// Small lines under the hero buttons, the signup email box and the closing buttons.
const HERO_NOTE = 'Work chat that stays out of the WhatsApp group.';
const SIGNUP_NOTE = 'Free. Faster than finding that one voice note.';
const CLOSE_NOTE = 'Made for people who’ve typed “any update?” too many times.';

// Public homepage (/), v19 prototype approved 14 Oct 2026. Light only. Rendered
// on the guest path without a router (src/main.tsx -> HomeEntry) and by
// HomeGate inside the app, so every link is a plain anchor (full navigation).

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROBLEMS_LABEL =
  'Approvals lost in WhatsApp, a tracker nobody updates, I never approved that, send me the final-final logo. Sorted fixes all four.';

interface Reason {
  kick: string;
  title: string;
  body: string;
  proof: string;
  image: string;
  alt: string;
}

const REASONS: Reason[] = [
  {
    kick: 'Approvals',
    title: '“When did I approve this?” Tuesday, 4:12 pm.',
    body: 'Every social media post in Sorted carries its own approval: who said yes, to what, and when. No scrolling up a group to prove it. No screenshots as evidence.',
    proof: 'Logged the moment your client taps Approve.',
    image: 'why-approvals.webp',
    alt: 'A client approving a post in a Sorted chat, with who approved it and when',
  },
  {
    kick: 'Evenings',
    title: '“Is this final?” Not at 11 pm.',
    body: "Client feedback, files and “is this final?” live in Sorted. Not between dinner plans and your bank's OTPs. Your phone is yours again after work.",
    proof: 'Groups and DMs with your team and your client.',
    image: 'why-evenings.webp',
    alt: 'The Sorted chat tab with client groups and people',
  },
  {
    kick: 'Clients',
    title: '“Which group was that?” None. It’s a workspace.',
    body: 'Each client gets a workspace for their social media posts, briefs, files and chat. Switching clients is one tap, not a scroll through forty groups.',
    proof: 'SRTD on Instagram is one workspace. SRTD on LinkedIn is another.',
    image: 'why-clients.webp',
    alt: 'Switching between client workspaces in Sorted',
  },
  {
    kick: 'Catch-up',
    title: 'Stop checking. Sorted checks for you.',
    body: 'At 10:30 and 3:30 on weekdays, one email tells you what moved while you were away: approvals, comments, briefs, chats. Every line opens the right screen. Nothing new, no email.',
    proof: 'Weekdays, 10:30 am and 3:30 pm.',
    image: 'why-catchup.webp',
    alt: 'A Sorted catch-up email',
  },
];

// Real pixel size of the why-*.webp files (CDN, 14 Oct 2026).
const REASON_IMAGE_WIDTH = 780;
const REASON_IMAGE_HEIGHT = 1240;

function Cta() {
  return (
    <div className="cta">
      <a className="btn" href="#signup-mid">
        Sign up for free
      </a>
      <a className="btn line" href={DEMO_HREF}>
        Book a demo
      </a>
    </div>
  );
}

function SignupBand() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(SIGNUP_NOTE);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const value = email.trim();
    if (!EMAIL_RE.test(value)) {
      setMessage('Enter your work email, like you@agency.com.');
      return;
    }
    window.location.assign(`/signup?email=${encodeURIComponent(value)}`);
  };

  return (
    <section className="band" id="signup-mid">
      <div className="wrap">
        <h2 className="d">You&apos;ve scrolled this far. Might as well sign up.</h2>
        <p>Set up a client in two minutes. Invite them with a link.</p>
        <form onSubmit={onSubmit} noValidate>
          <input
            type="email"
            placeholder="Work email"
            aria-label="Work email"
            aria-describedby="home-signup-note"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn" type="submit">
            Sign up for free
          </button>
        </form>
        <small id="home-signup-note" aria-live="polite">
          {message}
        </small>
      </div>
    </section>
  );
}

// After this long on one card, the row nudges left once to show there is more.
const NUDGE_AFTER_MS = 3000;
// Manual swipes after which the nudge stops for the visit.
const NUDGE_SWIPE_LIMIT = 2;
// Scroll is treated as settled after this long without a scroll event.
const SETTLE_MS = 140;
// Phones and tablets: below the desktop breakpoint in home.css.
const MOBILE_QUERY = '(max-width: 959.98px), (max-height: 639.98px)';

/** The rail scrollLeft at which the card sits at its snap position. */
function cardLeft(rail: HTMLElement, card: HTMLElement): number {
  const pad = parseFloat(getComputedStyle(rail).scrollPaddingLeft) || 0;
  const offset = card.getBoundingClientRect().left - rail.getBoundingClientRect().left;
  return rail.scrollLeft + offset - pad;
}

/**
 * The feature rail: one card per key, each with its own id for the sidebar
 * tiles. Only the card in view plays its clip; when the clip ends the rail
 * moves to the next card, and from the last card back to the first. On
 * phones, a card left in view for 3 seconds nudges the row left once.
 * Reduced motion: clips loop in place, no auto-advance, no nudge.
 */
function FeatureRail() {
  const railRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  const [nudging, setNudging] = useState(false);
  const currentRef = useRef(0);
  const touchingRef = useRef(false);
  const autoRef = useRef(false);
  const swipesRef = useRef(0);
  const nudgedRef = useRef(new Set<number>());
  const [reduced] = useState(
    () =>
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  const cards = (): HTMLElement[] =>
    Array.from(railRef.current?.querySelectorAll<HTMLElement>('.card') ?? []);

  const goTo = (index: number): void => {
    const rail = railRef.current;
    const card = cards()[index];
    if (!rail || !card) return;
    autoRef.current = true;
    rail.scrollTo({ left: cardLeft(rail, card), behavior: 'smooth' });
  };

  // Desktop arrows: one card at a time.
  const step = (direction: 1 | -1): void => {
    const rail = railRef.current;
    const card = rail?.querySelector<HTMLElement>('.card');
    if (!rail || !card) return;
    const gap = parseFloat(getComputedStyle(rail).columnGap) || 0;
    rail.scrollBy({ left: direction * (card.offsetWidth + gap), behavior: 'smooth' });
  };

  // Track the card in view once scrolling settles.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    let timer = 0;
    const onScroll = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const list = cards();
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        list.forEach((card, i) => {
          const distance = Math.abs(cardLeft(rail, card) - rail.scrollLeft);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
          }
        });
        if (best !== currentRef.current) {
          if (!autoRef.current) swipesRef.current += 1;
          currentRef.current = best;
          setCurrent(best);
        }
        autoRef.current = false;
      }, SETTLE_MS);
    };
    const onTouchStart = (): void => {
      touchingRef.current = true;
      autoRef.current = false;
      setNudging(false);
    };
    const onTouchEnd = (): void => {
      touchingRef.current = false;
    };
    rail.addEventListener('scroll', onScroll, { passive: true });
    rail.addEventListener('pointerdown', onTouchStart, { passive: true });
    rail.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('pointerup', onTouchEnd, { passive: true });
    rail.addEventListener('touchend', onTouchEnd, { passive: true });
    rail.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      window.clearTimeout(timer);
      rail.removeEventListener('scroll', onScroll);
      rail.removeEventListener('pointerdown', onTouchStart);
      rail.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('pointerup', onTouchEnd);
      rail.removeEventListener('touchend', onTouchEnd);
      rail.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  // The card coming into view starts its clip from the beginning.
  useEffect(() => {
    const video = cards()[current]?.querySelector('video');
    if (video) video.currentTime = 0;
  }, [current]);

  // Phones: nudge once per card after 3 seconds, never on the last card.
  useEffect(() => {
    if (reduced) return undefined;
    const timer = window.setTimeout(() => {
      if (!matchMedia(MOBILE_QUERY).matches) return;
      if (touchingRef.current || swipesRef.current >= NUDGE_SWIPE_LIMIT) return;
      if (current >= FEATURES.length - 1 || nudgedRef.current.has(current)) return;
      nudgedRef.current.add(current);
      setNudging(true);
    }, NUDGE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [current, reduced]);

  const onClipEnded = (index: number): void => {
    if (index !== currentRef.current) return;
    const video = cards()[index]?.querySelector('video');
    if (touchingRef.current) {
      // A finger is on the cards: replay and wait.
      if (video) {
        video.currentTime = 0;
        void video.play().catch(() => undefined);
      }
      return;
    }
    goTo((index + 1) % FEATURES.length);
  };

  return (
    <>
      <div className="rail-nav">
        <button
          className="icon-btn"
          type="button"
          aria-label="Previous feature"
          onClick={() => step(-1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <button
          className="icon-btn"
          type="button"
          aria-label="Next feature"
          onClick={() => step(1)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      <div
        className={nudging ? 'rail nudging' : 'rail'}
        ref={railRef}
        onAnimationEnd={() => setNudging(false)}
      >
        {FEATURES.map((feature, index) => {
          const clip = clipFor(HOME_MEDIA_BASE, feature.clip);
          return (
            <article
              key={feature.key}
              id={featureId(feature.key)}
              className={`card ${feature.tone}`}
              data-active={index === current ? '' : undefined}
            >
              <div className="k">{feature.name}</div>
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
              {clip ? (
                <div className="mock">
                  <div className="clipbox">
                    <ClipVideo
                      clip={clip}
                      label={feature.label}
                      className="shot clip"
                      loop={reduced}
                      held={index !== current}
                      onEnded={() => onClipEnded(index)}
                    />
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </>
  );
}

export default function HomePage() {
  // Arriving on "/#feature-<key>" (a sidebar tile on /demo): land
  // on that card once it is laid out, and again once the fonts settle.
  useEffect(() => {
    const key = featureFromHash(window.location.hash);
    if (key === null) return;
    const frame = requestAnimationFrame(() => showFeature(key, 'instant'));
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) showFeature(key, 'instant');
    });
    return () => {
      live = false;
      cancelAnimationFrame(frame);
    };
  }, []);

  const problemsMobile = clipFor(HOME_MEDIA_BASE, 'problems-m');
  const problemsDesktop = clipFor(HOME_MEDIA_BASE, 'problems-d');

  return (
    <SiteShell surface="home">
      <section className="hero">
        <div className="wrap in">
          <h1 className="d">
            Social media teams <em>hate WhatsApp.</em>
          </h1>
          <p className="lede">
            Approvals, feedback and files get buried in group chats that never switch off. Sorted
            gives each client one workspace, so WhatsApp goes back to being WhatsApp.
          </p>
          <Cta />
          <div className="note">{HERO_NOTE}</div>
        </div>
      </section>

      {problemsMobile && problemsDesktop ? (
        <section className="prob" aria-label="Why agencies need Sorted">
          <div className="wrap">
            <div className="box mb">
              <ClipVideo clip={problemsMobile} label={PROBLEMS_LABEL} />
            </div>
            <div className="box dk">
              <ClipVideo clip={problemsDesktop} label={PROBLEMS_LABEL} />
            </div>
          </div>
        </section>
      ) : null}

      <section className="sec" id="features">
        <div className="wrap">
          <div className="head">
            <h2 className="d">Chat. Plan. Approve.</h2>
            <p>The three jobs WhatsApp was never built to do.</p>
          </div>
        </div>
        <FeatureRail />
      </section>

      <SignupBand />

      <section className="sec" id="why">
        <div className="wrap">
          <div className="head">
            <h2 className="d">What Sorted sorts.</h2>
            <p>Four arguments you’ll never have again.</p>
          </div>
          <div className="stack">
            {REASONS.map((reason) => {
              const src = mediaUrl(HOME_MEDIA_BASE, reason.image);
              return (
                <div key={reason.kick} className={src ? 'sb' : 'sb text-only'}>
                  <div className="tx">
                    <div className="kick">{reason.kick}</div>
                    <h3>{reason.title}</h3>
                    <p>{reason.body}</p>
                    <div className="proof">
                      <Tick />
                      {reason.proof}
                    </div>
                  </div>
                  {src ? (
                    <div className="vis">
                      <img
                        className="shot"
                        src={src}
                        alt={reason.alt}
                        width={REASON_IMAGE_WIDTH}
                        height={REASON_IMAGE_HEIGHT}
                        loading="lazy"
                        decoding="async"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="close">
        <div className="wrap">
          <h2 className="d">
            Get your social media work <em>sorted.</em>
          </h2>
          <Cta />
          <div className="note">{CLOSE_NOTE}</div>
        </div>
      </section>
    </SiteShell>
  );
}
