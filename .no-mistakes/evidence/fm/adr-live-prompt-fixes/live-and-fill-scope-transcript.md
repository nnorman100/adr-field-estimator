### Live ready message
{
  "type": "ready",
  "model": "gemini-3.8-live",
  "protocol_version": 2,
  "connection_id": "55f8e2fc339b49c087150a601064f351",
  "voice": "Charon",
  "token_refresh": true,
  "recovery": "new",
  "audio_ack": 10
}

### Company identity JSON as sent to Vertex Live
{
  "name": "Alert Disaster Restoration",
  "proposal_signoff_name": "Matthew Myers"
}

### Fill scope: both water and mold -> category 3 (HTTP 200)
{
  "inspection_id": "ADR-INS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2",
  "revision": 1,
  "changes": [
    {
      "field": "category",
      "room": "Office",
      "value": 3,
      "source_quote": "Office: water, mold, or both? Both."
    },
    {
      "field": "finished_sf",
      "room": "Office",
      "value": 20,
      "source_quote": "20 square feet of finished drywall demolition."
    }
  ],
  "questions": []
}

### Fill scope: water category 1 with "no evidence of mold" stays 1 (HTTP 200)
{
  "inspection_id": "ADR-INS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3",
  "revision": 1,
  "changes": [
    {
      "field": "category",
      "room": "Bathroom",
      "value": 1,
      "source_quote": "Bathroom, category 1 water; no evidence of mold."
    }
  ],
  "questions": []
}

### Fill scope: model returns string "mold" -> rejected, not silently mapped (HTTP 502)
{
  "detail": "Scope suggestions could not be verified. Clarify the recorded room, category and quantities, then retry."
}

### Fill scope: conflicting mold/correction categories -> rejected (HTTP 502)
{
  "detail": "Scope suggestions could not be verified. Clarify the recorded room, category and quantities, then retry."
}

### RESULTS
{
  "signoff_labeled": true,
  "no_unlabeled_matthew_in_instructions": true,
  "do_not_address_by_name": true,
  "fill_scope_handoff": true,
  "no_submit_wording": true,
  "water_mold_both_question": true,
  "mold_maps_cat3": true,
  "context_is_saved_inspection": true,
  "fill_both_cat3": true,
  "scope_prompt_maps_mold": true,
  "fill_negated_mold_stays_1": true,
  "fill_string_mold_rejected": true,
  "fill_conflict_rejected": true
}
