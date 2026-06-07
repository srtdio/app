import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSearch } from '@/components/ui/icons';
import { dispatchSorted } from '@/lib/events';
import { cn } from '@/lib/cn';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface PaletteItem {
  id: string;
  group: 'Go to' | 'Actions';
  label: string;
  run: () => void;
}

const GROUPS: Array<PaletteItem['group']> = ['Go to', 'Actions'];

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const items = useMemo<PaletteItem[]>(
    () => [
      { id: 'goto-pipeline', group: 'Go to', label: 'Pipeline', run: () => navigate('/pipeline') },
      { id: 'goto-briefs', group: 'Go to', label: 'Briefs', run: () => navigate('/briefs') },
      { id: 'goto-activity', group: 'Go to', label: 'Activity', run: () => navigate('/activity') },
      {
        id: 'new-post',
        group: 'Actions',
        label: 'New post',
        run: () => dispatchSorted('sorted:create-post'),
      },
      {
        id: 'new-brief',
        group: 'Actions',
        label: 'New brief',
        run: () => dispatchSorted('sorted:create-brief'),
      },
    ],
    [navigate],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items;
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) {
    return null;
  }

  function runItem(item: PaletteItem | undefined): void {
    if (item === undefined) {
      return;
    }
    onClose();
    item.run();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => Math.min(value + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(value - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runItem(filtered[active]);
    }
  }

  function onOverlayClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/45 flex items-start justify-center pt-[12vh] px-4"
      onClick={onOverlayClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-[560px] rounded-xl border border-border-strong bg-panel shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2.5 px-4 border-b border-border">
          <IconSearch size={18} className="text-fg-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search or jump to"
            className="flex-1 h-12 bg-transparent outline-none text-sm placeholder:text-fg-3"
          />
          <kbd className="text-[11px] text-fg-3 border border-border rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-fg-3">No results</div>
          ) : (
            GROUPS.map((group) => {
              const groupItems = filtered.filter((item) => item.group === group);
              if (groupItems.length === 0) {
                return null;
              }
              return (
                <div key={group} className="px-2 pb-1">
                  <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-3">
                    {group}
                  </div>
                  {groupItems.map((item) => {
                    const index = filtered.indexOf(item);
                    const isActive = index === active;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onMouseEnter={() => setActive(index)}
                        onClick={() => runItem(item)}
                        className={cn(
                          'flex w-full items-center min-h-[44px] px-2 rounded-md text-sm text-left transition-colors',
                          isActive ? 'bg-panel-2 text-fg' : 'text-fg-2',
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
