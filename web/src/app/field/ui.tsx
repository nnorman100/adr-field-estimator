'use client';

import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { hrefOf, type FieldPlace } from '@/lib/field/views';

// Small pieces the job screens share (S5a-6), sized for a phone: 44 px controls, 16 px text so iOS
// Safari does not zoom, a label tied to every box, and errors tied to their box.

// Moves to another field view inside the one shell page, without asking the server for a page.
export function go(place: FieldPlace) {
  window.history.pushState(null, '', hrefOf(place));
}

export function FieldLink({ to, children, className, current }: { to: FieldPlace; children: ReactNode; className?: string; current?: boolean }) {
  return (
    <a
      href={hrefOf(to)}
      aria-current={current ? 'page' : undefined}
      className={cn('inline-flex min-h-11 items-center underline', className)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}

type BoxProps = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  error?: string;
  hint?: string;
  // `decimal` and `numeric` open the number keyboard without a spinner (type=number drops input
  // the phone cannot parse and changes on scroll).
  inputMode?: 'decimal' | 'numeric' | 'email' | 'tel' | 'text';
  type?: 'text' | 'email' | 'tel' | 'date';
  autoComplete?: string;
};

export function Box({ id, label, value, onChange, readOnly, error, hint, inputMode, type = 'text', autoComplete }: BoxProps) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-sm">
          {hint}
        </p>
      ) : null}
      <Input
        id={id}
        type={type}
        value={value}
        readOnly={readOnly}
        inputMode={inputMode}
        autoComplete={autoComplete ?? 'off'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={readOnly ? 'bg-foreground/5' : undefined}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Tick({ id, label, checked, onChange, readOnly }: { id: string; label: string; checked: boolean; onChange: (checked: boolean) => void; readOnly?: boolean }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <input
        id={id}
        type="checkbox"
        className="size-6"
        checked={checked}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label htmlFor={id} className="text-base">
        {label}
      </label>
    </div>
  );
}

export function Choice({
  id,
  label,
  value,
  options,
  onChange,
  readOnly,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={readOnly}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full rounded-md border border-foreground/40 bg-background px-3 text-base disabled:bg-foreground/5"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// One line under a form: what went wrong (an alert) or what happened (a status).
export function Outcome({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
        {error ?? ''}
      </p>
      <p role="status" className="text-sm empty:hidden">
        {notice ?? ''}
      </p>
    </>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-foreground/20 pt-4">
      <h3 className="text-lg font-semibold">{title}</h3>
      {children}
    </section>
  );
}
