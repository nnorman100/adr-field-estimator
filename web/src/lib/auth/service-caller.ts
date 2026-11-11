import { OAuth2Client } from 'google-auth-library';
import { ConfigError, parseIdentityConfig } from '@/lib/config';

// Who may call an internal job route (serviceRoute in route.ts): the environment's scheduler
// service account, with a Google-signed ID token minted for that one job. No member, account or
// operator sign-in is accepted there.
//
// The account is named from settings the Cloud Run Terraform already sets (APP_ENV and
// GOOGLE_CLOUD_PROJECT, infra/dryscope/app/cloud_run.tf): dryscope-scheduler-{env}, the naming
// module's pattern (infra/dryscope/modules/naming). In test, Terraform creates the account (data
// root, identities.tf) and the Cloud Scheduler job that calls each route with this caller and
// audience (app root, scheduler.tf); until the owner applies both, and in live for now, no token
// can pass.

export type ServiceCallerClaims = { email: string | null; emailVerified: boolean };

export type ServiceTokenVerifier = {
  // Checks the signature, issuer, expiry and audience, then returns the account it names.
  verify(idToken: string, audience: string): Promise<ServiceCallerClaims>;
};

export type ServiceCaller = {
  email: string;
  // The audience of the token for one job: dryscope-{env}-{job}.
  audienceFor(job: string): string;
};

export type ServiceCallerServices = { caller: ServiceCaller; verifier: ServiceTokenVerifier };

export function schedulerCaller(env: Record<string, string | undefined>): ServiceCaller {
  const { appEnv, projectId } = parseIdentityConfig(env);
  if (appEnv === 'local')
    throw new ConfigError(['APP_ENV: internal job routes are not callable locally']);
  return {
    email: `dryscope-scheduler-${appEnv}@${projectId}.iam.gserviceaccount.com`,
    audienceFor: (job) => `dryscope-${appEnv}-${job}`,
  };
}

export function googleIdTokenVerifier(client = new OAuth2Client()): ServiceTokenVerifier {
  return {
    async verify(idToken, audience) {
      const ticket = await client.verifyIdToken({ idToken, audience });
      const payload = ticket.getPayload();
      return { email: payload?.email ?? null, emailVerified: payload?.email_verified === true };
    },
  };
}

let services: ServiceCallerServices | null = null;

// Built from the checked server configuration on the first internal call, then reused. A missing
// or invalid setting throws, and that call fails closed.
export function serviceCallerServices(): ServiceCallerServices {
  services ??= { caller: schedulerCaller(process.env), verifier: googleIdTokenVerifier() };
  return services;
}
