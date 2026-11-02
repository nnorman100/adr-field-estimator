# Pricing source

Each company sets its own prices. DryScope has no default price list, and one company's rates are never used for another.

- **A company with no published prices cannot price an estimate.** The audit answers 409 and the job stays a draft. The owner is told "Set your company prices before your first estimate", with a Set company prices button while the editor is on; estimators and office staff are told to ask the owner.
- **Owners publish prices under Company prices** (behind `PRICE_BOOKS_ENABLED`), or import the CSV/XLSX template. The template for a company without prices lists item names and units with blank prices. See [Company workspaces](company-workspaces.md#company-prices). While the flag is off the editor is unavailable, so the flag must be on before a company other than ADR can price anything.
- **The browser gets prices only from the API,** for the signed-in company. No rate is written in `public/`; `tests/test_no_adr_default.py` checks that.
- **Rates live on the server as data:** a published book is stored per company, and each job pins the book it was first priced from. A published book applies to new pricing from the server's publication time. An existing draft keeps its saved rates until the owner reviews and applies new prices to that one draft. Signed records never change.
- **Formulas, waste and range factors, default quantities and mandatory wording stay in code** (`backend/claims.py`) for now, under `CALCULATION_VERSION`.

ADR's rates are ADR's proprietary data. They sit in `backend/adr_price_book.py` and ADR's own price-book record, are used only for company `adr`, and their source notes are in [ADR pricing source](adr-pricing-source.md). `scripts/migrate_price_books.py` writes them as ADR's book and refuses any other company; see [ADR price book](../RELEASES.md#adr-price-book). An older book or unsigned draft in another company that holds ADR's rates is refused rather than used; signed records stay viewable.

For pricing work outside the catalog and its treatment in the estimate range, see [Priced additional work](priced-extras.md).
