// Prototype entry. Imports the app's index.css (tokens, fonts, lighting) and
// sets the theme from ?theme=dark|light (the app's own .dark class). No
// providers, no reads, no Sentry.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { ConceptLinkPrototype } from './ConceptLinkPrototype';

const theme = new URLSearchParams(window.location.search).get('theme');
document.documentElement.classList.toggle('dark', theme === 'dark');

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <ConceptLinkPrototype />
    </StrictMode>,
  );
}
