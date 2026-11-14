import type { EstimateEnd } from '@/engine/estimate';
import type { EstimateView } from '@/lib/estimates/result';
import { chargeRows, dollars, photoLine, priceLines, quantityNoteLine, warningText } from '@/lib/estimates/screen';

// The parts of Review before signing that show the stored estimate: the price, the four documents
// and the staff-only notes. Every amount and sentence is the server's, shown as stored; the
// proposal is shown from its stored bytes, which signing binds to.

const SECTION = 'flex flex-col gap-2';
const HEADING = 'text-lg font-semibold';
const ROW = 'flex min-w-0 items-baseline justify-between gap-3';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function Charges({ end, afterHoursLabel }: { end: EstimateEnd; afterHoursLabel: string }) {
  return chargeRows(end, afterHoursLabel).map((row, index) => (
    <li key={`${index}-${row.label}`} className={ROW}>
      <span className="min-w-0 break-words">{row.label}</span>
      <span className="shrink-0 tabular-nums">{dollars(row.amount)}</span>
    </li>
  ));
}

export function EstimatePrice({ estimate }: { estimate: EstimateView }) {
  const price = priceLines(estimate.totals);
  return (
    <section aria-labelledby="review-price" className={SECTION}>
      <h2 id="review-price" className={HEADING}>
        Price
      </h2>
      <p className="text-xl font-semibold">{price.customer}</p>
      <p>{price.itemized}</p>
      {estimate.totals.mode === 'range' && estimate.totals.range_explanation ? <p className="text-sm">{estimate.totals.range_explanation}</p> : null}
      <p className="text-sm">Priced from your company&apos;s price version {estimate.price.versionSequence}.</p>
      <h3 className="font-semibold">Lines</h3>
      <ul className="flex flex-col gap-1">
        {estimate.lines.map((line, index) => (
          <li key={`${index}-${line.description}`} className={ROW}>
            <span className="min-w-0 break-words">
              {line.description}
              <span className="block text-sm">
                {line.quantity} {line.unit}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">{dollars(line.total)}</span>
          </li>
        ))}
        <Charges end={estimate.totals.low} afterHoursLabel={estimate.totals.after_hours_label} />
      </ul>
    </section>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-1 pl-5 [list-style:disc]">
      {items.map((item, index) => (
        <li key={`${index}-${item}`} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

function Proposal({ estimate }: { estimate: EstimateView }) {
  const proposal = estimate.proposal;
  const price = proposal.price;
  return (
    <div className="flex flex-col gap-2">
      <p className="font-semibold">{proposal.heading}</p>
      <p className="text-sm break-words">{proposal.letterhead.join(' · ')}</p>
      {proposal.customer_name ? <p>Customer: {proposal.customer_name}</p> : null}
      <p className="break-words">Property: {proposal.property_address}</p>
      <ul className="flex flex-col gap-1">
        {(price.lines ?? []).map((line, index) => (
          <li key={`${index}-${line.description}`} className={ROW}>
            <span className="min-w-0 break-words">{line.description}</span>
            <span className="shrink-0 tabular-nums">{dollars(line.total)}</span>
          </li>
        ))}
        <Charges end={price.low} afterHoursLabel={price.after_hours_label} />
      </ul>
      <p className="font-semibold">
        {price.mode === 'range' && price.high ? `Customer estimate range: ${dollars(price.low.total)} to ${dollars(price.high.total)}` : `Price: ${dollars(price.low.total)}`}
      </p>
      {price.explanation ? <p className="text-sm">{price.explanation}</p> : null}
      <p className="font-semibold">Findings</p>
      <List items={proposal.findings} />
      <p className="font-semibold">Proposed scope</p>
      <List items={proposal.recommendations} />
      <List items={proposal.disclaimers} />
    </div>
  );
}

export function EstimateDocuments({ estimate }: { estimate: EstimateView }) {
  const documents = estimate.documents;
  return (
    <section aria-labelledby="review-documents" className={SECTION}>
      <h2 id="review-documents" className={HEADING}>
        Documents
      </h2>
      <p className="text-sm">Open each document before signing.</p>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Proposal</summary>
        <div className="pt-3">
          <Proposal estimate={estimate} />
        </div>
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Itemized claim</summary>
        <ul className="flex flex-col gap-2 pt-3">
          {documents.itemizedClaim.map((row, index) => {
            const line = row as Record<string, unknown>;
            const note = text(line.xactimate_code);
            return (
              <li key={`${index}-${text(line.description)}`} className="flex flex-col">
                <span className={ROW}>
                  <span className="min-w-0 break-words">
                    {text(line.code)} · {text(line.description)}
                  </span>
                  <span className="shrink-0 tabular-nums">{dollars(text(line.total))}</span>
                </span>
                <span className="text-sm">
                  {text(line.quantity)} {text(line.unit)} at {text(line.unit_price)}, waste {text(line.waste_percent)}%{note ? ` · matches Xactimate line ${note}` : ''}
                </span>
              </li>
            );
          })}
          <Charges end={estimate.totals.low} afterHoursLabel={estimate.totals.after_hours_label} />
          <li className={`${ROW} font-semibold`}>
            <span>Itemized total</span>
            <span className="shrink-0 tabular-nums">{dollars(estimate.totals.low.total)}</span>
          </li>
        </ul>
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Scope defense letter</summary>
        <p className="pt-3 break-words whitespace-pre-wrap">{documents.letter}</p>
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Photo audit log</summary>
        {documents.photoLog.length ? <List items={documents.photoLog.map((photo, index) => photoLine(photo, index))} /> : <p className="pt-3">No photos.</p>}
      </details>
    </section>
  );
}

export function StaffNotes({ estimate }: { estimate: EstimateView }) {
  const notes = estimate.staffNotes;
  const checks = [...notes.warnings.engine, ...notes.warnings.advisory].map((warning) => warningText(warning));
  return (
    <section aria-labelledby="review-staff" className={SECTION}>
      <h2 id="review-staff" className={HEADING}>
        Staff-only notes
      </h2>
      <p className="text-sm">For your company only. None of these is on a document the customer or the adjuster gets.</p>
      <p className="font-semibold">Summary of findings</p>
      <p className="break-words whitespace-pre-wrap">{notes.summary}</p>
      {notes.suggestions.length ? (
        <>
          <p className="font-semibold">Suggestions outside the priced scope</p>
          <List items={notes.suggestions} />
        </>
      ) : null}
      {estimate.documents.unpricedWork.length ? (
        <>
          <p className="font-semibold">Work with no price</p>
          <List items={estimate.documents.unpricedWork} />
        </>
      ) : null}
      {checks.length ? (
        <>
          <p className="font-semibold">Pricing checks</p>
          <List items={checks} />
        </>
      ) : null}
      {notes.quantityNotes?.length ? (
        <>
          <p className="font-semibold">Quantity overrides</p>
          <List items={notes.quantityNotes.map((note) => quantityNoteLine(note))} />
        </>
      ) : null}
    </section>
  );
}
