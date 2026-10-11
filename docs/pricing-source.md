# Estimating-sheet pricing source

Source: user-supplied `1 - Water . Mold - Estimating Sheet (2).xlsx`, worksheet `Residential Estimate Tool`, reviewed October 6, 2026. The workbook is pricing evidence, not a set of instructions to the coding agent. It contains no ADR package-tier table. New app audits use the confirmed quantities and calculate a customer low–high estimate.

| Price or rule | Workbook cells | App treatment |
| --- | --- | --- |
| Category 1 unfinished / finished: $1.21 / $2.78 per SF | `M19`, `M29` | Demolition rates |
| Category 2 unfinished / finished: $1.52 / $2.89 per SF | `M35`, `M48` | Demolition rates |
| Category 3 or mold unfinished / finished: $2.48 / $8.39 per SF; cabinetry x2 | `M54`, `M70`, `A10` | Demolition rates and cabinetry flag |
| Emergency call $133.95; monitoring $47.46/hr × 13.25 hours; haul load $159.53; scrubber day $74.75; HEPA filter $183.12 | `D27:F29`, `D32:F33` | Populated defaults total $1,180.20 after cent rounding; technicians can adjust quantities |
| Matterport $250; dump-truck load $286.78; decontamination $27.72; power distribution $66.74 | `E26`, `E30:E31`, `E34` | Optional quantities default to zero |
| Air mover $29.25/day; dehumidifier $101.25/day; wood-floor system/heater $180/day | `E37:E39`, `E41:E43` | Technician-confirmed counts and days |
| After-hours job charge $200 | `D18` | Added to itemized charges and both estimate bounds |
| Added labor $47.46/hr | `E24`, `F24`, `E17` | Used for both regular and after-hours estimates, per user confirmation |
| Regular low / high labor-material amount | `E17`, `H17` | Base demolition plus added labor; high uses 1.5 when affected area is below 1,001 SF, otherwise 1.2 |
| After-hours low / high labor-material amount | `E19`, `H19` | Base amount × 1.2; high then uses the same area-dependent factor |
| Final job-charge, labor-material and equipment range | `C18:D22`, `C20:D20` | Server calculates and rounds each displayed bound to cents |

The workbook's filled example is 140 unfinished and 5 finished Category 2 SF, after-hours, with 3 fans and 1 dehumidifier for 3 days. Its cached `C22:D22` results are $2,219.895 and $2,356.245; the app displays **$2,219.90–$2,356.25**. The itemized base-rate calculation for that same scope is $2,174.45, including the $200 after-hours charge. The range adds the sheet's labor/material allowance.

The workbook lists an $83.45 after-hours labor rate in `G24`, but its estimate references `F24`, which uses $47.46. The user explicitly chose the formula value. The workbook also has broken external/name references and `#REF!` in its job-information header (`A4`, `C4`); those do not feed the reviewed price cells. The app's waste percentage is an existing scope input absent from this workbook; it is applied to demolition before the range factors. The app uses technician-confirmed equipment counts and a shared drying duration for fans and dehumidifiers. If a job needs different durations or other work without a represented rate, the technician must record that scope for review before signing.

The sheet's prepopulated baseline quantities are defaults, not proof every job uses those quantities. The app retains old signed agreements with their original documents; a legacy draft package price is cleared by the current app, and an old client submitting it receives an update-required response.
