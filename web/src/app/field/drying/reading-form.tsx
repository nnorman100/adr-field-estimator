'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { ReadingInput } from '@/lib/drying/schema';
import { Outcome } from '../ui';

const kinds = { air: 'Air', material: 'Material', thermal: 'Thermal' };
export const zones = {
  affected: 'Affected',
  unaffected: 'Unaffected',
  outside: 'Outside',
  dehu_inlet: 'Dehumidifier inlet',
  dehu_outlet: 'Dehumidifier outlet',
};
export const patterns = {
  cold_anomaly: 'Cold anomaly',
  thermal_bridge: 'Thermal bridge',
  evaporative_cooling: 'Evaporative cooling',
};

const fieldStyle =
  'min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-3 text-base';
const wholeJob = ':whole-job';
const areaStyle = 'min-h-20 w-full rounded-md border border-input bg-background p-2 text-base';

const half = 1_800_000;

// Every instant whose local wall clock reads `value`: none in a skipped hour, two in a repeated one.
export function localInstants(value: string): Date[] {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)?.slice(1).map(Number);
  if (!parts || parts[0]! < 100) return [];
  const [year, month, day, hour, minute] = parts as [number, number, number, number, number];
  const base = new Date(year, month - 1, day, hour, minute).getTime();
  const found = new Set<number>();
  for (let step = -4; step <= 4; step += 1) {
    const at = new Date(base + step * half);
    if (
      at.getFullYear() === year &&
      at.getMonth() === month - 1 &&
      at.getDate() === day &&
      at.getHours() === hour &&
      at.getMinutes() === minute
    )
      found.add(at.getTime());
  }
  return [...found].sort((a, b) => a - b).map((time) => new Date(time));
}

const zoneName = (date: Date) =>
  new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value ?? '';

function Label({ name, children }: { name: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {name}
      </label>
      {children(id)}
    </div>
  );
}

function NumberField({
  label,
  name,
  min,
  max,
  required = true,
}: {
  label: string;
  name: string;
  min: number;
  max: number;
  required?: boolean;
}) {
  return (
    <Label name={label}>
      {(fieldId) => (
        <input
          id={fieldId}
          className={fieldStyle}
          name={name}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step="any"
          required={required}
        />
      )}
    </Label>
  );
}

export function ReadingForm({
  rooms,
  busy,
  pending,
  online,
  locked,
  error,
  notice,
  submit,
  saveAgain,
  onEdit,
}: {
  rooms: Array<{ id: string; label: string }>;
  busy: boolean;
  pending: boolean;
  online: boolean;
  locked: boolean;
  error: string | null;
  notice: string | null;
  submit: (payload: ReadingInput, accepted: () => void) => void;
  saveAgain: () => void;
  onEdit: () => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<keyof typeof kinds>('air');
  const [zone, setZone] = useState<keyof typeof zones>('affected');
  const [room, setRoom] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [repeated, setRepeated] = useState<Date[]>([]);
  const outside = kind === 'air' && zone === 'outside';
  const roomUnavailable = room !== wholeJob && !rooms.some(({ id }) => id === room);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || busy || locked || !online) return;
    if (!outside && roomUnavailable) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const text = (name: string) => String(values.get(name) ?? '');
    const instants = localInstants(text('takenAt'));
    if (!instants.length) {
      setRepeated([]);
      return setDateError(
        'Enter a valid date and time. That local time may not exist when the clocks change.',
      );
    }
    const pick = text('occurrence');
    const chosen =
      instants.length === 1 ? instants[0] : pick === '' ? undefined : instants[Number(pick)];
    if (!chosen) {
      setRepeated(instants);
      return setDateError('That time happens twice when the clocks change. Choose which one.');
    }
    const date = chosen;
    setDateError(null);
    setRepeated([]);
    const common = {
      id: crypto.randomUUID(),
      roomId: outside || room === wholeJob ? null : room,
      takenAt: date.toISOString(),
      note: text('note'),
    };
    let payload: ReadingInput;
    switch (kind) {
      case 'air':
        payload = {
          ...common,
          kind,
          zone,
          temperatureF: Number(text('temperature')),
          relativeHumidity: Number(text('humidity')),
        };
        break;
      case 'material':
        payload = {
          ...common,
          kind,
          material: text('material'),
          unit: text('unit'),
          moisture: Number(text('moisture')),
          dryStandard: text('dryStandard') ? Number(text('dryStandard')) : null,
          affected: values.has('affected'),
        };
        break;
      case 'thermal':
        payload = {
          ...common,
          kind,
          deltaTF: Number(text('delta')),
          pattern: text('pattern') as keyof typeof patterns,
          boundary: text('boundary'),
        };
        break;
    }
    submit(payload, () => {
      form.reset();
      setKind('air');
      setZone('affected');
      setRoom('');
    });
  }

  return (
    <form
      onSubmit={save}
      onChange={onEdit}
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 id={id} className="font-semibold">
        Add a reading
      </h3>
      <fieldset disabled={busy || pending || locked} className="flex min-w-0 flex-col gap-3">
        <Label name="Reading type">
          {(fieldId) => (
            <select
              id={fieldId}
              className={fieldStyle}
              value={kind}
              onChange={(event) => setKind(event.target.value as keyof typeof kinds)}
            >
              {Object.entries(kinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </Label>
        {kind === 'air' ? (
          <Label name="Air zone">
            {(fieldId) => (
              <select
                id={fieldId}
                className={fieldStyle}
                value={zone}
                onChange={(event) => setZone(event.target.value as keyof typeof zones)}
              >
                {Object.entries(zones).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            )}
          </Label>
        ) : null}
        {!outside ? (
          <Label name="Room">
            {(fieldId) => (
              <select
                id={fieldId}
                className={fieldStyle}
                required
                value={room}
                onChange={(event) => setRoom(event.target.value)}
              >
                <option value="" disabled>
                  Choose a room or whole job
                </option>
                <option value={wholeJob}>Whole job</option>
                {room && roomUnavailable ? (
                  <option value={room} disabled>
                    Previously selected room
                  </option>
                ) : null}
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.label}
                  </option>
                ))}
              </select>
            )}
          </Label>
        ) : (
          <p>Outside air is recorded for the whole job.</p>
        )}
        <Label name="Taken at">
          {(fieldId) => (
            <input
              id={fieldId}
              className={fieldStyle}
              type="datetime-local"
              name="takenAt"
              required
              aria-describedby={dateError ? `${id}-date-error` : undefined}
              aria-invalid={dateError ? true : undefined}
              onChange={() => setRepeated([])}
            />
          )}
        </Label>
        {repeated.length ? (
          <Label name="Which time">
            {(fieldId) => (
              <select id={fieldId} className={fieldStyle} name="occurrence" defaultValue="" required>
                <option value="" disabled>
                  Choose the first or second time
                </option>
                {repeated.map((date, index) => (
                  <option key={date.getTime()} value={index}>
                    {index === 0 ? 'First' : 'Second'} ({zoneName(date)})
                  </option>
                ))}
              </select>
            )}
          </Label>
        ) : null}
        {dateError ? (
          <p role="alert" id={`${id}-date-error`}>
            {dateError}
          </p>
        ) : null}
        {kind === 'air' ? (
          <>
            <NumberField label="Temperature (°F)" name="temperature" min={-40} max={150} />
            <NumberField label="Relative humidity (%)" name="humidity" min={1} max={100} />
          </>
        ) : null}
        {kind === 'material' ? (
          <>
            <Label name="Material">
              {(fieldId) => (
                <input
                  id={fieldId}
                  className={fieldStyle}
                  name="material"
                  maxLength={100}
                  required
                />
              )}
            </Label>
            <Label name="Meter unit">
              {(fieldId) => (
                <input id={fieldId} className={fieldStyle} name="unit" maxLength={20} required />
              )}
            </Label>
            <NumberField label="Moisture" name="moisture" min={0} max={1000} />
            <NumberField
              label="Dry standard (optional, same meter unit)"
              name="dryStandard"
              min={0}
              max={1000}
              required={false}
            />
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" name="affected" className="size-5" defaultChecked /> Affected
              material
            </label>
          </>
        ) : null}
        {kind === 'thermal' ? (
          <>
            <NumberField label="Temperature difference (Δ°F)" name="delta" min={-200} max={200} />
            <Label name="Thermal pattern">
              {(fieldId) => (
                <select id={fieldId} className={fieldStyle} name="pattern">
                  {Object.entries(patterns).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              )}
            </Label>
            <Label name="Boundary note (optional)">
              {(fieldId) => (
                <textarea id={fieldId} className={areaStyle} name="boundary" maxLength={300} />
              )}
            </Label>
          </>
        ) : null}
        <Label name="Note (optional)">
          {(fieldId) => <textarea id={fieldId} className={areaStyle} name="note" maxLength={500} />}
        </Label>
      </fieldset>
      {!online ? <p>Needs a connection</p> : null}
      <Outcome error={error} notice={busy ? 'Saving…' : notice} />
      {pending ? (
        <Button type="button" disabled={!online || busy || locked} onClick={saveAgain}>
          Save again
        </Button>
      ) : (
        <Button
          type="submit"
          disabled={!online || busy || locked || (!outside && Boolean(room) && roomUnavailable)}
        >
          Save reading
        </Button>
      )}
    </form>
  );
}
