// One tip for a client's first review, never a tour. Hidden for good once they
// close it (per device, localStorage); the approve confirm still follows.

import { useState, type ReactElement } from 'react';

const KEY = 'sorted-first-review-tip-hidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function FirstReviewTip(): ReactElement | null {
  const [hidden, setHidden] = useState(readHidden);
  if (hidden) return null;
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-lg bg-accent-soft px-3.5 py-3 text-sm text-fg">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        className="mt-0.5 shrink-0 text-accent"
        aria-hidden="true"
      >
        <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" />
      </svg>
      <p className="min-w-0 flex-1 [text-wrap:pretty]">
        <span className="block font-semibold">Your first review</span>
        Approve it if it&apos;s ready. If not, tap the image to pin a comment on the exact spot.
      </p>
      <button
        type="button"
        aria-label="Hide tip"
        onClick={() => {
          try {
            localStorage.setItem(KEY, '1');
          } catch {
            // Storage blocked: hidden for this session only.
          }
          setHidden(true);
        }}
        className="-mr-2 -mt-2 grid h-11 w-11 shrink-0 place-items-center rounded-md text-fg-2 hover:text-fg"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
