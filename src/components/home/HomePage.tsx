import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import '@fontsource-variable/fraunces/full-italic.css';
import { initTheme } from '@/lib/theme';
import { HomeFilm } from './HomeFilm';
import './home.css';

/**
 * Public homepage at / for signed-out visitors. Light only by decision
 * (13 Oct 2026): a deliberate exception to light/dark parity for this route.
 * Copy and layout are the approved prototype. Fictional names only.
 */

const DEMO_MAILTO = 'mailto:support@srtd.io?subject=Sorted%20demo';

/** Pin light while the homepage is mounted; restore the stored theme after. */
function useForceLight(): void {
  useEffect(() => {
    const root = document.documentElement;
    const wasDark = root.classList.contains('dark');
    if (wasDark) root.classList.remove('dark');
    return () => {
      if (wasDark) initTheme();
    };
  }, []);
}

function Tick() {
  return (
    <svg className="tick" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

function Wordmark({ to = '/' }: { to?: string }) {
  return (
    <Link className="logo" to={to} aria-label="srtd home">
      srtd<b>.</b>
    </Link>
  );
}

function Header() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const close = (): void => setOpen(false);

  return (
    <>
      <header className={`top${scrolled ? ' on' : ''}`}>
        <div className="wrap">
          <Wordmark />
          <span className="sp" />
          <Link className="btn sm" to="/signup">
            Sign up
          </Link>
          <button
            className="icon-btn"
            type="button"
            aria-label="Open menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </header>
      {open && (
        <div
          className="menu"
          role="dialog"
          aria-label="Menu"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="panel">
            <button
              className="icon-btn close"
              type="button"
              aria-label="Close menu"
              onClick={close}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
            <a className="item" href="#features" onClick={close}>
              Product
            </a>
            <a className="item" href="#why" onClick={close}>
              Why Sorted
            </a>
            <a className="item" href={DEMO_MAILTO} onClick={close}>
              Book a demo
            </a>
            <Link className="item" to="/signin" onClick={close}>
              Sign in
            </Link>
            <div className="foot">
              <Link className="btn" to="/signup" onClick={close}>
                Sign up for free
              </Link>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CtaPair() {
  return (
    <div className="cta">
      <Link className="btn" to="/signup">
        Sign up for free
      </Link>
      <a className="btn" href={DEMO_MAILTO}>
        Book a demo
      </a>
    </div>
  );
}

const TRIAL_NOTE = '15 days free. No card. Clients join at no cost.';

function Hero() {
  return (
    <section className="hero">
      <div className="wrap">
        <h1 className="d">
          Chat. Plan. <em>Approve.</em>
        </h1>
        <p>
          One work chat per client. Posts arrive as cards, feedback stays on the post, and every
          approval is on record. Your WhatsApp goes back to being WhatsApp.
        </p>
        <CtaPair />
        <div className="note">{TRIAL_NOTE}</div>
      </div>
    </section>
  );
}

function FeatureRail() {
  return (
    <section className="sec" id="features">
      <div className="wrap">
        <div className="head">
          <h2 className="d">Five things, one app.</h2>
          <p>Each one replaces a habit you have on WhatsApp today.</p>
        </div>
        <div className="rail">
          <article className="card c1">
            <div className="k">Chat</div>
            <h3>Work chat that does work.</h3>
            <p>
              DMs and groups, unlimited. Your team, your client, or both in one room. Tasks with an
              owner, a due time and a priority. Reminders, scheduled sends. Every change announced
              in the thread.
            </p>
            <div className="mock">
              <div className="hd">
                <div className="sq">K&amp;</div>
                <div>
                  <b>Kite &amp; Co</b>
                  <span>Agency, Client · 5 people</span>
                </div>
              </div>
              <div className="bl">Can we lock the festive captions today?</div>
              <div className="bl o">Adding it to the list</div>
              <div className="tsk">
                <span className="n">1</span>
                <div>
                  <b>Final captions</b>
                  <span>Agency · Today 6 pm</span>
                </div>
                <span className="chip">P1</span>
              </div>
              <div className="tsk">
                <span className="n">2</span>
                <div>
                  <b>Product shots</b>
                  <span>Client · Tomorrow 11 am</span>
                </div>
                <span className="chip g">P2</span>
              </div>
              <div className="sysl">
                <b>Riya</b> moved Product shots to <b>P0</b>
              </div>
            </div>
          </article>

          <article className="card c2">
            <div className="k">Plan</div>
            <h3>The week, agreed in writing.</h3>
            <p>
              Build the week&apos;s plan, share it in the chat, and let the client tick each day.
              Dates stay in sync with the posts.
            </p>
            <div className="mock plan">
              <div className="hd">
                <div className="sq amber">W</div>
                <div>
                  <b>Week of 13 Oct</b>
                  <span>3 of 5 approved</span>
                </div>
              </div>
              <div className="day">
                <span className="dt">Mon 13</span>
                <div className="th" />
                <div>
                  <b>Diwali drop · carousel</b>
                  <span>Approved by Riya</span>
                </div>
                <div className="bx on">
                  <Tick />
                </div>
              </div>
              <div className="day">
                <span className="dt">Wed 15</span>
                <div className="th b" />
                <div>
                  <b>Festive reel</b>
                  <span>Approved by Riya</span>
                </div>
                <div className="bx on">
                  <Tick />
                </div>
              </div>
              <div className="day">
                <span className="dt">Fri 17</span>
                <div className="th c" />
                <div>
                  <b>Gifting concept</b>
                  <span className="wait">Waiting</span>
                </div>
                <div className="bx" />
              </div>
            </div>
          </article>

          <article className="card c3">
            <div className="k">Pipeline</div>
            <h3>Draft. Review. Approved.</h3>
            <p>
              Every post has a stage. Comments sit on the post, not in a thread. The client approves
              it there, one at a time, with a confirm step.
            </p>
            <div className="mock">
              <div className="stages">
                <span className="chip g">Draft 4</span>
                <span className="chip cur">Review 2</span>
                <span className="chip g">Approved 11</span>
                <span className="chip g">Parked 1</span>
              </div>
              <div className="pp">
                <div className="th" />
                <div>
                  <b className="pt">Diwali drop · carousel 1 of 4</b>
                  <div className="cmt mt8">
                    <i className="av">R</i>
                    <div>Make the lamp warmer.</div>
                  </div>
                  <div className="cmt mt6">
                    <i className="av ag">A</i>
                    <div>
                      Fixed in v2. <span className="ok">Ready</span>
                    </div>
                  </div>
                  <div className="btns">
                    <div>Comment</div>
                    <div className="p">Approve</div>
                  </div>
                </div>
              </div>
            </div>
          </article>

          <article className="card c4">
            <div className="k">Assets</div>
            <h3>The right file, the first time.</h3>
            <p>
              Folders per client. Versions kept. PDFs, decks and sheets open inside Sorted, scanned
              before anyone can tap them.
            </p>
            <div className="mock">
              <div className="fold">
                <div>
                  Brand<small>14 files</small>
                </div>
                <div>
                  Diwali<small>22 files</small>
                </div>
                <div>
                  Reels<small>6 files</small>
                </div>
              </div>
              <div className="pdf">
                <div className="ic" />
                <div>
                  <b>Festive_brief.pdf</b>
                  <span>v3 · Meera · opens in app</span>
                </div>
                <span className="chip ok">
                  <Tick />
                  Safe
                </span>
              </div>
              <div className="pdf mt8">
                <div className="ic x" />
                <div>
                  <b>Price_list.xlsx</b>
                  <span>v1 · Dev · opens in app</span>
                </div>
                <span className="chip ok">
                  <Tick />
                  Safe
                </span>
              </div>
            </div>
          </article>

          <article className="card c5">
            <div className="k">Catch-up</div>
            <h3>Find out at 10:30 and 3:30.</h3>
            <p>
              Two emails a day on weekdays, only if something moved. Reviews, briefs, comments,
              missed chats. Tap anything to land on it.
            </p>
            <div className="mock mail">
              <div className="fr">
                <span>Sorted · 3:30 pm</span>
                <span>to Riya</span>
              </div>
              <h4>Since 10:30 am in Kite &amp; Co</h4>
              <ul>
                <li>
                  <i />2 posts sent for your review
                </li>
                <li>
                  <i />4 new comments on Diwali drop
                </li>
                <li>
                  <i />1 new brief: Festive reel
                </li>
              </ul>
              <div className="q">
                <b>Arjun</b> · Done, v2 is up. Can you look before 6?
              </div>
              <div className="go">Open in Sorted</div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

function SignupBand() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    navigate(`/signup?email=${encodeURIComponent(email.trim())}`);
  };
  return (
    <section className="band">
      <div className="wrap">
        <h2 className="d">Start free. Fifteen days. No card.</h2>
        <p>Set up a client in two minutes. Invite them with a link.</p>
        <form onSubmit={onSubmit}>
          <input
            id="home-signup-email"
            type="email"
            placeholder="Work email"
            aria-label="Work email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button className="btn" type="submit">
            Sign up for free
          </button>
        </form>
        <small>
          Or <a href={DEMO_MAILTO}>book a demo</a> and we will set it up with you.
        </small>
      </div>
    </section>
  );
}

function BenefitStack() {
  return (
    <section className="sec" id="why">
      <div className="wrap">
        <div className="head">
          <h2 className="d">What you get back.</h2>
          <p>Four things that change once client work moves out of WhatsApp.</p>
        </div>
        <div className="stack">
          <div className="sb">
            <div>
              <div className="no">01</div>
              <h3>Every approval, on record.</h3>
              <p>
                Who said yes, to which version, at what time. When a client asks &quot;did we
                approve that?&quot;, the answer is one tap, not a scroll.
              </p>
            </div>
            <div className="vis">
              <div className="rec">
                <span className="chip ok">
                  <Tick />
                  Approved
                </span>
                <dl>
                  <dt>By</dt>
                  <dd>Riya Menon</dd>
                  <dt>Version</dt>
                  <dd>v2</dd>
                  <dt>When</dt>
                  <dd>Thu 16 Oct, 4:12 pm</dd>
                  <dt>Post</dt>
                  <dd>Diwali drop · 1 of 4</dd>
                </dl>
              </div>
            </div>
          </div>

          <div className="sb">
            <div>
              <div className="no">02</div>
              <h3>Your evenings are yours.</h3>
              <p>
                Work stays in Sorted. Your phone stops buzzing with &quot;is it final?&quot; during
                dinner. Clients get a calmer channel too.
              </p>
            </div>
            <div className="vis">
              <div className="two">
                <div className="ph2">
                  <b>WhatsApp</b>
                  <div className="li">
                    <i className="dot peach" />
                    Mom
                  </div>
                  <div className="li">
                    <i className="dot sky" />
                    Cousins
                  </div>
                  <div className="li">
                    <i className="dot mint" />
                    Priya
                  </div>
                </div>
                <div className="ph2">
                  <b>Sorted</b>
                  <div className="li">
                    <i className="dot acc" />
                    Kite &amp; Co
                  </div>
                  <div className="li">
                    <i className="dot amber" />
                    Mehta Sweets
                  </div>
                  <div className="li">
                    <i className="dot green" />
                    Tara Jewels
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="sb">
            <div>
              <div className="no">03</div>
              <h3>One place per client.</h3>
              <p>
                One workspace, one client, one chat. Briefs, posts, files and the plan live there.
                Nobody asks &quot;which group was that in?&quot;
              </p>
            </div>
            <div className="vis">
              <div className="ws">
                <div>
                  <i className="dot acc" />
                  Kite &amp; Co<span>2 in review</span>
                </div>
                <div>
                  <i className="dot amber" />
                  Mehta Sweets<span>plan shared</span>
                </div>
                <div>
                  <i className="dot green" />
                  Tara Jewels<span>1 brief</span>
                </div>
              </div>
            </div>
          </div>

          <div className="sb">
            <div>
              <div className="no">04</div>
              <h3>Nothing waits on you.</h3>
              <p>
                A catch-up at 10:30 and 3:30, weekdays, only when something moved. You can stop
                checking, because it checks for you.
              </p>
            </div>
            <div className="vis">
              <div className="clockv">
                <div className="t">
                  <b>10:30</b>
                  <span>2 reviews, 1 brief</span>
                </div>
                <div className="t">
                  <b>15:30</b>
                  <span>4 comments, 1 missed chat</span>
                </div>
                <div className="t off">
                  <b>Sat</b>
                  <span>Nothing sent</span>
                </div>
                <div className="t off">
                  <b>Sun</b>
                  <span>Nothing sent</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Close() {
  return (
    <section className="close">
      <div className="wrap">
        <h2 className="d">
          Get your client work <em>sorted.</em>
        </h2>
        <CtaPair />
        <div className="note">{TRIAL_NOTE}</div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer>
      <div className="wrap">
        <Wordmark />
        <ul>
          <li>
            <a href="#features">Product</a>
          </li>
          <li>
            <a href={DEMO_MAILTO}>Book a demo</a>
          </li>
          <li>
            <a href="mailto:support@srtd.io">Contact</a>
          </li>
          <li>
            <Link to="/legal/privacy-policy">Privacy</Link>
          </li>
          <li>
            <Link to="/legal/terms-and-conditions">Terms</Link>
          </li>
        </ul>
        <span className="cp">© 2026 Sorted · Made in Mumbai</span>
      </div>
    </footer>
  );
}

export function HomePage() {
  useForceLight();
  return (
    <div className="home">
      <Header />
      <main>
        <Hero />
        <HomeFilm />
        <FeatureRail />
        <SignupBand />
        <BenefitStack />
        <Close />
      </main>
      <Footer />
    </div>
  );
}

export default HomePage;
