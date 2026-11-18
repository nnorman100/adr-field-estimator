# Estimate documents, prices and AI

- **Customer-facing sentences and their order are approved text.** Do not add a sentence to every proposal, extend an approved sentence, or move terms below the signature. Quote the wording you propose and ask.
- **"Prints exactly as entered" rules out `.trim()` and any other tidy-up** on company clauses, names and labels. Check length on the text as stored. Use the company's own label, never a default in code.
- **Every control an owner can set must change a price, or not be shown.** Reviewers have found a drying-days setting, default quantities and a taxable flag that the engine ignored.
- **The printed lines must sum to the stored total.** Adjustments, minimums and job charges belong in the Proposal and the Itemized claim too. If the high end falls below the low end, fix the lines; do not overwrite the total.
- **Whole-job square footage counts each room's affected area once**, across flat-priced and bracketed lines alike.
- **Do not check model output by keywords.** A keyword test passes the opposite meaning ("No asbestos or lead testing is required") and swapped numbers. Check structure and meaning, and apply each rule to every field the model can write: testing advice has survived in the summary after being cleared from its own field.
- **A missing year built is not "1978 or later".** Decide what the document says when the year is unknown; do not let it fall into the no-testing branch.
- **No customer name, address or coordinates in any prompt.** Free-text job notes can contain them, so sending notes whole breaks the rule. Seen once in review, but it is a privacy rule, so check it every time you build a prompt.
- **Every AI call carries its spending context.** A refusal for the allowance needs a `Retry-After`, and the phone must wait for it. Count token-counting and ledger time inside the request's deadline, or paid output is thrown away.
