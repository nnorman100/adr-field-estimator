import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// S6-3b: every sign-out a company screen makes goes through src/lib/field/sign-out.ts, which saves a
// refusal's lock (O5) before the saved sign-in goes. The web ESLint config forbids the raw sign-out
// and the bare removal of the saved sign-in in screens; this runs that config on sample screens.

const WEB = fileURLToPath(new URL('../../', import.meta.url));
const SCREEN = 'src/app/(auth)/sign-in/[address]/sample/sample-screen.tsx';

async function restricted(code: string, filePath = SCREEN): Promise<string[]> {
  const eslint = new ESLint({ cwd: WEB });
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
        "import { signOutOnRefusal } from '@/lib/field/sign-out';\nimport { companyAuth } from '@/lib/firebase-client';\nexport const both = [signOutOnRefusal, companyAuth];\n",
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
