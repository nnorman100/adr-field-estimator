# Data: Rebuilt app: backups, logs and AI data under Technology Standard 2.7

Part of [Data](../DATA.md).

## Rebuilt app: backups, logs and AI data under Technology Standard 2.7 (planned)

The rules below are owner decisions (D-018 to D-028 in [DECISIONS.md](../DECISIONS.md)). They are not
applied yet: the Terraform is stage TC ([plans/TC.md](../plans/TC.md)), owner-applied, and the AI side is stage
S7 ([plans/S7.md](../plans/S7.md)). The retention table above describes the old app.

- **Deleted data leaves backups within 35 days (D-023).** Evidence buckets get a noncurrent-version
  lifecycle rule of 28 days plus 7 days of soft delete; Cloud SQL keeps at most 30 backups; Firestore
  backups are kept 14 days (the most Firestore allows is 14 weeks,
  `documents/firebase.google.com/docs/firestore/backups`); no personal data goes to logs. Google's own
  suggestion is versioning and soft delete on one bucket with a lifecycle rule deleting noncurrent
  versions (`documents/docs.cloud.google.com/storage/docs/object-versioning`). Until the owner applies it,
  the test evidence bucket keeps old versions with no limit and no Firestore backup schedule exists, so
  the 35 days is not yet true.
- **Live voice caches the session (D-019).** To resume a dropped connection, Google stores the session's
  text, audio and video and the model's outputs for up to 24 hours, under project-level privacy
  (`documents/docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention`).
  Voice is not zero-retention; [AI.md](../AI.md) lists the
  other AI features' settings.
- **Model Armor's own logging is off.** Sanitize-operation logs hold full prompts and replies
  (`documents/docs.cloud.google.com/model-armor/configure-logging`), so they would be personal data in logs.
- **Data Access audit logs** record who read or wrote user data, but are off by default for most
  services and are enabled per service (`documents/docs.cloud.google.com/logging/docs/audit/configure-data-access`).
  They hold metadata, not the data. Which services DryScope turns them on for is not decided yet; nothing enables them today.
- **Offline drafts on iPhone (D-025).** Drafts are kept on the phone only in the installed Home Screen app;
  in a Safari tab the field screens work online only. Stage S6.
