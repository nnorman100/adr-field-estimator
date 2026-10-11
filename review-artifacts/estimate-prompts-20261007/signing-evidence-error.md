# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workflows.spec.js >> durable signing receipt survives evidence display failure
- Location: tests\browser\workflows.spec.js:180:44

# Error details

```
Test timeout of 45000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - banner [ref=f1e2]:
    - link "Alert Disaster Restoration home" [ref=f1e3]:
      - /url: /
      - img "Alert Disaster Restoration" [ref=f1e4]
      - strong [ref=f1e5]: Field Estimator
    - group [ref=f1e7]:
      - generic "Account +" [ref=f1e8] [cursor=pointer]
  - generic [ref=f1e9]:
    - generic [ref=f1e10]:
      - generic [ref=f1e11]:
        - text: FIELD INSPECTION
        - heading "Synthetic browser property" [level=1] [ref=f1e12]
        - status [ref=f1e13]: Saved & signed · ADR-AUTH-86dae026-f110-4385-942c-a17317879ff5
      - group [ref=f1e14]:
        - generic "Jobs +" [ref=f1e15] [cursor=pointer]
    - navigation "Inspection tasks" [ref=f1e16]:
      - button "01 Property" [ref=f1e17] [cursor=pointer]:
        - generic [ref=f1e18]: "01"
        - text: Property
      - button "02 Walkthrough" [ref=f1e19] [cursor=pointer]:
        - generic [ref=f1e20]: "02"
        - text: Walkthrough
      - button "03 Evidence" [ref=f1e21] [cursor=pointer]:
        - generic [ref=f1e22]: "03"
        - text: Evidence
      - button "04 Review" [ref=f1e23] [cursor=pointer]:
        - generic [ref=f1e24]: "04"
        - text: Review
  - status [ref=f1e25]: Signed agreement restored. The original cannot be edited.
  - main
  - generic [ref=f1e27]:
    - generic [ref=f1e28]:
      - generic [ref=f1e29]:
        - text: CLAIMS HUB
        - heading "Review before signing" [level=2] [ref=f1e30]
      - group [ref=f1e31]:
        - generic "Export +" [ref=f1e32] [cursor=pointer]
    - generic [ref=f1e33]:
      - generic [ref=f1e34]:
        - generic [ref=f1e35]: Customer estimate range
        - strong [ref=f1e36]: $1,208.00–$1,221.90
      - generic [ref=f1e37]:
        - generic [ref=f1e38]: Itemized charges at base rates
        - strong [ref=f1e39]: $1,208.00
    - status [ref=f1e40]: 1 of 4 documents opened · Review each before signing.
    - navigation "Claim documents" [ref=f1e41]:
      - button "ADR proposal" [pressed] [ref=f1e42] [cursor=pointer]
      - button "Itemized claim" [ref=f1e43] [cursor=pointer]
      - button "Defense letter" [ref=f1e44] [cursor=pointer]
      - button "Photo audit log" [ref=f1e45] [cursor=pointer]
    - article [ref=f1e46]:
      - generic [ref=f1e47]:
        - img "Alert Disaster Restoration" [ref=f1e48]
        - paragraph [ref=f1e49]: "3300 Patton Way · Bakersfield, CA 93308(661) 426-2151 · CSLB #950983"
      - heading "Alert Disaster Restoration · Official ADR Proposal" [level=2] [ref=f1e50]
      - generic [ref=f1e51]:
        - paragraph [ref=f1e52]: Synthetic browser property
        - paragraph [ref=f1e53]: 10-07-2026
        - paragraph [ref=f1e54]: "Estimator: Matthew Myers · CSLB #950983"
        - paragraph [ref=f1e55]: "Customer estimate range: $1,208.00–$1,221.90"
        - paragraph [ref=f1e56]: "Itemized charges at base rates: $1,208.00"
        - heading "Findings" [level=3] [ref=f1e57]
        - paragraph [ref=f1e58]: Due to property age (1960), California State Law requires third-party lead and asbestos testing prior to destructive demolition.
        - heading "Proposed scope" [level=3] [ref=f1e59]
        - paragraph [ref=f1e60]: "Room 1: category 1 finished/drywall/trim demolition"
        - paragraph [ref=f1e61]: (this does not include the pretest for lead/asbestos)
        - heading "AI summary · technician review required" [level=3] [ref=f1e62]
        - paragraph [ref=f1e63]: <img src=x onerror="window.reviewInjected=true"> Confirmed scope summary.
        - heading "AI suggestions · outside the authorized scope" [level=3] [ref=f1e64]
        - paragraph [ref=f1e65]: Document drying progress.
      - status [ref=f1e66]: Signed agreement and evidence restored.
      - img "Saved homeowner or representative signature" [ref=f1e67]
  - generic [ref=f1e68]:
    - generic [ref=f1e69]: Confirm scope before generating documents.
    - button "Save draft" [disabled] [ref=f1e70]
    - button "Finish & review" [disabled] [ref=f1e71]
  - contentinfo [ref=f1e72]: Alert Disaster Restoration · Private field inspections
```