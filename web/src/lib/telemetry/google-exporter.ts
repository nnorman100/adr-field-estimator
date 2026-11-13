import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { GoogleAuth } from 'google-auth-library';

// The in-process OTLP exporter to Cloud Trace's Telemetry API, as Google's guide for an
// application with no collector describes it (docs.cloud.google.com/trace/docs/migrate-to-otlp-endpoints):
// protobuf over HTTP to https://telemetry.googleapis.com/v1/traces, a Google access token as the
// bearer. The token comes from Application Default Credentials, which on Cloud Run is the service's
// own account (the metadata server). It needs roles/telemetry.tracesWriter on the project and
// the telemetry and cloudtrace APIs enabled (TC-9). The narrower trace.append scope is one of the two
// the method accepts (the other is cloud-platform).
export const TELEMETRY_TRACES_URL = 'https://telemetry.googleapis.com/v1/traces';
const SCOPE = 'https://www.googleapis.com/auth/trace.append';

export function googleTraceExporter(
  auth: Pick<GoogleAuth, 'getRequestHeaders'> = new GoogleAuth({ scopes: SCOPE }),
  url: string = TELEMETRY_TRACES_URL,
): SpanExporter {
  return new OTLPTraceExporter({
    url,
    timeoutMillis: 10_000,
    // Asked for on every export, so a token is never used past its expiry (the library caches and
    // refreshes it). A header factory must not throw: no credentials means no headers, the export is
    // refused by Google, and the failure is counted by the caller.
    headers: async () => {
      try {
        const headers = await auth.getRequestHeaders(url);
        return Object.fromEntries(headers.entries());
      } catch {
        return {};
      }
    },
  });
}
