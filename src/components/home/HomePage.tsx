import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { ClipVideo } from './ClipVideo';
import { HOME_MEDIA_BASE, clipFor, mediaUrl } from './media';
import { Wordmark } from './Wordmark';
import './home.css';

// Public homepage (/), v19 prototype approved 14 Oct 2026. Light only. Rendered
// on the guest path without a router (src/main.tsx -> HomeEntry) and by
// HomeGate inside the app, so every link is a plain anchor (full navigation).

const DEMO_MAILTO = 'mailto:support@srtd.io?subject=Sorted%20demo';
const NOTE = '15 days free. No card. Clients join at no cost.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROBLEMS_LABEL =
  'Approvals lost in WhatsApp, a tracker nobody updates, I never approved that, send me the final-final logo. Sorted fixes all four.';

interface Feature {
  key: string;
  tone: string;
  clip: string;
  title: string;
  body: string;
  label: string;
}

const FEATURES: Feature[] = [
  {
    key: 'Chat',
    tone: 'c1',
    clip: 'chat',
    title: '“Who’s doing what?” It’s in the top bar.',
    body: 'The top bar keeps count of everything open in the chat: the plan, posts in review, briefs, commitments. Plus reminders, tasks, voice notes as text, and scheduled sends.',
    label: 'Walkthrough of Sorted chat',
  },
  {
    key: 'Plan',
    tone: 'c2',
    clip: 'plan',
    title: '“Did they see the plan?” They ticked it.',
    body: "Share the plan into the chat. Your client ticks each post and idea, and the chat's top bar keeps the count.",
    label: 'Walkthrough of a Sorted plan',
  },
  {
    key: 'Pipeline',
    tone: 'c3',
    clip: 'pipeline',
    title: '“Which one is final?” The one with the green tick.',
    body: 'Pin a comment right on the photo, numbered. Your client approves the post from the chat with a confirm step. One post at a time, never in bulk.',
    label: 'Walkthrough of the Sorted pipeline',
  },
  {
    key: 'Assets',
    tone: 'c4',
    clip: 'assets',
    title: '“Can you send the logo again?” It never left.',
    body: 'Every photo, lookbook and campaign deck for the client in one place. Photos and PDFs open right inside Sorted.',
    label: 'Walkthrough of Sorted assets',
  },
  {
    key: 'Briefs',
    tone: 'c5',
    clip: 'briefs',
    title: '“Where’s the brief?” Pinned, with pictures.',
    body: 'Your client writes the brief in Sorted, photos and all. It stays exactly as written: Open while you work on it, Closed when it’s done.',
    label: 'Walkthrough of Sorted briefs',
  },
];

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

const PRODUCT_TILES = [
  { tone: 'c1', name: 'Chat', sub: 'Work chat per client' },
  { tone: 'c2', name: 'Plan', sub: 'The week, agreed' },
  { tone: 'c3', name: 'Pipeline', sub: 'Draft to approved' },
  { tone: 'c4', name: 'Assets', sub: 'Files, versioned' },
  { tone: 'c5 wide', name: 'Briefs', sub: 'Written by the client, photos and all' },
];

function Tick() {
  return (
    <svg className="tick" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

function Cta() {
  return (
    <div className="cta">
      <a className="btn" href="#signup-mid">
        Sign up for free
      </a>
      <a className="btn line" href={DEMO_MAILTO}>
        Book a demo
      </a>
    </div>
  );
}

function Menu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  return (
    <div
      className={open ? 'menu open' : 'menu'}
      id="home-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      aria-hidden={!open}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as Element).closest('a')) onClose();
      }}
    >
      <nav className="panel">
        <div className="ph">
          <a className="logo" href="#top" aria-label="srtd home">
            <Wordmark />
          </a>
          <button
            ref={closeRef}
            className="icon-btn"
            type="button"
            aria-label="Close menu"
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="lbl first">Product</div>
        <div className="nav-feat">
          {PRODUCT_TILES.map((tile) => (
            <a key={tile.name} className={tile.tone} href="#features">
              {tile.name}
              <small>{tile.sub}</small>
            </a>
          ))}
        </div>

        <div className="lbl">Company</div>
        <div className="nav-main">
          <a href="#why">Why Sorted</a>
          <a href={DEMO_MAILTO}>
            Book a demo <span>30 min</span>
          </a>
        </div>

        <div className="foot">
          <a className="btn ghost" href="/signin">
            Sign in
          </a>
          <a className="btn" href="/signup">
            Sign up free
          </a>
          <div className="note">{NOTE}</div>
        </div>
      </nav>
    </div>
  );
}

function SignupBand() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState(NOTE);

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
        <h2 className="d">Start free. Fifteen days. No card.</h2>
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
        <div className="alt">
          <a className="btn line" href={DEMO_MAILTO}>
            Book a demo
          </a>
        </div>
        <small id="home-signup-note" aria-live="polite">
          {message}
        </small>
      </div>
    </section>
  );
}

export default function HomePage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    menuBtnRef.current?.focus();
  }, []);

  const problemsMobile = clipFor(HOME_MEDIA_BASE, 'problems-m');
  const problemsDesktop = clipFor(HOME_MEDIA_BASE, 'problems-d');

  return (
    <div className="home">
      <header className={scrolled ? 'top on' : 'top'} id="top">
        <div className="wrap">
          <a className="logo" href="#top" aria-label="srtd home">
            <Wordmark />
          </a>
          <span className="sp" />
          <a className="btn sm ghost" href="/signin">
            Sign in
          </a>
          <a className="btn sm" href="/signup">
            Sign up
          </a>
          <button
            ref={menuBtnRef}
            className="icon-btn"
            type="button"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls="home-menu"
            onClick={() => setMenuOpen(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </header>

      <Menu open={menuOpen} onClose={closeMenu} />

      <main>
        <section className="hero">
          <div className="wrap in">
            <h1 className="d">
              You can&apos;t block <em>your clients.</em>
            </h1>
            <p>
              So we built Sorted. Your social media posts arrive as cards, feedback stays on the
              post, and every approval is on record.
            </p>
            <Cta />
            <div className="note">{NOTE}</div>
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
              <p>Each one replaces a habit you have on WhatsApp today.</p>
            </div>
          </div>
          <div className="rail">
            {FEATURES.map((feature) => {
              const clip = clipFor(HOME_MEDIA_BASE, feature.clip);
              return (
                <article key={feature.key} className={`card ${feature.tone}`}>
                  <div className="k">{feature.key}</div>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                  {clip ? (
                    <div className="mock">
                      <div className="clipbox">
                        <ClipVideo clip={clip} label={feature.label} className="shot clip" />
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
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
            <div className="note">{NOTE}</div>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <a className="logo" href="#top" aria-label="srtd home">
            <Wordmark />
          </a>
          <ul>
            <li>
              <a href="#features">Product</a>
            </li>
            <li>
              <a href={DEMO_MAILTO}>Book a demo</a>
            </li>
            <li>
              <a href="/legal/privacy-policy">Privacy</a>
            </li>
            <li>
              <a href="/legal/terms-and-conditions">Terms</a>
            </li>
          </ul>
          <span className="cp">© 2026 Sorted · Made in Mumbai</span>
        </div>
      </footer>
    </div>
  );
}
