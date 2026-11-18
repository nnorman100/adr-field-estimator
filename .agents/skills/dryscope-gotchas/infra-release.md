# Terraform, IAM, releases and Cloud Run

- **Gate every new resource to the environment the step names.** "Test only" resources have reached the live root, where a live apply would have granted the role too. Test and live never share an identity pool.
- **Grant exactly the approved list.** An extra permission, a dropped condition or a role that also allows delete is a finding. If the approved list does not work, ask; do not widen it.
- **The plan checker reads committed plan fixtures.** After changing a limit or a resource, regenerate the fixtures in your own commit (they are protected paths), or the checker keeps approving the old numbers.
- **What is serving is the revisions that receive traffic**, not the service's latest template, which can belong to a revision that failed its check and never took traffic.
- **A new revision gets no traffic until it is promoted**, and settings on it are not live until then. Runbook steps that assume otherwise never take effect.
- **During a rollout two revisions hold database connections**, and idle instances keep theirs for about 15 minutes. Wait for the old revision to drain, re-reading its state each time you check.
- **A new revision inherits environment values from the template.** A value you did not set is the old value or empty, not a default.
- **A minimum instance count set on the revision bills for every tagged revision.**
