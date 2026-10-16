import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { DEMO_HREF } from './config';
import { FEATURES, featureId, showFeature, type FeatureKey } from './features';
import { Wordmark } from './Wordmark';

// The header, sidebar and footer shared by / and /demo. There is no
// router on the home bundle, so every link is a plain anchor: on / the sidebar
// tiles scroll in place, elsewhere they load "/#feature-<key>".

export type HomeSurface = 'home' | 'demo';

interface Story {
  badge: string;
  tag: string;
  title: string;
}

/** Sidebar stories: coming soon, so cards only (no links, no route). */
export const STORIES: readonly Story[] = [
  {
    badge: '7',
    tag: 'Funny story',
    title: 'The logo the client approved, seven versions after we sent the right one',
  },
  {
    badge: '43',
    tag: 'Funny story',
    title: 'One caption, 43 messages, and a thumbs up nobody could explain',
  },
  { badge: 'v3', tag: 'Blog', title: 'Why every agency has a file called final_FINAL_v3' },
];

/** A homepage anchor: in place on /, a full load of "/#..." elsewhere. Pure. */
export function homeHref(surface: HomeSurface, hash: string): string {
  return surface === 'home' ? hash : `/${hash}`;
}

export function Tick() {
  return (
    <svg className="tick" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

/** /demo: back to "/" (the app, for a signed-in visitor). */
export function BackHome() {
  return (
    <a className="back" href="/">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" />
      </svg>
      Back to home
    </a>
  );
}

function Menu({
  surface,
  open,
  onClose,
  onFeature,
}: {
  surface: HomeSurface;
  open: boolean;
  onClose: () => void;
  onFeature: (key: FeatureKey) => void;
}) {
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

  const onTile = (event: MouseEvent<HTMLAnchorElement>, key: FeatureKey): void => {
    if (surface !== 'home') return;
    event.preventDefault();
    onFeature(key);
  };

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
          <a className="logo" href={homeHref(surface, '#top')} aria-label="srtd home">
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

        <div className="nav-feat">
          {FEATURES.map((feature) => (
            <a
              key={feature.key}
              className={feature.wide === true ? `${feature.tone} wide` : feature.tone}
              href={homeHref(surface, `#${featureId(feature.key)}`)}
              data-feature-tile={feature.key}
              onClick={(e) => onTile(e, feature.key)}
            >
              {feature.name}
              <small>{feature.sub}</small>
            </a>
          ))}
        </div>

        <div className="nav-main">
          <a href={homeHref(surface, '#why')}>Why Sorted</a>
          <a href={DEMO_HREF}>
            Book a demo <span>30 min</span>
          </a>
        </div>

        <ul className="stories">
          {STORIES.map((story) => (
            <li key={story.badge} className="story">
              <span className="badge" aria-hidden="true">
                {story.badge}
              </span>
              <span className="st">
                <span className="tag">{story.tag}</span>
                <span className="title">{story.title}</span>
              </span>
              <span className="soon">Coming soon</span>
            </li>
          ))}
        </ul>

        <div className="foot">
          <a className="btn ghost" href="/signin">
            Sign in
          </a>
          <a className="btn" href="/signup">
            Sign up free
          </a>
        </div>
      </nav>
    </div>
  );
}

/**
 * Header, sidebar, the page's <main> and the footer. On / a tile closes the
 * menu, then the page scrolls to the rail and the rail to that card.
 */
export function SiteShell({ surface, children }: { surface: HomeSurface; children: ReactNode }) {
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

  const onFeature = useCallback((key: FeatureKey) => {
    // Wait for the menu to close and give the page its scroll back.
    requestAnimationFrame(() => {
      window.history.replaceState(null, '', `#${featureId(key)}`);
      showFeature(key, 'smooth');
    });
  }, []);

  return (
    <div className="home">
      <header className={scrolled ? 'top on' : 'top'} id="top">
        <div className="wrap">
          <a className="logo" href={homeHref(surface, '#top')} aria-label="srtd home">
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

      <Menu surface={surface} open={menuOpen} onClose={closeMenu} onFeature={onFeature} />

      <main>{children}</main>

      <footer>
        <div className="wrap">
          <a className="logo" href={homeHref(surface, '#top')} aria-label="srtd home">
            <Wordmark />
          </a>
          <ul>
            <li>
              <a href={homeHref(surface, '#features')}>Product</a>
            </li>
            <li>
              <a href={DEMO_HREF}>Book a demo</a>
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
