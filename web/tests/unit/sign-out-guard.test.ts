import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// S6-3b: every sign-out a company screen makes goes through src/lib/field/sign-out.ts, which saves a
// refusal's lock (O5) before the saved sign-in goes. The web ESLint config forbids the raw sign-out
// and the bare removal of the saved sign-in in screens; this runs that config on sample screens.

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const SCREEN = 'src/app/(auth)/sign-in/[address]/sample/sample-screen.tsx';

const eslint = new ESLint({ cwd: WEB });

// The first lint loads the whole config (the Next and TypeScript plugins), which takes seconds on a
// busy machine; it is done once here, so each test below times only its own lint.
beforeAll(async () => {
  await eslint.lintText('export {};\n', { filePath: SCREEN });
}, 120_000);

async function restricted(code: string, filePath = SCREEN): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((message) => message.ruleId === 'no-restricted-imports').map((message) => message.message);
}

describe('screen sign-outs', () => {
  it('refuse the raw Firebase sign-out in a company screen', async () => {
    const found = await restricted(
      "import { signOutCompany } from '@/lib/firebase-client';\nexport const leave = signOutCompany;\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('signOutOnRefusal');
  });

  it('refuse removing the saved sign-in from a screen or the field shell', async () => {
    const code = "import { forgetMe } from '@/lib/field/ds-me';\nexport const leave = forgetMe;\n";
    expect(await restricted(code)).toHaveLength(1);
    expect(await restricted(code, 'src/app/field/sample-view.tsx')).toHaveLength(1);
  });

  it('allow the shared sign-out, and the operator console its own', async () => {
    expect(
      await restricted(
        "import { signOutDiscarding, signOutKeeping, signOutOnRefusal } from '@/lib/field/sign-out';\nimport { companyAuth } from '@/lib/firebase-client';\nexport const all = [signOutDiscarding, signOutKeeping, signOutOnRefusal, companyAuth];\n",
      ),
    ).toEqual([]);
    expect(
      await restricted(
        "import { signOutCompany } from '@/lib/firebase-client';\nexport const leave = signOutCompany;\n",
        'src/app/operator/[tenantId]/sample-session.tsx',
      ),
    ).toEqual([]);
  });
});

// S6-3b: a lock is saved, lifted and acted on only by evaluate() in src/lib/field/retention.ts.
describe('the steps of the retention routine', () => {
  const LIB = 'src/lib/field/sample.ts';

  it.each([
    ["import { noteLocked } from './unsent';\nexport const step = noteLocked;\n", LIB],
    ["import { noteUnlocked } from '@/lib/field/unsent';\nexport const step = noteUnlocked;\n", LIB],
    ["import { lockWork } from './retention';\nexport const step = lockWork;\n", LIB],
    ["import { noteLocked } from '@/lib/field/unsent';\nexport const step = noteLocked;\n", SCREEN],
    ["import { lockWork } from '@/lib/field/retention';\nexport const step = lockWork;\n", 'src/app/field/sample-view.tsx'],
    ["import { noteUnlocked } from '@/lib/field/unsent';\nexport const step = noteUnlocked;\n", 'src/app/operator/[tenantId]/sample-session.tsx'],
  ])('are refused outside it (%#)', async (code, filePath) => {
    const found = await restricted(code, filePath);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('evaluate(now, event)');
  });

  it('are allowed in the routine itself, and the routine and the marks\' reads everywhere', async () => {
    expect(await restricted("import { noteLocked, noteUnlocked } from './unsent';\nexport const steps = [noteLocked, noteUnlocked];\n", 'src/lib/field/retention.ts')).toEqual([]);
    expect(
      await restricted(
        "import { evaluate, watchRetention } from '@/lib/field/retention';\nimport { savedLock, unsentWork } from '@/lib/field/unsent';\nexport const all = [evaluate, watchRetention, savedLock, unsentWork];\n",
      ),
    ).toEqual([]);
  });

  it('are not reached from anywhere in the app today', async () => {
    const results = await eslint.lintFiles(['src/lib/field', 'src/app/field', 'src/app/(auth)']);
    expect(results.flatMap((result) => result.messages.filter((message) => message.ruleId === 'no-restricted-imports'))).toEqual([]);
  }, 60_000);
});
