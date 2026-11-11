import { Input } from '@/components/ui/input';

// Small pieces the operator screens share. The sign-in screens keep their own copies
// (src/app/(auth)/sign-in/[address]/sign-in-screen.tsx), so this step edits none of that file.

export function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: string } & Omit<React.ComponentProps<typeof Input>, 'id'>) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <Input id={id} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="text-sm">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function ErrorMessage({ text }: { text: string | null }) {
  return (
    <p role="alert" className="text-sm font-medium text-red-800 empty:hidden">
      {text ?? ''}
    </p>
  );
}

export function StatusMessage({ text }: { text: string | null }) {
  return (
    <p role="status" className="text-sm empty:hidden">
      {text ?? ''}
    </p>
  );
}

// One block of a screen: a heading and its content, set apart from the next.
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${title.replace(/\W+/g, '-').toLowerCase()}-heading`} className="flex flex-col gap-3 border-t pt-5">
      <h2 id={`${title.replace(/\W+/g, '-').toLowerCase()}-heading`} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function roleName(role: string): string {
  return role === 'owner' ? 'Owner' : role === 'estimator' ? 'Estimator' : role === 'office' ? 'Office' : role;
}
