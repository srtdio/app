import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomeEntry } from '@/components/home/HomeEntry';

// Homepage fixture: the harness keeps "/" as its smoke page, so specs serve
// this document for "/" (see e2e/tests/home-pages.spec.ts) to mount the
// homepage exactly as the guest path does: HomeEntry, no app CSS, no router.
const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('home fixture root element missing');
createRoot(rootEl).render(
  <StrictMode>
    <HomeEntry />
  </StrictMode>,
);
