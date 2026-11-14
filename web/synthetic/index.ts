// The Cloud Run function behind the test copy's Cloud Monitoring synthetic monitor (TC-10).
// Deployed on its own from this folder (its own package.json and lock file); the web app does not
// import it. The probe's work is in probe.ts, which the web app's tests run.
//
// runSyntheticHandler records a thrown error's name, message and stack as the check's result, so
// probe.ts throws only fixed text. instantiateAutoInstrumentation is deliberately not called: it
// traces and logs every outbound request, and these carry a sign-in.
import * as functions from '@google-cloud/functions-framework';
import { runSyntheticHandler } from '@google-cloud/synthetics-sdk-api';
import { readProbeConfig, runProbe } from './probe';

functions.http(
  'DryscopeSynthetic',
  runSyntheticHandler(async () => {
    await runProbe(readProbeConfig(process.env));
  }),
);
