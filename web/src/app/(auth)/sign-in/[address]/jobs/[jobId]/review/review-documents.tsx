import { LinkPhoto } from '@/components/links/link-photo';
import type { EstimateEnd, LetterLine, ProposalLetter } from '@/engine/estimate';
import type { EstimateView } from '@/lib/estimates/result';
import { chargeRows, dollars, photoAlbums, priceLines, pricePointLine, quantityNoteLine, warningText } from '@/lib/estimates/screen';

// The parts of Review before signing that show the stored estimate: the price, the four documents
// and the staff-only notes. Every amount and sentence is the server's, shown as stored; the
// proposal is shown from its stored bytes, which signing binds to.

const SECTION = 'flex flex-col gap-2';
const HEADING = 'text-lg font-semibold';
const ROW = 'flex min-w-0 items-baseline justify-between gap-3';

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function Charges({ end, afterHoursLabel, withPricePoint = true }: { end: EstimateEnd; afterHoursLabel: string; withPricePoint?: boolean }) {
  return chargeRows(end, afterHoursLabel, withPricePoint).map((row, index) => (
    <li key={`${index}-${row.label}`} className={ROW}>
      <span className="min-w-0 break-words">{row.label}</span>
      <span className="shrink-0 tabular-nums">{dollars(row.amount)}</span>
    </li>
  ));
}

export function EstimatePrice({ estimate }: { estimate: EstimateView }) {
  const price = priceLines(estimate.totals);
  const adjustment = pricePointLine(estimate.totals.low, estimate.totals.mode === 'range' ? estimate.totals.high : null);
  return (
    <section aria-labelledby="review-price" className={SECTION}>
      <h2 id="review-price" className={HEADING}>
        Price
      </h2>
      <p className="text-xl font-semibold">{price.customer}</p>
      <p>{price.itemized}</p>
      {adjustment ? <p>{adjustment}</p> : null}
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
        <Charges end={estimate.totals.low} afterHoursLabel={estimate.totals.after_hours_label} withPricePoint={false} />
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

function Paragraphs({ items }: { items: string[] }) {
  return items.map((item, index) => (
    <p key={`${index}-${item}`} className="break-words">
      {item}
    </p>
  ));
}

// The letter's work: each line, with its price only when the proposal carries one.
function Work({ items, lines }: { items: string[]; lines: LetterLine[] }) {
  return (
    <ul role="list" className="flex flex-col gap-1">
      {items.map((item, index) => (
        <li key={`task-${index}-${item}`} className="break-words">
          {item}
        </li>
      ))}
      {lines.map((line, index) => (
        <li key={`line-${index}-${line.text}`} className={ROW}>
          <span className="min-w-0 break-words">{line.text}</span>
          {line.total !== undefined ? <span className="shrink-0 tabular-nums">{dollars(line.total)}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The letter layout (S5a-9b): area inspected, findings and recommendations, as the engine built them. */
function Letter({ letter }: { letter: ProposalLetter }) {
  return (
    <>
      <h3 className="font-semibold">Area inspected</h3>
      <List items={letter.area_inspected} />
      <h3 className="font-semibold">Findings</h3>
      <Paragraphs items={letter.findings} />
      {letter.room_findings.map((room, index) => (
        <div key={`${index}-${room.room}`} className="flex flex-col gap-1">
          <h4 className="font-medium break-words">{room.room}</h4>
          <p className="break-words whitespace-pre-wrap">{room.text}</p>
        </div>
      ))}
      <h3 className="font-semibold">Recommendations</h3>
      <Paragraphs items={letter.recommendations} />
      {letter.room_work.map((room, index) => (
        <div key={`${index}-${room.room}`} className="flex flex-col gap-1">
          <h4 className="font-medium break-words">{room.room}</h4>
          <Work items={room.prep_tasks} lines={room.lines} />
        </div>
      ))}
      {letter.job_work.length ? <Work items={[]} lines={letter.job_work} /> : null}
      <p className="break-words">{letter.additional}</p>
    </>
  );
}

/** The company's own clauses, each exactly as entered, after the recommendations (S5a-9b). */
function CompanyClauses({ clauses }: { clauses: Array<{ title: string; text: string }> }) {
  return clauses.map((clause, index) => (
    <div key={`${index}-${clause.title}`} className="flex flex-col gap-1">
      <h3 className="font-semibold break-words whitespace-pre-wrap">{clause.title}</h3>
      <p className="break-words whitespace-pre-wrap">{clause.text}</p>
    </div>
  ));
}

function showsLinePrices(letter: ProposalLetter): boolean {
  return [...letter.job_work, ...letter.room_work.flatMap((room) => room.lines)].some((line) => line.total !== undefined);
}

/** The proposal, shown from its stored bytes: on the review, and on the signed page (S5a-11). */
export function Proposal({ proposal }: { proposal: NonNullable<EstimateView['proposal']> }) {
  const price = proposal.price;
  const adjustment = pricePointLine(price.low, price.mode === 'range' ? price.high : null);
  const priceLine = (
    <>
      <p className="font-semibold">
        {price.mode === 'range' && price.high ? `Customer estimate range: ${dollars(price.low.total)} to ${dollars(price.high.total)}` : `Price: ${dollars(price.low.total)}`}
      </p>
      {adjustment ? <p>{adjustment}</p> : null}
      {price.explanation ? <p className="text-sm">{price.explanation}</p> : null}
    </>
  );
  const clauses = proposal.company_clauses ? <CompanyClauses clauses={proposal.company_clauses} /> : null;
  return (
    <div className="flex flex-col gap-2" data-layout={proposal.letter ? 'letter' : 'itemized'}>
      <p className="font-semibold">{proposal.heading}</p>
      <p className="text-sm break-words">{proposal.letterhead.join(' · ')}</p>
      {proposal.customer_name ? <p>Customer: {proposal.customer_name}</p> : null}
      <p className="break-words">Property: {proposal.property_address}</p>
      {proposal.letter ? (
        <>
          <Letter letter={proposal.letter} />
          {clauses}
          <List items={proposal.disclaimers} />
          {showsLinePrices(proposal.letter) ? (
            <ul className="flex flex-col gap-1">
              <Charges end={price.low} afterHoursLabel={price.after_hours_label} withPricePoint={false} />
            </ul>
          ) : null}
          {priceLine}
        </>
      ) : (
        <>
          {price.lines ? (
            <ul className="flex flex-col gap-1">
              {price.lines.map((line, index) => (
                <li key={`${index}-${line.description}`} className={ROW}>
                  <span className="min-w-0 break-words">{line.description}</span>
                  <span className="shrink-0 tabular-nums">{dollars(line.total)}</span>
                </li>
              ))}
              <Charges end={price.low} afterHoursLabel={price.after_hours_label} withPricePoint={false} />
            </ul>
          ) : null}
          {priceLine}
          <p className="font-semibold">Findings</p>
          <List items={proposal.findings} />
          <p className="font-semibold">Proposed scope</p>
          <List items={proposal.recommendations} />
          {clauses}
          <List items={proposal.disclaimers} />
        </>
      )}
      {proposal.authorization_text !== undefined ? (
        <>
          <p className="font-semibold">Start-work authorization</p>
          <p className="break-words whitespace-pre-wrap" data-testid="authorization-text">
            {proposal.authorization_text}
          </p>
        </>
      ) : null}
      {proposal.payment_terms_text !== undefined ? (
        <>
          <p className="font-semibold">Payment terms</p>
          <p className="break-words whitespace-pre-wrap" data-testid="payment-terms-text">
            {proposal.payment_terms_text}
          </p>
        </>
      ) : null}
    </div>
  );
}

/** The itemized claim's lines, then the charges and the itemized total of the end given. */
export function ItemizedClaim({ rows, end, afterHoursLabel }: { rows: unknown[]; end: EstimateEnd; afterHoursLabel: string }) {
  return (
    <ul className="flex flex-col gap-2 pt-3">
      {rows.map((row, index) => {
        const line = (row ?? {}) as Record<string, unknown>;
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
      <Charges end={end} afterHoursLabel={afterHoursLabel} />
      <li className={`${ROW} font-semibold`}>
        <span>Itemized total</span>
        <span className="shrink-0 tabular-nums">{dollars(end.total)}</span>
      </li>
    </ul>
  );
}

/** The photo audit log as lines; with `loadPhoto` (a link's page), each line can open its photo. */
export function PhotoLog({ photos, loadPhoto }: { photos: unknown[]; loadPhoto?: (photoId: string) => Promise<string | null> }) {
  if (!photos.length) return <p className="pt-3">No photos.</p>;
  // By room the log is one list; by shot tag each album sits under its heading (S5a-9c). Photos are
  // numbered straight through the log, so an album's lines start where the one before it ended.
  const albums = photoAlbums(photos);
  return (
    <>
      {albums.map((album, albumIndex) => {
        const first = albums.slice(0, albumIndex).reduce((count, earlier) => count + earlier.lines.length, 0);
        return (
          <div key={album.heading ?? 'photos'}>
            {album.heading ? <h3 className="pt-3 font-semibold">{album.heading}</h3> : null}
            {loadPhoto ? (
              <ul className="flex flex-col gap-3 pt-3">
                {album.lines.map((line, offset) => {
                  const index = first + offset;
                  const id = photoIdOf(photos[index]);
                  return (
                    <li key={`${index}-${id}`} className="flex flex-col gap-1">
                      <span className="break-words">{line}</span>
                      {id ? <LinkPhoto label={`Photo ${index + 1}`} load={() => loadPhoto(id)} /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <List items={album.lines} />
            )}
          </div>
        );
      })}
    </>
  );
}

function photoIdOf(photo: unknown): string {
  return photo !== null && typeof photo === 'object' ? text((photo as Record<string, unknown>).id) : '';
}

export function EstimateDocuments({ estimate }: { estimate: EstimateView }) {
  const { documents, proposal } = estimate;
  if (!documents || !proposal) return null;
  return (
    <section aria-labelledby="review-documents" className={SECTION}>
      <h2 id="review-documents" className={HEADING}>
        Documents
      </h2>
      <p className="text-sm">Open each document before signing.</p>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Proposal</summary>
        <div className="pt-3">
          <Proposal proposal={proposal} />
        </div>
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Itemized claim</summary>
        <ItemizedClaim rows={documents.itemizedClaim} end={estimate.totals.low} afterHoursLabel={estimate.totals.after_hours_label} />
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Scope defense letter</summary>
        <p className="pt-3 break-words whitespace-pre-wrap">{documents.letter}</p>
      </details>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer font-semibold">Photo audit log</summary>
        <PhotoLog photos={documents.photoLog} />
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
      {estimate.documents?.unpricedWork.length ? (
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
