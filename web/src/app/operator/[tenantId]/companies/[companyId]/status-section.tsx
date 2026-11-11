'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { platformPaths, type CompanyAnswer, type CompanyView } from '@/lib/operator/client';
import { STATUS_LABELS, statusActions, type StatusAction } from '@/lib/operator/screens';
import { useOperator } from '../../operator-session';
import { Section, StatusMessage } from '../../ui';
import { useAction } from '../../use-action';

// Suspend, reactivate or archive. Only what the server would accept is offered: archive appears
// for a suspended company and for no other. Suspending and archiving ask for a confirmation first.
export function StatusSection({ company }: { company: CompanyView }) {
  const { call, reload } = useOperator();
  const [pending, setPending] = useState<StatusAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const action = useAction();

  function apply(change: StatusAction) {
    setDone(null);
    void action.run(
      () => call<CompanyAnswer>(platformPaths.status(company.id), { method: 'POST', body: { status: change.to } }),
      async (body) => {
        setPending(null);
        await reload();
        setDone(`${body.company.name} is now ${STATUS_LABELS[body.company.status].toLowerCase()}.`);
      },
    );
  }

  return (
    <Section title="Status">
      <p>
        This company is <strong>{STATUS_LABELS[company.status].toLowerCase()}</strong>.
      </p>
      {pending ? (
        <div className="flex flex-col gap-3 rounded-md border p-3" role="group" aria-label={`Confirm ${pending.label.toLowerCase()}`}>
          <p>{pending.confirm}</p>
          <div className="flex flex-wrap gap-3">
            <Button disabled={action.busy} onClick={() => apply(pending)}>
              Confirm {pending.label.toLowerCase()}
            </Button>
            <Button variant="outline" disabled={action.busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {statusActions(company.status).map((change) => (
            <Button
              key={change.to}
              variant="outline"
              disabled={action.busy}
              onClick={() => {
                setDone(null);
                action.clear();
                if (change.confirm) setPending(change);
                else apply(change);
              }}
            >
              {change.label}
            </Button>
          ))}
        </div>
      )}
      {action.problem}
      <StatusMessage text={done} />
    </Section>
  );
}
