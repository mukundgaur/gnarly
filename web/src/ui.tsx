import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Evaluates plain arithmetic like `2.5*3` or `(4-1)/2`; anything else is rejected. */
export function evaluate(text: string): number | undefined {
  const source = text.trim().replace(/,/g, '.');
  if (!source || !/^[0-9+\-*/().\s]+$/.test(source)) return undefined;
  try {
    const value = Function('"use strict";return (' + source + ')')() as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch { return undefined; }
}

const roundTo = (value: number, precision: number) => Math.round(value * 10 ** precision) / 10 ** precision;

/**
 * A numeric field in the style of CAD tools: drag the label to scrub (Shift for fine, Alt for coarse),
 * use the arrow keys to step, or type a value or expression. Changes stream through `onChange`.
 */
export function ScrubField({ label, value, unit, step = .01, precision = 2, min, max, disabled, onChange, wide }: {
  label: string; value: number; unit?: string; step?: number; precision?: number; min?: number; max?: number; disabled?: boolean; wide?: boolean;
  onChange: (value: number) => void;
}) {
  const [text, setTextState] = useState<string | null>(null);
  const draft = useRef<string | null>(null);
  const setText = (next: string | null) => { draft.current = next; setTextState(next); };
  const [scrubbing, setScrubbing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const clamp = (next: number) => roundTo(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)), precision);
  const commit = () => {
    const typed = draft.current;
    if (typed === null) return;
    setText(null);
    const next = evaluate(typed);
    if (next !== undefined && clamp(next) !== value) onChange(clamp(next));
  };
  const shown = text ?? (Number.isFinite(value) ? roundTo(value, precision).toFixed(precision) : '');
  return <label className={'scrub' + (scrubbing ? ' scrubbing' : '') + (wide ? ' wide' : '') + (disabled ? ' disabled' : '')}>
    <span className="scrub-label" title="Drag to adjust · Shift for fine · Alt for coarse"
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, start: value, moved: false };
      }}
      onPointerMove={event => {
        const current = drag.current;
        if (!current) return;
        const dx = event.clientX - current.x;
        if (!current.moved && Math.abs(dx) < 3) return;
        if (!current.moved) { current.moved = true; setScrubbing(true); }
        const factor = event.shiftKey ? .1 : event.altKey ? 10 : 1;
        const next = clamp(current.start + Math.round(dx / 2) * step * factor);
        if (next !== value) onChange(next);
      }}
      onPointerUp={event => {
        const current = drag.current;
        drag.current = null;
        setScrubbing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        if (current && !current.moved) input.current?.focus();
      }}>{label}</span>
    <input ref={input} inputMode="decimal" value={shown} disabled={disabled} aria-label={label}
      onFocus={event => { setText(shown); requestAnimationFrame(() => event.target.select()); }}
      onChange={event => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') { commit(); event.currentTarget.blur(); return; }
        if (event.key === 'Escape') { setText(null); requestAnimationFrame(() => input.current?.blur()); return; }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const factor = event.shiftKey ? 10 : event.altKey ? .1 : 1;
          const base = text !== null ? evaluate(text) ?? value : value;
          const next = clamp(base + (event.key === 'ArrowUp' ? 1 : -1) * step * factor);
          setText(next.toFixed(precision));
          onChange(next);
        }
      }} />
    {unit && <span className="scrub-unit">{unit}</span>}
  </label>;
}

/** A text box that edits a name in place: Enter or leaving it saves, Esc cancels. `onDone(null)` means cancelled. */
export function InlineRename({ value, placeholder, onDone, className }: { value: string; placeholder?: string; onDone: (name: string | null) => void; className?: string }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (name: string | null) => { if (done.current) return; done.current = true; onDone(name); };
  return <input className={'inline-rename' + (className ? ' ' + className : '')} value={text} placeholder={placeholder} aria-label="Rename" autoFocus spellCheck={false}
    ref={input => { if (input && !input.dataset.selected) { input.dataset.selected = '1'; requestAnimationFrame(() => input.select()); } }}
    onChange={event => setText(event.target.value)}
    onBlur={() => finish(text)}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => event.stopPropagation()}
    onPointerDown={event => event.stopPropagation()}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(text); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(null); }
    }} />;
}

export type SearchOption = { value: string; label: string; detail?: string; color?: string; group?: string };

/** Searchable list box with keyboard navigation. Shows the chosen option's label when not focused. */
export function PlaceSearch({ options, value, onChange, placeholder = 'Search', icon, clearable, autoFocus, dot }: {
  options: SearchOption[]; value: string; onChange: (value: string) => void; placeholder?: string; icon?: ReactNode; clearable?: boolean; autoFocus?: boolean; dot?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const current = options.find(option => option.value === value);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => words.every(word => (option.label + ' ' + (option.detail || '') + ' ' + (option.group || '')).toLowerCase().includes(word))).slice(0, 60);
  }, [options, query]);
  useEffect(() => { setActive(0); }, [query, open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as globalThis.Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const choose = (option?: SearchOption) => { if (!option) return; onChange(option.value); setOpen(false); setQuery(''); };
  return <div className={'place-search' + (open ? ' open' : '')} ref={box}>
    <div className="place-search-field">
      {dot ? <span className="place-dot" style={{ background: dot }} /> : icon ?? <Search size={15} />}
      <input role="combobox" aria-expanded={open} aria-controls={id} aria-autocomplete="list" placeholder={current ? current.label : placeholder} autoFocus={autoFocus}
        value={open ? query : current?.label ?? ''}
        onFocus={() => setOpen(true)}
        onChange={event => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(matches.length - 1, index + 1)); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); choose(matches[active]); (event.target as HTMLInputElement).blur(); }
          else if (event.key === 'Escape') { setOpen(false); setQuery(''); (event.target as HTMLInputElement).blur(); }
        }} />
      {clearable && value && <button className="place-clear" aria-label="Clear" onClick={() => onChange('')}><X size={13} /></button>}
    </div>
    {open && <ul className="place-results" id={id} role="listbox">
      {matches.length ? matches.map((option, index) => <li key={option.value} role="option" aria-selected={index === active} className={index === active ? 'active' : ''}
        onPointerEnter={() => setActive(index)} onPointerDown={event => { event.preventDefault(); choose(option); }}>
        <span className="place-dot" style={{ background: option.color || '#5ec8ff' }} />
        <span className="place-text"><strong>{option.label}</strong>{(option.detail || option.group) && <small>{[option.group, option.detail].filter(Boolean).join(' · ')}</small>}</span>
      </li>) : <li className="place-empty">No matches</li>}
    </ul>}
  </div>;
}

/** A labeled icon button with a tooltip showing its shortcut. */
export function ToolButton({ icon, label, shortcut, active, disabled, onClick, tone }: {
  icon: ReactNode; label: string; shortcut?: string; active?: boolean; disabled?: boolean; onClick: () => void; tone?: 'accent' | 'warn';
}) {
  return <button className={'tool' + (active ? ' active' : '') + (tone ? ' ' + tone : '')} disabled={disabled} onClick={onClick} aria-label={label} aria-pressed={active}
    data-tip={label + (shortcut ? '  ' + shortcut : '')}>{icon}</button>;
}

export function Section({ title, icon, children, defaultOpen = true, extra }: { title: string; icon?: ReactNode; children: ReactNode; defaultOpen?: boolean; extra?: ReactNode }) {
  return <details className="section" open={defaultOpen}>
    <summary>{icon}<span>{title}</span>{extra && <span className="section-extra" onClick={event => event.preventDefault()}>{extra}</span>}</summary>
    <div className="section-body">{children}</div>
  </details>;
}
