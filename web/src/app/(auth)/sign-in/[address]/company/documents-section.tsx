'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { newRowKey, type DocumentsDraft } from '@/lib/profile/documents-draft';
import { DOCUMENT_LIMITS } from '@/lib/profile/settings';

// The Documents part of Company settings (S5a-4b): how this company's documents are laid out and
// worded. Every company sets its own; a new company starts at the neutral defaults (itemized
// proposal, no clauses or prep tasks, photos by room, no authorization or payment terms, no
// previous price). Each setting has a plain example. It is part of the one settings form, so the
// one "Save company settings" button saves it with the letterhead.

const TEXTAREA =
  'w-full rounded-md border border-foreground/40 bg-background p-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';
const CHOICE = 'flex items-start gap-2 py-1';
const CONTROL = 'mt-1 size-5 shrink-0';

export function DocumentsSection({
  draft,
  busy,
  onChange,
}: {
  draft: DocumentsDraft;
  busy: boolean;
  onChange: (next: DocumentsDraft) => void;
}) {
  const set = (patch: Partial<DocumentsDraft>) => onChange({ ...draft, ...patch });
  const clauses = draft.company_clauses;
  const tasks = draft.prep_tasks;

  return (
    <section aria-labelledby="documents-heading" className="flex flex-col gap-4">
      <h2 id="documents-heading" className="text-lg font-semibold">
        Documents
      </h2>

      <fieldset className="flex flex-col gap-1" disabled={busy}>
        <legend className="font-medium">Proposal layout</legend>
        <label className={CHOICE}>
          <input
            type="radio"
            name="proposal_layout"
            className={CONTROL}
            checked={draft.proposal_layout === 'itemized'}
            onChange={() => set({ proposal_layout: 'itemized' })}
          />
          <span>
            Itemized: each room&apos;s work as a list of lines with quantities, for example
            &ldquo;Kitchen: remove drywall, up to 40 sq ft&rdquo;.
          </span>
        </label>
        <label className={CHOICE}>
          <input
            type="radio"
            name="proposal_layout"
            className={CONTROL}
            checked={draft.proposal_layout === 'letter'}
            onChange={() => set({ proposal_layout: 'letter' })}
          />
          <span>
            Letter: a plain letter naming the area inspected, what was found in each room and the
            recommended work with &ldquo;up to&rdquo; quantities.
          </span>
        </label>
        <p className="text-sm">
          Whether each line&apos;s price shows on the proposal is set on the Prices page.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3" disabled={busy}>
        <legend className="font-medium">Your own clauses</legend>
        <p className="text-sm">
          Up to {DOCUMENT_LIMITS.clauses} paragraphs of your own, printed exactly as you type them
          after the recommendations and before the standard clauses. For example, the title
          &ldquo;Scheduling&rdquo; with &ldquo;We confirm the start date by phone two days before
          work begins.&rdquo;
        </p>
        {clauses.map((clause, index) => {
          const id = `clause-${clause.key}`;
          const update = (patch: Partial<typeof clause>) =>
            set({ company_clauses: clauses.map((c) => (c.key === clause.key ? { ...c, ...patch } : c)) });
          return (
            <div key={clause.key} className="flex flex-col gap-1 rounded-md border border-foreground/40 p-3">
              <label htmlFor={`${id}-title`} className="font-medium">
                Clause {index + 1} title
              </label>
              <Input
                id={`${id}-title`}
                name={`${id}-title`}
                type="text"
                autoComplete="off"
                value={clause.title}
                onChange={(event) => update({ title: event.target.value })}
              />
              <label htmlFor={`${id}-text`} className="font-medium">
                Clause {index + 1} text
              </label>
              <textarea
                id={`${id}-text`}
                name={`${id}-text`}
                rows={4}
                className={TEXTAREA}
                value={clause.text}
                onChange={(event) => update({ text: event.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => set({ company_clauses: clauses.filter((c) => c.key !== clause.key) })}
              >
                Remove clause {index + 1}
              </Button>
            </div>
          );
        })}
        <Button
          type="button"
          variant="outline"
          disabled={clauses.length >= DOCUMENT_LIMITS.clauses}
          onClick={() => set({ company_clauses: [...clauses, { key: newRowKey(), title: '', text: '' }] })}
        >
          Add a clause
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-3" disabled={busy}>
        <legend className="font-medium">Prep tasks</legend>
        <p className="text-sm">
          Up to {DOCUMENT_LIMITS.prepTasks} tasks the homeowner does before work starts, which an
          estimator can add to a room. For example &ldquo;The homeowner removes the contents of the
          closet before the start date.&rdquo;
        </p>
        {tasks.map((task, index) => (
          <div key={task.key} className="flex flex-col gap-1">
            <label htmlFor={`prep-task-${task.key}`} className="font-medium">
              Prep task {index + 1}
            </label>
            <Input
              id={`prep-task-${task.key}`}
              name={`prep-task-${task.key}`}
              type="text"
              autoComplete="off"
              value={task.text}
              onChange={(event) =>
                set({ prep_tasks: tasks.map((t) => (t.key === task.key ? { ...t, text: event.target.value } : t)) })
              }
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => set({ prep_tasks: tasks.filter((t) => t.key !== task.key) })}
            >
              Remove prep task {index + 1}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={tasks.length >= DOCUMENT_LIMITS.prepTasks}
          onClick={() => set({ prep_tasks: [...tasks, { key: newRowKey(), text: '' }] })}
        >
          Add a prep task
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-1" disabled={busy}>
        <legend className="font-medium">Photo log</legend>
        <label className={CHOICE}>
          <input
            type="radio"
            name="photo_log_grouping"
            className={CONTROL}
            checked={draft.photo_log_grouping === 'room'}
            onChange={() => set({ photo_log_grouping: 'room' })}
          />
          <span>By room: the kitchen&apos;s photos together, then the hallway&apos;s, and so on.</span>
        </label>
        <label className={CHOICE}>
          <input
            type="radio"
            name="photo_log_grouping"
            className={CONTROL}
            checked={draft.photo_log_grouping === 'shot_tag'}
            onChange={() => set({ photo_log_grouping: 'shot_tag' })}
          />
          <span>By kind of shot: every moisture reading together, then every damage photo, and so on.</span>
        </label>
      </fieldset>

      <SigningText
        id="documents-authorization"
        label="Start-work authorization"
        hint="Printed on the signed page. Needed before a customer can sign. For example: “I authorize the work described in this estimate to begin.”"
        value={draft.authorization_text}
        busy={busy}
        onChange={(authorization_text) => set({ authorization_text })}
      />
      <SigningText
        id="documents-payment-terms"
        label="Payment terms"
        hint="Printed on the signed page. Needed before a customer can sign. For example: “Payment is due within 30 days of completion.”"
        value={draft.payment_terms_text}
        busy={busy}
        onChange={(payment_terms_text) => set({ payment_terms_text })}
      />

      <div className="flex flex-col gap-1">
        <label className={CHOICE}>
          <input
            type="checkbox"
            name="show_previous_price"
            className={CONTROL}
            disabled={busy}
            aria-describedby="documents-previous-price-hint"
            checked={draft.show_previous_price}
            onChange={(event) => set({ show_previous_price: event.target.checked })}
          />
          <span className="font-medium">Show the previous price on a revised estimate</span>
        </label>
        <span id="documents-previous-price-hint" className="text-sm">
          For example &ldquo;Revised 3/14: was $4,200.00&rdquo; under the new price.
        </span>
      </div>
    </section>
  );
}

function SigningText({
  id,
  label,
  hint,
  value,
  busy,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name={id}
        rows={5}
        aria-describedby={`${id}-hint`}
        disabled={busy}
        className={TEXTAREA}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={`${id}-hint`} className="text-sm">
        {hint}
      </span>
    </div>
  );
}
