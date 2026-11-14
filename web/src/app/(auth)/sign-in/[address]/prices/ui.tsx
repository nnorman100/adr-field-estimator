'use client';

import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';

// Small form pieces of the Prices screens, at phone width: a label above its field, help text tied
// to the field, 44 px controls, 16 px text. A price field keeps exactly what was typed; the server
// checks it when the owner saves and says what is wrong.

export function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex scroll-mt-4 flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Hint({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p id={id} className="text-sm text-foreground/75">
      {children}
    </p>
  );
}

type TextProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
  maxLength?: number;
};

export function TextField({ label, value, onChange, hint, disabled, maxLength }: TextProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

// A money, percent or multiplier field: a decimal written as text ("12.50"), with the number keypad.
export function DecimalField({ label, value, onChange, hint, disabled, prefix }: TextProps & { prefix?: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        {prefix ? <span aria-hidden="true">{prefix}</span> : null}
        <Input
          id={id}
          value={value}
          disabled={disabled}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          pattern="\d+(\.\d+)?"
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="[&:user-invalid]:border-red-700"
          onChange={(event) => onChange(event.target.value.trim())}
        />
      </div>
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

// A whole number of square feet or days. What was typed stays on screen; the table only changes
// when it is a whole number (or blank, where blank is allowed).
export function WholeField({
  label,
  value,
  onChange,
  hint,
  disabled,
  allowBlank = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  hint?: string;
  disabled?: boolean;
  allowBlank?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [shown, setShown] = useState(value);
  // The table changed elsewhere (a reload, a restore): show its value.
  if (shown !== value) {
    setShown(value);
    setText(value === null ? '' : String(value));
  }
  const valid = /^\d{1,6}$/.test(text) || (allowBlank && text === '');
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        value={text}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="off"
        aria-invalid={valid ? undefined : true}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => {
          const next = event.target.value.trim();
          setText(next);
          if (allowBlank && next === '') {
            setShown(null);
            onChange(null);
          } else if (/^\d{1,6}$/.test(next)) {
            setShown(Number(next));
            onChange(Number(next));
          }
        }}
      />
      {valid ? null : <Hint>Use a whole number.</Hint>}
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex min-h-11 items-center gap-3">
        <input
          id={id}
          type="checkbox"
          className="size-5 shrink-0"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <label htmlFor={id} className="text-base">
          {label}
        </label>
      </div>
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}

export function RadioGroup<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  hint,
}: {
  legend: string;
  name: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-1" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      {options.map((option) => (
        <div key={option.value} className="flex min-h-11 items-center gap-3">
          <input
            id={`${id}-${option.value}`}
            type="radio"
            name={`${name}-${id}`}
            className="size-5 shrink-0"
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <label htmlFor={`${id}-${option.value}`}>{option.label}</label>
        </div>
      ))}
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </fieldset>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="h-11 w-full rounded-md border border-foreground/40 bg-background px-3 text-base"
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <Hint id={`${id}-hint`}>{hint}</Hint> : null}
    </div>
  );
}
