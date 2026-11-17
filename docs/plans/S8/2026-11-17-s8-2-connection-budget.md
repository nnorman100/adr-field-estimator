# S8 plan, correction, 2026-11-17: S8-2 connection budget

Part of [the S8 plan](../S8.md), section 15.

Building [S8-2](S8-2.md) showed that the planned pool sizes fit neither database. With a main pool of 5, an instance opens 10 connections (5 main, 4 access renewal, 1 probe). Two revisions at the maximum instances, plus the migrator and the reserve of 10, came to 71 on test (3 instances; `db-f1-micro` allows 25 by default) and 211 on live (10 instances; `db-custom-1-3840` allows 100 by default). Today's code was already over the same rule (47 and 131).

The owner chose (2026-11-17):

- Pools per instance: main 3, access renewal 2, probe 1, so 6 in total, as many as today's code opens (1 + 4 + 1). The code alone does not raise connections.
- The web app's maximum instances: test 3 to 1, live 10 to 7, in the same pull request. The budget is then 2 x 1 x 6 + 11 = 23 of 25 on test and 2 x 7 x 6 + 11 = 95 of 100 on live. The owner applies the app root before the code is released, then stages the revision the apply made at a tagged address, smoke-checks it and moves traffic to it ([runbook](../../runbook/terraform-apply.md#stage-s8-web-app-maximum-instances-s8-2)). The plan check (`infra/dryscope/scripts/check-plan.js`) lets that re-apply move the web app's maximum instances in place to these two values and no others.
- The limits of 25 and 100 are the tiers' defaults until the owner reads `max_connections` on each database (section 7, step K).
- The drain precondition is enforced in the test release now, in its time-only form: staging waits until 15 minutes after the service last changed. Cloud Run keeps an idle instance, which "might persist resources, such as open database connections", for up to 15 minutes ([Google](https://docs.cloud.google.com/run/docs/about-instance-autoscaling), "Idle instances"). The time is the service's `updateTime` in the Cloud Run Admin API v2, which the deploy account already reads, so a rollback or a move by hand counts too. Reading the revisions' actual instance counts (the Cloud Monitoring metric `run.googleapis.com/container/instance_count`) needs a monitoring read permission the deploy account does not have; switching to it is a later owner choice.
- When the Live relay (S7) starts using the database, its instances join this budget (test max 2, live max 10 today).
