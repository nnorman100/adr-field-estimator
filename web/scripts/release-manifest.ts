// The release manifest (docs/plans/TC.md, TC-8): what one test release put out, attached as
// manifest.json to its GitHub Release, with the rollback command in the Release notes. The release
// workflow's record job runs it from web/ after the traffic move and the smoke check passed:
//
//   git tag --list 'infra-test-*' | npx tsx scripts/release-manifest.ts --version <YYYY.MM.DD-N> \
//     --commit <commit> --image <image@sha256:...> --revision <new revision> \
//     --replaced <revision=percent,...> --run <run URL> --out <manifest.json> --notes <notes.md> \
//     [--previous-release <earlier manifest.json> | --first-release]
//
// --replaced is the traffic the deploy job remembered before the move. On a rerun that found this
// release's image already serving, that traffic is the release's own, so the record job passes the
// previous published release's manifest instead and the rollback target is the revision it released.
// When there is no earlier DryScope test release at all (the bootstrap run after the owner's first
// app-root apply), it passes --first-release: the manifest is marked firstRelease and its rollback
// is null, the only case where it may be.
//
// The rest it reads from the checkout of the released commit: the migration level (the highest
// numbered file in web/migrations, which the migrate job applied or the release stopped), the switch
// defaults (FLAG_NAMES, all off until a company turns one on) and the prompt and model versions
// (src/lib/ai/registry.ts). Standard input carries the repository's infra-test-<root>-* tags, which
// the owner pushes after each Terraform apply (C6). The minimum phone version stays null until S6-6
// adds MIN_CLIENT_EPOCH. It prints nothing secret: every field is a name, number, hash or command.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AI_FEATURES, AI_REGISTRY } from '../src/lib/ai/registry';
import { FLAG_NAMES } from '../src/lib/flags/known';
import { FIRST_RELEASE, VERSION } from './release-version';

export const SERVICE = 'dryscope-api-test';
export const REGION = 'us-central1';
export const PROJECT = 'dryscope';
export const TERRAFORM_ROOTS = ['data', 'app'] as const;
export const DATABASE_RULE =
  'The database never rolls back: migrations stay applied, and the add-first rule keeps the previous code working against them.';

const COMMIT = /^[0-9a-f]{40}$/;
const IMAGE = /^us-central1-docker\.pkg\.dev\/dryscope\/dryscope-test\/web@(sha256:[0-9a-f]{64})$/;
// Cloud Run revision names of the test service: lowercase letters, digits and dashes only, so a
// name is safe to paste into the rollback command.
const REVISION = /^dryscope-api-test-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIGRATION = /^\d{4}_[a-z0-9_]+\.sql$/;
const TERRAFORM_TAG = (root: string) =>
  new RegExp(`^infra-test-${root}-(\\d{4}\\.\\d{2}\\.\\d{2})-([1-9]\\d{0,5})$`);

const Revision = z.string().regex(REVISION);

// One manifest shape; only the switch defaults differ between writing this release's manifest and
// reading an earlier one's (see PreviousReleaseManifest).
const manifestSchema = (
  switchDefaults: z.ZodType<Partial<Record<(typeof FLAG_NAMES)[number], false>>>,
) =>
  z
    .strictObject({
      schema: z.literal(1),
      version: z.string().regex(VERSION),
      environment: z.literal('test'),
      commit: z.string().regex(COMMIT),
      image: z.string().regex(IMAGE),
      imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      revision: Revision,
      replaced: z
        .array(z.strictObject({ revision: Revision, percent: z.int().min(1).max(100) }))
        .min(1)
        .refine((split) => split.reduce((sum, r) => sum + r.percent, 0) === 100, {
          error: 'the replaced traffic must add up to 100',
        }),
      migrationLevel: z.string().regex(MIGRATION).nullable(),
      terraformTags: z.strictObject({
        data: z.string().regex(TERRAFORM_TAG('data')).nullable(),
        app: z.string().regex(TERRAFORM_TAG('app')).nullable(),
      }),
      ai: z.array(
        z.strictObject({
          feature: z.enum(AI_FEATURES),
          model: z.string().min(1),
          promptVersion: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
        }),
      ),
      switchDefaults,
      minClientEpoch: z.int().nonnegative().nullable(),
      firstRelease: z.boolean(),
      rollback: z
        .strictObject({ command: z.string().min(1), database: z.literal(DATABASE_RULE) })
        .nullable(),
      run: z.url({ protocol: /^https$/ }),
    })
    .refine((manifest) => (manifest.rollback === null) === manifest.firstRelease, {
      error: 'only the first recorded release has no rollback, and it has none',
      path: ['rollback'],
    });

// The manifest this release writes: every switch it knows, each off.
export const ReleaseManifest = manifestSchema(z.record(z.enum(FLAG_NAMES), z.literal(false)));
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

// An earlier release's manifest, as a rerun of the record reads it for the rollback target. That release
// may predate a switch this one knows, so any known switch may be missing; one it lists is still a known
// switch, off.
export const PreviousReleaseManifest = manifestSchema(
  z.partialRecord(z.enum(FLAG_NAMES), z.literal(false)),
);

export type ManifestInput = {
  version: string;
  commit: string;
  image: string;
  revision: string;
  replaced: string;
  run: string;
  migrations: readonly string[];
  tags: readonly string[];
  /** The previous published release's manifest, when this release's image was already serving. */
  previousRelease?: unknown;
  /** No earlier DryScope test release exists and this release's image was already serving. */
  firstRelease?: boolean;
};

/** "rev-a=90,rev-b=10", as the deploy job remembered the traffic before the move. */
export function parseTraffic(split: string): { revision: string; percent: number }[] {
  return split.split(',').map((pair) => {
    const at = pair.lastIndexOf('=');
    const percent =
      at > 0 && /^\d{1,3}$/.test(pair.slice(at + 1)) ? Number(pair.slice(at + 1)) : NaN;
    return { revision: pair.slice(0, at), percent };
  });
}

/** The highest numbered migration file, or null when there is none. */
export function migrationLevel(files: readonly string[]): string | null {
  const numbered = files.filter((file) => MIGRATION.test(file)).sort();
  return numbered.at(-1) ?? null;
}

/** The newest infra-test-<root>-YYYY.MM.DD-N tag for a root, or null when the owner pushed none. */
export function newestTerraformTag(root: string, tags: readonly string[]): string | null {
  const form = TERRAFORM_TAG(root);
  let best: { tag: string; date: string; n: number } | null = null;
  for (const raw of tags) {
    const tag = raw.trim();
    const match = form.exec(tag);
    if (!match) continue;
    const date = match[1]!;
    const n = Number(match[2]);
    if (!best || date > best.date || (date === best.date && n > best.n)) best = { tag, date, n };
  }
  return best?.tag ?? null;
}

/** The revision the previous published release put out, as the whole of the traffic to restore. */
export function releasedBefore(
  previous: unknown,
  input: Pick<ManifestInput, 'version' | 'revision'>,
) {
  const parsed = PreviousReleaseManifest.safeParse(previous);
  if (!parsed.success) throw new Error('the previous release manifest is not valid');
  if (parsed.data.version === input.version || parsed.data.revision === input.revision) {
    throw new Error('the previous release manifest is this release, not an earlier one');
  }
  return [{ revision: parsed.data.revision, percent: 100 }];
}

/** The exact command that puts the replaced traffic back on the test service. */
export function rollbackCommand(
  replaced: readonly { revision: string; percent: number }[],
): string {
  const split = replaced.map((r) => `${r.revision}=${r.percent}`).join(',');
  return `gcloud run services update-traffic ${SERVICE} --to-revisions=${split} --region=${REGION} --project=${PROJECT}`;
}

export function buildManifest(input: ManifestInput): ReleaseManifest {
  const firstRelease = input.firstRelease === true;
  if (firstRelease && input.previousRelease !== undefined) {
    throw new Error('a first release has no previous release');
  }
  const replaced =
    input.previousRelease === undefined
      ? parseTraffic(input.replaced)
      : releasedBefore(input.previousRelease, input);
  const digest = IMAGE.exec(input.image)?.[1] ?? '';
  const terraformTags = {
    data: newestTerraformTag('data', input.tags),
    app: newestTerraformTag('app', input.tags),
  };
  const manifest = {
    schema: 1,
    version: input.version,
    environment: 'test',
    commit: input.commit,
    image: input.image,
    imageDigest: digest,
    revision: input.revision,
    replaced,
    migrationLevel: migrationLevel(input.migrations),
    terraformTags,
    ai: AI_FEATURES.map((feature) => ({
      feature,
      model: AI_REGISTRY[feature].model,
      promptVersion: AI_REGISTRY[feature].prompt?.version ?? null,
    })),
    switchDefaults: Object.fromEntries(FLAG_NAMES.map((name) => [name, false])),
    // S6-6 sets this from MIN_CLIENT_EPOCH.
    minClientEpoch: null,
    firstRelease,
    rollback: firstRelease ? null : { command: rollbackCommand(replaced), database: DATABASE_RULE },
    run: input.run,
  };
  const parsed = ReleaseManifest.safeParse(manifest);
  if (!parsed.success) {
    // Field paths and messages only; every value came from this run, but none is echoed.
    throw new Error(
      `the release manifest is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

/** The GitHub Release notes: the rollback command and the database rule up front. */
export function releaseNotes(manifest: ReleaseManifest): string {
  const rollback = manifest.rollback
    ? [
        'Roll back to the traffic this release replaced:',
        '',
        '```sh',
        manifest.rollback.command,
        '```',
        '',
        manifest.rollback.database,
      ]
    : [FIRST_RELEASE];
  return [
    `Test release ${manifest.version} of commit ${manifest.commit}, serving as \`${manifest.revision}\`.`,
    '',
    ...rollback,
    '',
    `Migration level: ${manifest.migrationLevel ?? 'none'}. The full record is manifest.json, attached.`,
    '',
  ].join('\n');
}

function args(argv: string[]) {
  const value = (name: string): string => {
    const i = argv.indexOf(`--${name}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v || v.startsWith('--')) throw new Error(`--${name} is required`);
    return v;
  };
  return {
    version: value('version'),
    commit: value('commit'),
    image: value('image'),
    revision: value('revision'),
    replaced: value('replaced'),
    run: value('run'),
    out: value('out'),
    notes: value('notes'),
    previousRelease: argv.includes('--previous-release') ? value('previous-release') : undefined,
    firstRelease: argv.includes('--first-release'),
  };
}

async function main(argv: string[]) {
  const { previousRelease, ...given } = args(argv);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const manifest = buildManifest({
    ...given,
    migrations: readdirSync(migrations),
    tags: input.split('\n'),
    ...(previousRelease === undefined
      ? {}
      : { previousRelease: JSON.parse(readFileSync(previousRelease, 'utf8')) }),
  });
  writeFileSync(given.out, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(given.notes, releaseNotes(manifest));
  console.log(
    `manifest: ${manifest.version} ${manifest.revision} migrations=${manifest.migrationLevel ?? 'none'}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'release manifest failed');
    process.exit(1);
  });
}
