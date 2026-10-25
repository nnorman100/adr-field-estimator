# Monitoring and alerts

`ops/monitoring/setup-monitoring.sh` gives project `alert-disaster-field-2026` its first Cloud Monitoring alerts. Before it, only the $25 budget alert existed, so an outage, an error spike, a Vertex AI failure or an email failure went unnoticed. The script is run by the owner; nothing in the app or CI runs it.

## Run it

1. Sign in as a project owner: `gcloud auth login`
2. Preview. A dry run makes no cloud calls; it prints the planned creation commands and generated policy files. Files are temporary unless you pass `--config-dir DIR` to keep them locally:
   `bash ops/monitoring/setup-monitoring.sh --email <alert address> --dry-run`
3. Create:
   `bash ops/monitoring/setup-monitoring.sh --email <alert address>` and type `yes` (or pass `--confirm` where there is no terminal).
4. Google emails the address a verification link. Confirm it, or alerts are not delivered.

The address is always an argument; no address is stored in the repository. The script targets only `alert-disaster-field-2026`: resource lookups and changes select that project explicitly; CLI availability and active-account checks are not project-scoped. It never deletes cloud resources, grants IAM roles, enables APIs or changes billing, and stops with a message if `gcloud` is missing or signed out, the project cannot be opened, the Monitoring or Logging API is off, or the Cloud Run service is missing. Re-running keeps an email channel for the same address and the existing uptime check, and updates alert policies in place by display name; it does not repair drift in a retained channel or uptime check.

Alert policies are billed per condition and uptime checks per run; at this size that is small, but check [Cloud Monitoring pricing](https://cloud.google.com/monitoring/pricing) first.

## What it creates

| Item | Fires when | What to do |
| --- | --- | --- |
| Uptime check `DryScope: API health` | Every 5 minutes from Iowa, Oregon and Virginia, `https://alert-disaster-field-2026.web.app/api/health` must return 200 containing `healthy`. This goes through Hosting's `/api/**` Cloud Run rewrite, so it tests the real public path. | Used by the next alert. |
| `DryScope: health check failing` | The check fails from at least two regions for a minute. | Open the site, then the Cloud Run service `alert-disaster-field-estimator` (`us-west2`) and its latest revision. Roll traffic back if it began with a deploy. |
| `DryScope: server errors` | More than 5 Cloud Run responses with a 5xx status in 10 minutes. | Filter Logs Explorer for the service at `severity>=ERROR`; roll back if it began with a deploy. |
| `DryScope: Vertex AI call failed` | A log line `Vertex AI call` at ERROR (audit, OCR or scope model call failed or timed out). | Read `provider_status`, `provider_code` and `outcome` in the line; check Vertex AI quota and status if it repeats. Technicians see a retry message. |
| `DryScope: Live provider failed` | A WARNING-or-higher Live event with `operation=live` and `provider_code` 500–599 (SDK error), 1006 (abnormal socket closure), 1011 (server error) or 1013 (try again later). | Check Vertex AI availability, quotas and the logged code; reconnect with the preserved draft. |
| `DryScope: email send failed` | An ERROR log with `operation=email` and `status=send_failed` from invitation delivery. Only the failure class is logged. | Check email transport configuration, credentials and provider status, then retry the invitation. |
| `DryScope: document email failed` | A log line `Delivery entry` with `operation=delivery` and `status=failed`. | Check the Gmail SMTP account, its app password and the daily limit. The entry stays retryable unless its outcome was unconfirmed. |
| `DryScope: daily email count high` | A log line with `operation=email` and `status=daily_warning`: more than 400 emails in the 24-hour window. | Gmail may refuse sends until the window resets; look for a send loop. |

The log alerts send at most one email an hour each and close themselves after 24 hours. They match only fields on the backend's allowlist (`LOG_FIELDS` in `backend/cloud_log.py`), which carries no prompts, addresses, links, tokens or coordinates. The document delivery alert stays quiet until document delivery is switched on.

Normal Live endings (`finished`, `rollover`, `disconnected`, `closed`) emit INFO and do not trigger the Live provider alert. Other codes and failures without a provider code are outside this policy.

## Test it

- Notifications: in the console, **Monitoring → Alerting → Edit notification channels**, open the email channel and **Send test notification**.
- Log alerts: `gcloud logging write` into the service's log would also page for real; instead run **Logs Explorer** with each policy's filter (shown in the dry run and in each policy's condition) to confirm it matches past lines, for example `jsonPayload.message="Vertex AI call" AND severity>=ERROR`.
- Uptime: **Monitoring → Uptime checks** shows each region's latest result for `DryScope: API health`. Pausing the check does not trigger an alert, so to prove the alert path temporarily edit the check's path to a missing page, wait about 20 minutes, then restore it.

`tests/test_monitoring_script.py` executes a dry run with a recording gcloud stub, checks generated policy semantics and matches filters against captured structured backend log events.
