import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { checkDraftStates, parseCheckArgs, parseDraftJobs, type DraftJob } from '../../scripts/check-draft-states';

// The owner-run read-only check before migration 0016 (security audit F1, step 5): jobs in status
// draft whose current draft the field database holds as submitted, which the SQL migration cannot
// see. The field database is replaced at the reader.

const job = (): DraftJob => ({ companyId: randomUUID(), jobId: randomUUID(), draftId: randomUUID() });
const csv = (jobs: DraftJob[]) => jobs.map(({ companyId, jobId, draftId }) => `${companyId},${jobId},${draftId}`).join('\n');

describe('parseCheckArgs', () => {
  it('needs a project and a Firestore database id, and nothing else', () => {
    expect(parseCheckArgs(['--project', 'dryscope', '--database', 'dryscope-field-test'])).toEqual({ project: 'dryscope', database: 'dryscope-field-test' });
    expect(parseCheckArgs(['--database', '(default)', '--project', 'dryscope'])).toEqual({ project: 'dryscope', database: '(default)' });
    expect(() => parseCheckArgs(['--database', 'dryscope-field-test'])).toThrow('--project is required');
    expect(() => parseCheckArgs(['--project', 'dryscope'])).toThrow('--database is required');
    expect(() => parseCheckArgs(['--project', 'Not A Project', '--database', 'x-db'])).toThrow('--project must be');
    expect(() => parseCheckArgs(['--project', 'dryscope', '--database', 'Bad/Db'])).toThrow('--database must be');
    expect(() => parseCheckArgs(['--project', 'dryscope', '--database', 'dryscope-field-test', '--apply'])).toThrow('unknown option --apply');
    expect(() => parseCheckArgs(['--project'])).toThrow('--project needs a value');
  });
});

describe('parseDraftJobs', () => {
  it('reads the runbook export, skipping blank lines', () => {
    const jobs = [job(), job()];
    expect(parseDraftJobs(`${csv(jobs)}\r\n\n`)).toEqual(jobs);
    expect(parseDraftJobs('')).toEqual([]);
  });

  it('stops on any line that is not three ids, so a wrong export is never read as no stuck jobs', () => {
    const one = job();
    expect(() => parseDraftJobs(`${csv([one])}\ncompany_id,id,current_draft_id`)).toThrow('line 2 is not');
    expect(() => parseDraftJobs(`${one.companyId},${one.jobId}`)).toThrow('line 1 is not');
    expect(() => parseDraftJobs(`${csv([one])},extra`)).toThrow('line 1 is not');
  });
});

describe('checkDraftStates', () => {
  it('lists each job whose current draft is submitted in the field database, by company and job only', async () => {
    const [stuck, editing, submitting, missing] = [job(), job(), job(), job()];
    const states = new Map<string, unknown>([
      [`${stuck.companyId}/${stuck.draftId}`, 'submitted'],
      [`${editing.companyId}/${editing.draftId}`, 'editing'],
      [`${submitting.companyId}/${submitting.draftId}`, 'submitting'],
    ]);
    const read = vi.fn(async () => states);
    const lines: string[] = [];
    const result = await checkDraftStates([stuck, editing, submitting, missing], read, (line) => lines.push(line));
    expect(result).toEqual({ checked: 4, stuck: [stuck], missing: 1 });
    expect(read).toHaveBeenCalledWith([stuck, editing, submitting, missing].map(({ companyId, draftId }) => ({ companyId, draftId })));
    expect(lines).toEqual([
      `stuck: ${stuck.companyId}/${stuck.jobId} is in status draft on a submitted draft`,
      'checked 4 jobs in status draft: 1 on a submitted draft, 1 with no draft in the field database.',
      'the owner settles these jobs before 0016 runs.',
    ]);
  });

  it('reads the draft of the job’s own company only: the same draft id in another company is not this job’s', async () => {
    const one = job();
    const states = new Map<string, unknown>([[`${randomUUID()}/${one.draftId}`, 'submitted']]);
    const result = await checkDraftStates([one], async () => states, () => {});
    expect(result).toEqual({ checked: 1, stuck: [], missing: 1 });
  });

  it('says nothing stops 0016 when no job is stuck, and reads nothing for an empty export', async () => {
    const read = vi.fn(async () => new Map<string, unknown>());
    const lines: string[] = [];
    expect(await checkDraftStates([], read, (line) => lines.push(line))).toEqual({ checked: 0, stuck: [], missing: 0 });
    expect(read).not.toHaveBeenCalled();
    expect(lines.at(-1)).toBe('nothing stops 0016 here.');
  });
});
