# Lawyer checklist

Part of [the S8 plan](../S8.md), step [S8-1](S8-1.md). The one list the owner takes to the lawyer, and the working list for every open legal question. The answers are recorded in `docs/DECISIONS.md`. `docs/architecture/product-rules.md` 4C keeps the rule that wording stays exactly as it is until an answer is recorded, and each of its five items names its row here. `docs/plans/S7.md` step J (the AI terms) points here too.

Not legal advice. Every statute is a pointer for the lawyer to confirm, as in `docs/architecture/product-rules.md` 4C. Items marked **(gate)** are the four that L11 asks to have answered before the first real signature on live.

Each item has an id, the question, why it matters, where the answer lands in the product and what the app does until it is answered. The required-docs test (`tests/test_required_docs.js`) fails when an item lacks its id, its question or its "until then" line, or when 4C and this list cite different statutes, bills or codes for the five California items. Write statute sections with "§" so the test sees them.

**Fact sheet for the lawyer**

- **The product.** A phone web app sold to water and mold restoration companies. A company's technician inspects a loss, the app prices an estimate from that company's own prices, and the property owner signs on the phone or through a link. Four documents come out: a proposal, an itemized claim, a letter to the insurer citing the cleaning standards, and a photo log.
- **The parties.** The platform operator (the owner's business; the lawyer confirms which legal entity contracts). The company (a business customer). Its staff (users). The property owner (the company's customer, often a consumer signing at home). Sometimes an insurer's adjuster, who receives documents.
- **The data.** Staff names, emails and sign-in records. Each company's name, address, licence number and prices. The property owner's name, address, contact details, insurer and claim number. The year the home was built, rooms, measurements and findings. Photos of home interiors with the time taken. Drawn signatures with the signer's name and role. Voice during a walkthrough (sent to Google's AI service; a transcript is kept, no recording). AI drafts that a person reviews.
- **Where it is.** Google Cloud in the United States: the app, databases and files in Iowa; backups in Google's US multi-region; text AI in the US multi-region; live voice in Iowa. To resume a dropped voice session Google caches the session for up to 24 hours (D-019).
- **Who else processes it.** Google Cloud (hosting, sign-in, AI, reCAPTCHA). Planned: Resend (email), Stripe (billing).
- **How long.** Signed records never change. Deleted data leaves every backup within 35 days (D-023). A company that leaves gets 30 days read-only with an export, then closure.
- **AI.** Drafting the findings summary, filling the scope from spoken words, reading a meter from a photo, transcribing voice notes, a job summary, and a live voice walkthrough. A person approves anything a customer sees. AI never sets a price. The notice line on documents is decided (S7, V11).
- **Not done.** No sale or sharing of data, no advertising, no analytics yet, no card numbers held.
- **Who is live.** S8 ends with one live company, the owner's own, as the pilot (L16). Terms, privacy and data processing documents are needed before any other company goes live; pages for them in the app come later.

**A. Signing and customer documents (California)**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| A1 | The pre-1978 testing sentence: the mandated sentence in `product-rules.md` 4A, or the wording restoration companies print today (W1). Which satisfies the rule? | The sentence prints on every document for a home built before 1978, and a signed document can never be changed afterwards. | The engine's fixed clause | The mandated sentence stays |
| A2 **(gate)** | The licence label: "CSLB #" or "CA License #" on a proposal and a signed agreement (W4; Business and Professions Code §7030.5 as a pointer). | The label prints on every proposal and signed agreement, so a wrong label repeats on every job. | The engine's label | "CSLB #" stays |
| A3 **(gate)** | The right to cancel a contract signed at home (Civil Code §1689.6 and §1689.7; Business and Professions Code §7159; the 2025-26 bills SB 784 and AB 1327). Does it apply to mitigation and remediation? What text, where on the signed page, and does a remote link change it? | If a right to cancel applies and its notice is missing, a signed contract may be open to challenge after the work is done. | A fixed notice on the signed page, or the company's own text | DryScope prints no wording of its own; a company may enter its own |
| A4 **(gate)** | The emergency-repair waiver (Civil Code §1689.13): the wording, whether a signature on a phone or a link satisfies "separate, dated, signed", and whether work may start before the period ends. | Water mitigation usually starts the day of the visit, which may fall inside a cancellation period. | A separate signed statement in the signing flow | Not offered |
| A5 **(gate)** | Is a signature drawn on the technician's phone, or through a link the customer opens, valid for this contract (California's electronic transactions act, Civil Code §1633.1 and following; the federal E-SIGN consumer consent rule)? What consent wording is needed? | Every signed agreement in the product rests on this answer. | The signing page | The page records name, role, time and the exact document |
| A6 **(gate, with A5)** | The customer's copy. Email arrives later; today the customer gets a link by copy, share sheet or QR. Is that a sufficient copy at signing? | A consumer contract may require the customer to receive a copy at signing. | The signing and documents pages | Links only |
| A7 | Who may sign (owner, tenant, an agent, an insurer's representative) and what the signer-role field must say. | A signer without authority may not bind the property owner or whoever pays. | The signer-role list | The signer may pick Homeowner, Adjuster or Other, or none |
| A8 | Does this work fall under the home improvement contract rules (Business and Professions Code §7159) or the service and repair rules (§7159.10)? Required headings, notices and payment limits. | The two rule sets require different headings, notices and payment limits on the proposal. | Proposal layout and required notices | The company's own wording field |
| A9 | The standing estimate clauses (30-day validity, insurance repricing, exclusions): any that should change. | They print on every estimate, and only the owner may change them. | The engine's fixed clauses | They stay exactly as they are |
| A10 | A company's own start-work and payment wording: who answers for it. | Companies type their own contract wording into the app, and it prints as entered. | The terms (B3) | The company |

**B. Terms of service (operator and company)**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| B1 | The contracting entity, governing law and venue. | Every other term depends on who contracts and which law applies. | The terms of service | No terms; only the owner's own company is live (L16) |
| B2 | The company owns its data; what licence the operator needs to run the service. | The operator stores, copies and processes company data and must claim no more right than it needs. | The terms of service | No terms; only the owner's own company is live (L16) |
| B3 | The company answers for its prices, estimates, licence, contract wording and contractor-law duties; the operator gives no legal, insurance or pricing advice. | Prices and wording come from the company; the operator should not carry the risk of a company's estimate. | The terms of service | The app prints each company's identity, prices and wording exactly as entered |
| B4 | Service levels: a reply within one hour from 7am to 9pm Central, and 99.5% monthly uptime. Promise or goal, and what remedy. | A promise becomes a claim when it is missed. | The terms of service | Internal goals only; nothing is promised |
| B5 | The cap on liability, disclaimers and indemnities. | It limits the operator's exposure when an estimate or the service fails. | The terms of service | No terms; only the owner's own company is live (L16) |
| B6 | Ending and non-payment: read-only after failed payment, never deleted for non-payment; 30 days read-only with an export when a company leaves; 35 days in backups. | Billing builds these rules (SB-20 to SB-24), and the terms must say what the app does. | The terms of service and the billing screens | Not built; no company is billed during the pilot |
| B7 | Signed agreements after a company leaves: who keeps them and for how long. | The company and the property owner may need a signed agreement years later. | The terms of service and the retention rules in `docs/DATA.md` | Signed records are kept and never changed |
| B8 | Pilot terms for the first companies, and how acceptance is recorded (a signed order now; a click-through record later). | The first outside company needs terms it has accepted before it goes live. | A signed order; later a click-through record in the app | Only the owner's own company is live (L16) |
| B9 | Changing the terms: notice and consent. | A change binds a company only if the notice and consent rules are met. | The terms of service | No terms to change |

**C. Privacy policy**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| C1 | For each kind of data, is the operator the business or the company's service provider? | It decides who owes the property owner and staff each privacy duty. | The privacy policy and the data processing terms | No policy; `docs/DATA.md` records what is collected and kept |
| C2 | Does the California privacy law apply to the operator at this size, and what must the policy and the contract say either way? | It decides what the policy and the company contract must contain. | The privacy policy and the data processing terms | No policy; only the owner's own company is live (L16) |
| C3 | Notice to the property owner at collection: the company's duty or the operator's, and does the signing page need a line or a link? | The property owner never signs up to DryScope; their data arrives through the company. | The privacy policy, and possibly a line or link on the signing page | The signing page shows no privacy line |
| C4 | A property owner who writes to the operator to see or delete their data: the process (refer to the company). Signed records and the exceptions that let them be kept. | Requests will reach the operator, and signed records cannot be changed. | The privacy policy and the support process | No written process; signed records stay unchanged |
| C5 | Retention and deletion statements, including the 35 days in backups. | The policy must match what the system does (D-023). | The privacy policy | Retention is recorded in `docs/DATA.md` and D-023; nothing is published |
| C6 | Photos of home interiors, drawn signatures, and location if photo location is added. | Home interiors and signatures are sensitive, and location would add more. | The privacy policy | Photos and signatures are kept as company records; no photo location is recorded |
| C7 | Google sign-in and reCAPTCHA: the disclosures Google asks sites to make. | Google's terms ask for a disclosure when the reCAPTCHA badge is hidden, as it is here. | The sign-in screens and the privacy policy | The sign-in screens say "This site is protected by reCAPTCHA." while App Check is on |
| C8 | Device storage: only what the app needs to work offline, no analytics. What changes when analytics arrive. | Device storage rules depend on what is stored and why. | The privacy policy | Only what offline work needs is stored on the phone; no analytics |
| C9 | Companies outside California. | Other states have their own privacy laws. | The privacy policy and the terms | Only the owner's own company is live (L16) |

**D. Data processing terms**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| D1 | The service-provider addendum: purpose limits, no sale or sharing, confidentiality, security measures, help with requests, return and deletion, audits. | Without it the operator may not count as the company's service provider (C1). | The data processing terms | No addendum; only the owner's own company is live (L16) |
| D2 | The sub-processor list and notice of changes. | Companies must know who else processes their data. | The data processing terms | The list in the fact sheet above |
| D3 | Google's Cloud Data Processing Addendum: accepted by the owner; what flows down to companies. | Google's terms govern the operator's own processing, and some of them must pass to companies. | The data processing terms | Accepted by the owner; nothing passed on |
| D4 | Breach notice to companies within 72 hours: the wording. | The time promised must be one the operator can meet. | The data processing terms and `docs/runbook/incidents.md` | No time is promised; the runbook leaves the wording to the owner and the lawyer |
| D5 | The statement that data stays in the United States. | Companies may rely on it, so it must stay true. | The data processing terms | True in fact (see the fact sheet); stated nowhere public |
| D6 | Support access: the operator reads a company's records read-only with an audit trail. The consent wording. | Support staff read customer records. | The data processing terms and the terms of service | Support access is read-only and audited; no consent wording |

**E. AI disclosure**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| E1 | The decided notice line ("The findings summary was drafted with AI assistance and reviewed by {technician name}.", V11): sufficient, and anywhere else needed? | It prints on documents a customer receives. | The documents' notice line | The decided line stays as decided |
| E2 | Terms lines: where AI runs; what may be said about Google not training on customer data (from Google's own terms); human review; AI never sets a price. | Companies and customers must know where their data goes and that AI never prices. | The terms of service | No terms; AI never sets a price and a person approves what a customer sees |
| E3 | The voice cache of up to 24 hours: the wording (D-019). | Google keeps a dropped voice session for up to 24 hours to resume it. | The terms of service | No terms line; voice is on for no live company yet (L12) |
| E4 | Do California's AI rules apply here (the AI transparency act, the automated-decision rules, the bot disclosure law)? | They may require notices or choices the app does not offer. | The app's notices and the terms | AI drafts only; a person approves anything a customer sees |
| E5 | Who bears an AI error that a person approved. | An approved AI error ends up on a signed record. | The terms of service | No terms; the notice line names the technician who approved the draft |

**F. Voice in a customer's home**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| F1 | A walkthrough streams the technician's voice to an AI service and keeps a transcript. A property owner nearby may be heard. Does California's all-party consent rule (Penal Code §632) or another recording law apply when no recording is stored? | Property owners speak during walkthroughs. | The walkthrough's start screen and the terms | Voice is on for no live company yet (L12); no audio is kept |
| F2 | The notice or consent: what the technician says and what the app shows. | The technician needs exact words to say. | The walkthrough's start screen | Voice is on for no live company yet (L12) |
| F3 | Voice notes, and any future stored recording (S7, V8 B). | A stored recording would need consent and a retention class. | The voice note screen and the terms | No audio is kept; only the transcript (V8 A) |

**G. Insurance and claim wording**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| G1 | The itemized claim and the letter to the insurer: could preparing or sending them be acting as a public adjuster without a licence (Insurance Code §15006 and following), for the company or for the operator? Wording to avoid. | Two of the four documents are written for the insurer. | The itemized claim, the letter and the terms | The documents print as they do today |
| G2 | Marketing words such as "adjuster-ready". | Marketing words can suggest the company or operator adjusts claims. | The public site (its own plan) and the product's own text | No public site yet |
| G3 | Citing the cleaning standards by name in documents. | The standards' owners may limit how their names are used. | The letter and the documents | The letter cites the standards by name |

**H. Breach plan**

| Id | Question | Why it matters | Where the answer lands | Until then |
| --- | --- | --- | --- | --- |
| H1 | Who decides and who notifies whom. | A breach leaves no time to work this out. | `docs/runbook/incidents.md` | The runbook: contain, look, fix, and tell affected companies in wording the owner and the lawyer decide |
| H2 | The operator's duties as a service provider and as the holder of staff accounts (Civil Code §1798.82). | The operator owes notice in two roles. | `docs/runbook/incidents.md` and the data processing terms | As H1 |
| H3 | Template notices; cyber insurance. | Templates save hours when a notice is due. | `docs/runbook/incidents.md` | No templates; no cyber insurance recorded |

**I. Later**

With billing: automatic renewal (Business and Professions Code §17600 and following), tax on the subscription (the accountant), refunds, price changes. With email: commercial email rules. With the public site: marketing claims, the name "DryScope" as a mark, an accessibility statement.
