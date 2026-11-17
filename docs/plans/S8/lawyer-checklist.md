# Lawyer checklist

Part of [the S8 plan](../S8.md), step [S8-1](S8-1.md). The one list the owner takes to the lawyer; the answers are recorded in `docs/DECISIONS.md`, and `docs/architecture/product-rules.md` 4C keeps the rule that wording stays exactly as it is until an answer is recorded.

Not legal advice. Every statute is a pointer for the lawyer to confirm, as in `docs/architecture/product-rules.md` 4C. Items marked **(gate)** are the four that L11 asks to have answered before the first real signature on live.

**Fact sheet for the lawyer**

- **The product.** A phone web app sold to water and mold restoration companies. A company's technician inspects a loss, the app prices an estimate from that company's own prices, and the property owner signs on the phone or through a link. Four documents come out: a proposal, an itemized claim, a letter to the insurer citing the cleaning standards, and a photo log.
- **The parties.** The platform operator (the owner's business; the lawyer confirms which legal entity contracts). The company (a business customer). Its staff (users). The property owner (the company's customer, often a consumer signing at home). Sometimes an insurer's adjuster, who receives documents.
- **The data.** Staff names, emails and sign-in records. Each company's name, address, licence number and prices. The property owner's name, address, contact details, insurer and claim number. The year the home was built, rooms, measurements and findings. Photos of home interiors with the time taken. Drawn signatures with the signer's name and role. Voice during a walkthrough (sent to Google's AI service; a transcript is kept, no recording). AI drafts that a person reviews.
- **Where it is.** Google Cloud in the United States: the app, databases and files in Iowa; backups in Google's US multi-region; text AI in the US multi-region; live voice in Iowa. To resume a dropped voice session Google caches the session for up to 24 hours (D-019).
- **Who else processes it.** Google Cloud (hosting, sign-in, AI, reCAPTCHA). Planned: Resend (email), Stripe (billing).
- **How long.** Signed records never change. Deleted data leaves every backup within 35 days (D-023). A company that leaves gets 30 days read-only with an export, then closure.
- **AI.** Drafting the findings summary, filling the scope from spoken words, reading a meter from a photo, transcribing voice notes, a job summary, and a live voice walkthrough. A person approves anything a customer sees. AI never sets a price. The notice line on documents is decided (S7, V11).
- **Not done.** No sale or sharing of data, no advertising, no analytics yet, no card numbers held.

**A. Signing and customer documents (California)**

| Id | Question | Where the answer lands | Until then |
| --- | --- | --- | --- |
| A1 | The pre-1978 testing sentence: the mandated sentence in `product-rules.md` 4A, or the wording restoration companies print today (W1). Which satisfies the rule? | The engine's fixed clause | The mandated sentence stays |
| A2 **(gate)** | The licence label: "CSLB #" or "CA License #" on a proposal and a signed agreement (W4; Business and Professions Code 7030.5 as a pointer). | The engine's label | "CSLB #" stays |
| A3 **(gate)** | The right to cancel a contract signed at home (Civil Code 1689.6 and 1689.7; Business and Professions Code 7159; the 2025-26 bills). Does it apply to mitigation and remediation? What text, where on the signed page, and does a remote link change it? | A fixed notice on the signed page, or the company's own text | DryScope prints no wording of its own; a company may enter its own |
| A4 **(gate)** | The emergency-repair waiver (Civil Code 1689.13): the wording, whether a signature on a phone or a link satisfies "separate, dated, signed", and whether work may start before the period ends. | A separate signed statement in the signing flow | Not offered |
| A5 **(gate)** | Is a signature drawn on the technician's phone, or through a link the customer opens, valid for this contract (California's electronic transactions act, Civil Code 1633.1 and following; the federal E-SIGN consumer consent rule)? What consent wording is needed? | The signing page | The page records name, role, time and the exact document |
| A6 **(gate, with A5)** | The customer's copy. Email arrives later; today the customer gets a link by copy, share sheet or QR. Is that a sufficient copy at signing? | The signing and documents pages | Links only |
| A7 | Who may sign (owner, tenant, an agent, an insurer's representative) and what the signer-role field must say. | The signer-role list | Free choice from a list |
| A8 | Does this work fall under the home improvement contract rules (Business and Professions Code 7159) or the service and repair rules (7159.10)? Required headings, notices and payment limits. | Proposal layout and required notices | The company's own wording field |
| A9 | The standing estimate clauses (30-day validity, insurance repricing, exclusions): any that should change. | The engine's fixed clauses | They stay exactly as they are |
| A10 | A company's own start-work and payment wording: who answers for it. | The terms (B4) | The company |

**B. Terms of service (operator and company)**

| Id | Question |
| --- | --- |
| B1 | The contracting entity, governing law and venue. |
| B2 | The company owns its data; what licence the operator needs to run the service. |
| B3 | The company answers for its prices, estimates, licence, contract wording and contractor-law duties; the operator gives no legal, insurance or pricing advice. |
| B4 | Service levels: a reply within one hour from 7am to 9pm Central, and 99.5% monthly uptime. Promise or goal, and what remedy. |
| B5 | The cap on liability, disclaimers and indemnities. |
| B6 | Ending and non-payment: read-only after failed payment, never deleted for non-payment; 30 days read-only with an export when a company leaves; 35 days in backups. |
| B7 | Signed agreements after a company leaves: who keeps them and for how long. |
| B8 | Pilot terms for the first companies, and how acceptance is recorded (a signed order now; a click-through record later). |
| B9 | Changing the terms: notice and consent. |

**C. Privacy policy**

| Id | Question |
| --- | --- |
| C1 | For each kind of data, is the operator the business or the company's service provider? |
| C2 | Does the California privacy law apply to the operator at this size, and what must the policy and the contract say either way? |
| C3 | Notice to the property owner at collection: the company's duty or the operator's, and does the signing page need a line or a link? |
| C4 | A property owner who writes to the operator to see or delete their data: the process (refer to the company). Signed records and the exceptions that let them be kept. |
| C5 | Retention and deletion statements, including the 35 days in backups. |
| C6 | Photos of home interiors, drawn signatures, and location if photo location is added. |
| C7 | Google sign-in and reCAPTCHA: the disclosures Google asks sites to make. |
| C8 | Device storage: only what the app needs to work offline, no analytics. What changes when analytics arrive. |
| C9 | Companies outside California. |

**D. Data processing terms**

| Id | Question |
| --- | --- |
| D1 | The service-provider addendum: purpose limits, no sale or sharing, confidentiality, security measures, help with requests, return and deletion, audits. |
| D2 | The sub-processor list and notice of changes. |
| D3 | Google's Cloud Data Processing Addendum: accepted by the owner; what flows down to companies. |
| D4 | Breach notice to companies within 72 hours: the wording. |
| D5 | The statement that data stays in the United States. |
| D6 | Support access: the operator reads a company's records read-only with an audit trail. The consent wording. |

**E. AI disclosure**

| Id | Question |
| --- | --- |
| E1 | The decided notice line ("The findings summary was drafted with AI assistance and reviewed by {technician name}."): sufficient, and anywhere else needed? |
| E2 | Terms lines: where AI runs; what may be said about Google not training on customer data (from Google's own terms); human review; AI never sets a price. |
| E3 | The voice cache of up to 24 hours: the wording (D-019). |
| E4 | Do California's AI rules apply here (the AI transparency act, the automated-decision rules, the bot disclosure law)? |
| E5 | Who bears an AI error that a person approved. |

**F. Voice in a customer's home**

| Id | Question |
| --- | --- |
| F1 | A walkthrough streams the technician's voice to an AI service and keeps a transcript. A property owner nearby may be heard. Does California's all-party consent rule (Penal Code 632) or another recording law apply when no recording is stored? |
| F2 | The notice or consent: what the technician says and what the app shows. |
| F3 | Voice notes, and any future stored recording (S7, V8 B). |

**G. Insurance and claim wording**

| Id | Question |
| --- | --- |
| G1 | The itemized claim and the letter to the insurer: could preparing or sending them be acting as a public adjuster without a licence (Insurance Code 15006 and following), for the company or for the operator? Wording to avoid. |
| G2 | Marketing words such as "adjuster-ready". |
| G3 | Citing the cleaning standards by name in documents. |

**H. Breach plan**

| Id | Question |
| --- | --- |
| H1 | Who decides and who notifies whom. |
| H2 | The operator's duties as a service provider and as the holder of staff accounts (Civil Code 1798.82). |
| H3 | Template notices; cyber insurance. |

**I. Later**

With billing: automatic renewal (Business and Professions Code 17600 and following), tax on the subscription (the accountant), refunds, price changes. With email: commercial email rules. With the public site: marketing claims, the name "DryScope" as a mark, an accessibility statement.
