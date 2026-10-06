# AGENTS.md - Agent Operating Guidelines & Domain Knowledge

This document specifies the operational protocols, business rules, architectural patterns, and safety constraints for AI agents working in this repository.

---

## 1. Project Mission & Identity

- **Company**: **Alert Disaster Restoration**
- **Location**: Bakersfield, CA (Serving Kern County and surrounding areas)
- **License**: California State License Board (CSLB) **#950983**
- **Estimator Sign-off**: Matthew Myers
- **Core Purpose**: Provide field technicians with a multimodal AI assistant that conducts real-time video/voice walkthroughs on iPhones and instantly synthesizes complete, adjuster-ready claims and client-facing proposals.

---

## 2. Dual-Engine Architecture Guidelines

### Engine 1: Real-Time Field Walkthrough (`gemini-live`)
- **Transport**: Bidirectional WebSocket (`WSS`) directly from mobile client or via ephemeral token relay.
- **Payloads**:
  - Outbound Audio: 16kHz PCM (single channel, little-endian).
  - Outbound Video: 1 FPS JPEG frames (compressed to 720p/1080p).
- **Latency Target**: Sub-second conversational turnaround in technician's Bluetooth earpiece.
- **HUD Integration**:
  - Live Extech MO290 moisture meter HUD overlay.
  - FLIR thermal camera gradient emulation.
  - Asynchronous background photo capture with silent OCR tagger.

### Engine 2: Post-Walk Claims & Compliance Engine (`gemini-3.8-pro` / `gemini-2.5-pro`)
- **Transport**: Cloud Run REST microservice (`POST /api/audit`).
- **Input**: Walkthrough transcript, timestamped photos, property address, year built, crawl space flag, and equipment counts.
- **Output**: Structured JSON strictly conforming to the 4-document claims hub schema:
  1. Official ADR Proposal (flat-rate packaged proposal + e-signature).
  2. Itemized Xactimate Line Items with waste factors.
  3. Formal IICRC S500 / S520 insurance claim defense letter.
  4. Photo Moisture Audit Log.

---

## 3. Alert Disaster Restoration Pricing Book & Business Logic

When generating or auditing remediation costs, agents **must strictly adhere** to these formulas extracted from Alert's internal pricing book:

### A. Square Footage Demolition Rates
| Classification | Unfinished / Subfloor | Finished / Drywall / Trim |
| :--- | :--- | :--- |
| **Category 1 (Clean Water)** | \$1.21 / SF | \$2.78 / SF |
| **Category 2 (Gray Water)** | \$1.52 / SF | \$2.89 / SF |
| **Category 3 / Mold** | \$2.48 / SF | \$8.39 / SF (x2 if custom cabinetry) |

### B. Fixed Baseline Job Charges (\$1,180.20 Total)
Every job incorporates these baseline line items:
- **Emergency Call / Trip Charge**: \$133.95
- **Daily Monitoring (13.25 hours total)**: \$628.85
- **Haul Debris & Disposal**: \$159.53
- **Air Scrubber Daily Rental**: \$74.75
- **HEPA Replacement Filter**: \$183.12

### C. Drying Equipment Rates
- **Axial Air Movers / Fans**: \$29.25 per unit / per day.
- **Commercial LGR Dehumidifiers**: \$101.25 per unit / per day.
- *Standard IICRC S500 Drying Duration*: Baseline is 3 days (e.g., 3 fans + 1 dehu for 3 days = \$567.00).

### D. Labor Rates
- **Regular Business Hours**: \$47.46 / hr.
- **After-Hours / Emergency**: \$83.45 / hr.

### E. Standard Packaging Tiers
Alert packages typical single/multi-room jobs into clean proposal numbers:
- \$1,499.00 (Small ceiling drywall spot demo)
- \$1,999.00 (Standard bathroom / small vanity pull)
- \$2,049.99 – \$2,199.00 (Master bath / flooring credit)
- \$2,299.00 (Bathroom + adjacent hall / closet)
- \$2,499.00 (Kitchen sink cavity + cabinet flood cut + granite prop)
- \$2,799.00 (Tile demo + subfloor drying)
- \$2,999.00 (Garage water heater platform loss)
- \$3,999.00 – \$4,999.00 (Multi-room / multi-unit emergency)

---

## 4. California Regulatory & Compliance Rules

### A. The 1978 Pre-Test Rule (Title 8 & EPA RRP)
- **If Year Built < 1978**:
  - The proposal **must** include the explicit notice: *(this does not include the pretest for lead/asbestos)*.
  - Findings must state: *"Due to property age ({yearBuilt}), California State Law requires third-party lead and asbestos testing prior to destructive demolition."*
- **If Year Built >= 1978**:
  - Findings state no pre-testing is required.

### B. Standard ADR Scoping Disclaimers
Agents must preserve these exact legal disclaimers:
- **Granite Countertops**: *"The technician will prop the granite countertop as the cabinets are removed. The granite and backsplash can break during the removal process."*
- **Water Heater Garage Losses**: *"Alert Disaster will coordinate with Can Do Crew to put the water heater in a temporary state... Homeowner to hire competent professional to reset."*
- **Crawl Spaces**: Always specify if a crawl space exists (*"There is a crawl space"*).

---

## 5. Deployment & Infrastructure Guardrails

### A. Firebase Hosting Multi-Site Isolation
- The GCP project `mitigation-project` contains multiple hosting sites.
- **NEVER** run a blanket `firebase deploy`.
- **ALWAYS** deploy with target isolation:
  ```bash
  firebase deploy --only hosting:alert-disaster --project mitigation-project
  ```
- Keep `public/index.html` and `index.html` synchronized at all times.

### B. Google Cloud Run Microservice
- Service Name: `alert-disaster-field-estimator`
- Region: `us-west2`
- Project: `mitigation-project`
- Command:
  ```bash
  gcloud run deploy alert-disaster-field-estimator --source ./backend --region us-west2 --project mitigation-project --allow-unauthenticated
  ```

### C. Security & Credentials
- Do not commit Google Cloud service account keys or raw API keys into git.
- The Cloud Run service leverages Google Cloud Application Default Credentials (ADC) to authenticate with Vertex AI / Google Gen AI SDK.
