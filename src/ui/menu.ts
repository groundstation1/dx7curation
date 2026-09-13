/*
 * A pulldown whose options can say what they are.
 *
 * A native select holds one line of unstyled text per option, so an
 * explanation has to be glued onto the label with a dash and set in the same
 * weight and colour as the name - which turns a list of nine views into nine
 * paragraphs to read, and the name you are hunting for stops being the thing
 * your eye lands on. The explanation is worth having exactly there, while you
 * are choosing; it just has to look like an explanation.
 *
 * So: a button that shows the current choice by name, and a panel of rows,
 * each a name with secondary text under it. Everything else about it is the
 * behaviour people already expect from a select - click outside to dismiss,
 * Escape to cancel, arrows to move, Enter to take it - because a control that
 * looks like a pulldown and does not behave like one is worse than the plain
 * one it replaced.
 */
import { el } from './dom.ts';

export interface MenuOption {
  value: string;
  label: string;
  /** The secondary line. Optional: an option can be self-explanatory. */
  note?: string;
  disabled?: boolean;
}

export interface MenuOptions {
  value: string;
  options: MenuOption[];
  onChange: (value: string) => void;
  /** Tooltip for the closed button. */
  title?: string;
  /** Width of the open panel. */
  width?: number;
}

export function richSelect(opts: MenuOptions): HTMLElement {
  const current = opts.options.find((o) => o.value === opts.value);
  const wrap = el('div', { class: 'rsel' });

  const button = el('button', {
    class: 'rsel-btn',
    type: 'button',
    title: opts.title ?? '',
    'aria-haspopup': 'listbox',
    'aria-expanded': 'false',
  }, el('span', { class: 'rsel-label' }, current?.label ?? opts.value), el('span', { class: 'rsel-caret' })) as HTMLButtonElement;

  const panel = el('div', {
    class: 'rsel-pop',
    role: 'listbox',
    hidden: true,
    style: opts.width ? { width: `${opts.width}px` } : {},
  });

  let open = false;
  let active = Math.max(0, opts.options.findIndex((o) => o.value === opts.value));

  const rows: HTMLElement[] = opts.options.map((o, i) => {
    const row = el('div', {
      class: o.value === opts.value ? 'rsel-row on' : 'rsel-row',
      role: 'option',
      'aria-selected': o.value === opts.value ? 'true' : 'false',
      onclick: () => {
        if (o.disabled) return;
        close();
        if (o.value !== opts.value) opts.onChange(o.value);
      },
      onpointerenter: () => setActive(i),
    },
      el('div', { class: 'rsel-name' }, o.label),
      o.note ? el('div', { class: 'rsel-note' }, o.note) : null,
    );
    if (o.disabled) row.classList.add('off');
    panel.appendChild(row);
    return row;
  });

  function setActive(i: number): void {
    active = Math.max(0, Math.min(rows.length - 1, i));
    rows.forEach((r, k) => r.classList.toggle('hot', k === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  }

  // Listeners live only while the panel is open: a menu that is shut has no
  // business holding a handler on the document.
  const onDocPointer = (e: Event) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      button.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const choice = opts.options[active];
      close();
      if (choice && !choice.disabled && choice.value !== opts.value) opts.onChange(choice.value);
    }
  };

  function show(): void {
    if (open) return;
    open = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    wrap.classList.add('open');
    setActive(active);
    // Deferred, or the click that opened it closes it again.
    setTimeout(() => document.addEventListener('pointerdown', onDocPointer), 0);
    document.addEventListener('keydown', onKey, true);
  }

  function close(): void {
    if (!open) return;
    open = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    wrap.classList.remove('open');
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onKey, true);
  }

  button.onclick = () => (open ? close() : show());
  wrap.appendChild(button);
  wrap.appendChild(panel);
  return wrap;
}
