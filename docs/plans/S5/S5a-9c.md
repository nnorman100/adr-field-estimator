# S5 plan, step S5a-9c

Part of [the S5 plan](../S5.md), section 5, "Ordered steps".

**S5a-9c Photo log grouping (added 2026-11-13, D7).** UI: the Photo audit log on Review shows the company's grouping; the setting is on Company settings (S5a-4b). FE: that view. BE: the photo log groups photos by `photo_log_grouping`: `room` (the default, today's order) or `shot_tag`, in albums in the shot-tag order of the field map (`web/src/lib/field/schema.ts`: overview, source, surface, meter, contents, equipment), untagged photos last; each album keeps capture order and each photo still names its room. Only the order and the album headings change: the photo ids and hashes listed are the snapshot's (section 4, step 4). DB no. Tests: both groupings on one job; untagged photos; the same photos with the same hashes in both; the default unchanged from S5a-9. Needs: S5a-9, S5a-4b.
