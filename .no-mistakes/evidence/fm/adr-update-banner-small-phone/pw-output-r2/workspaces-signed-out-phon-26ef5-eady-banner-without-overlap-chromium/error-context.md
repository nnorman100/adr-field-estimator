# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspaces.spec.js >> signed-out phone header at 320×844 fits the Update ready banner without overlap
- Location: tests/browser/workspaces.spec.js:819:1

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 0
Received:   0
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Alert Disaster Restoration home":
      - /url: /
      - img "Alert Disaster Restoration"
    - generic [ref=e3]:
      - generic [ref=e4]: Update ready.
      - button "Save & update" [ref=e5] [cursor=pointer]
    - generic [ref=e6]:
      - button "Help" [ref=e7] [cursor=pointer]: "?"
      - button "Sign in with Google" [ref=e8] [cursor=pointer]: Sign in
      - group [ref=e9]:
        - generic "Account +" [ref=e10] [cursor=pointer]
  - region "Sign in" [ref=e11]:
    - generic [ref=e12]:
      - heading "Sign in with email" [level=2] [ref=e13]
      - paragraph [ref=e14]:
        - text: Use
        - strong [ref=e15]: Sign in
        - text: above for Google, or your email and password. New staff set a password with the link in your invitation email.
      - generic [ref=e16]:
        - text: Email
        - textbox "Email" [ref=e17]
      - generic [ref=e18]:
        - text: Password
        - textbox "Password" [ref=e19]
      - generic [ref=e20]:
        - button "Sign in" [ref=e21] [cursor=pointer]
        - button "Forgot password" [ref=e22] [cursor=pointer]
  - generic: + +
  - generic [ref=e23]:
    - generic [ref=e24]:
      - generic [ref=e25]:
        - text: FIELD INSPECTION
        - heading "New inspection" [level=1] [ref=e26]
        - status [ref=e27]: Sign in to save a private inspection.
      - group [ref=e28]:
        - generic "Jobs +" [ref=e29] [cursor=pointer]
    - navigation "Inspection tasks" [ref=e30]:
      - button "01 Property" [ref=e31] [cursor=pointer]:
        - generic [ref=e32]: "01"
        - text: Property
      - button "02 Walkthrough" [ref=e33] [cursor=pointer]:
        - generic [ref=e34]: "02"
        - text: Walkthrough
      - button "03 Evidence" [ref=e35] [cursor=pointer]:
        - generic [ref=e36]: "03"
        - text: Evidence
      - button "04 Review" [ref=e37] [cursor=pointer]:
        - generic [ref=e38]: "04"
        - text: Review
  - main [ref=e39]:
    - region [ref=e40]:
      - generic [ref=e41]:
        - heading "Property & scope" [level=2] [ref=e42]
        - button "Go to walkthrough →" [ref=e43] [cursor=pointer]
      - button "Fill scope from walkthrough" [disabled] [ref=e44]
      - paragraph [ref=e45]: Stops capture and proposes values from your recorded observations. Review before applying.
      - group [ref=e47]:
        - generic [ref=e48]:
          - text: Property address
          - textbox "Property address" [disabled] [ref=e49]:
            - /placeholder: Enter the inspection address
        - generic [ref=e51]:
          - text: Year built
          - spinbutton "Year built" [disabled] [ref=e52]
        - generic [ref=e53]:
          - heading "Rooms & demolition" [level=3] [ref=e54]
          - button "Add room" [disabled] [ref=e55]
        - heading "Equipment & additional labor" [level=3] [ref=e56]
        - generic [ref=e57]:
          - generic [ref=e58]:
            - text: Air movers
            - spinbutton "Air movers" [disabled] [ref=e59]: "0"
          - generic [ref=e60]:
            - text: LGR dehumidifiers
            - spinbutton "LGR dehumidifiers" [disabled] [ref=e61]: "0"
          - generic [ref=e62]:
            - text: Drying days
            - spinbutton "Drying days" [disabled] [ref=e63]: "3"
          - generic [ref=e64]:
            - text: Additional labor hours
            - spinbutton "Additional labor hours" [disabled] [ref=e65]: "0"
        - generic [ref=e66]:
          - 'checkbox "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet''s $47.46/hr estimate formula." [disabled] [ref=e67]'
          - text: "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet's $47.46/hr estimate formula."
        - group [ref=e68]:
          - generic "Job charges and optional sheet items" [ref=e69] [cursor=pointer]
        - generic [ref=e70]:
          - text: Technician observations & scope notes
          - textbox "Technician observations & scope notes" [disabled] [ref=e71]:
            - /placeholder: Record observed conditions and requested work. Flag work outside the listed rates.
        - generic [ref=e72]:
          - checkbox "I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities." [disabled] [ref=e73]
          - text: I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities.
      - paragraph [ref=e74]: The estimating sheet provides a low–high customer range from the confirmed scope. Itemized charges show the base-rate calculation. Unpriced work requires correction before signing.
  - text: +
  - generic [ref=e75]:
    - button "Save draft" [disabled] [ref=e76]
    - button "Finish & review" [disabled] [ref=e77]
  - contentinfo [ref=e78]: Alert Disaster Restoration · Private field inspections
```

# Test source

```ts
  735 | ])
  736 |   for (const width of [320, 390])
  737 |     test(
  738 |       mode + ' phone at ' + width + '×844 keeps Start walkthrough clear of the Update ready banner',
  739 |       async ({ page, request, browserName }) => {
  740 |         await page.setViewportSize({ width, height: 844 });
  741 |         if (mode === 'legacy owner-only') {
  742 |           await request.post('/__test/workspaces', { data: { enabled: false } });
  743 |           await page.goto('/');
  744 |           await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  745 |         } else if (mode.startsWith('other company')) {
  746 |           await start(page, 'other');
  747 |           await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
  748 |           if (mode.endsWith('with logo'))
  749 |             await page.evaluate(() => {
  750 |               const logo = document.querySelector('.masthead .brand img');
  751 |               logo.src = '/brand/adr-logo.jpg';
  752 |               logo.hidden = false;
  753 |             });
  754 |           await page.getByRole('button', { name: 'New job', exact: true }).click();
  755 |         } else {
  756 |           await start(page, mode);
  757 |           await navigate(page, 'dashboardJobs');
  758 |           await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  759 |         }
  760 |         await expect(page.locator('#address')).toBeEnabled();
  761 |         await page.locator('.task-nav [data-task="walkthrough"]').click();
  762 |         await expect(page.locator('#startWalk')).toBeVisible();
  763 |         const startTop = () =>
  764 |           page.locator('#startWalk').evaluate((el) => el.getBoundingClientRect().top);
  765 |         const before = await startTop();
  766 |         await showUpdateBanner(page);
  767 |         // The banner shares the masthead row, so it must not push Start walkthrough down.
  768 |         expect(Math.abs((await startTop()) - before)).toBeLessThan(1);
  769 |         if (browserName === 'chromium')
  770 |           await page.screenshot({
  771 |             path: test
  772 |               .info()
  773 |               .outputPath('update-banner-' + mode.replace(/\W+/g, '-') + '-' + width + '.png'),
  774 |           });
  775 |         expect(await firstScreen(page, '#startWalk')).toEqual({
  776 |           scrolled: 0,
  777 |           inside: true,
  778 |           hit: true,
  779 |         });
  780 |         expect(await bannerUsable(page)).toBe(true);
  781 |         if (mode.startsWith('other company'))
  782 |           expect(await brandReadable(page)).toEqual({ unclipped: true, clear: true });
  783 |         expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
  784 |           false,
  785 |         );
  786 |       },
  787 |     );
  788 | 
  789 | test('long company name keeps its phone rendering until the Update ready banner shows', async ({
  790 |   page,
  791 | }) => {
  792 |   await page.setViewportSize({ width: 320, height: 844 });
  793 |   await start(page, 'other');
  794 |   const name = page.locator('.masthead .brand strong');
  795 |   await page.evaluate(() => {
  796 |     document.querySelector('.masthead .brand strong').textContent =
  797 |       'Central Valley Water Damage & Mold Remediation Specialists';
  798 |   });
  799 |   const render = () =>
  800 |     name.evaluate((el) => {
  801 |       const r = el.getBoundingClientRect(),
  802 |         style = getComputedStyle(el);
  803 |       return {
  804 |         box: [r.left, r.top, r.width, r.height],
  805 |         overflow: style.overflow,
  806 |         clamp: style.webkitLineClamp,
  807 |         clear: r.right <= document.getElementById('updateBanner').getBoundingClientRect().left,
  808 |       };
  809 |     });
  810 |   const before = await render();
  811 |   expect(before).toMatchObject({ overflow: 'visible', clamp: 'none' });
  812 |   await page.evaluate(() => (document.getElementById('updateBanner').hidden = false));
  813 |   expect(await render()).toMatchObject({ overflow: 'hidden', clamp: '2', clear: true });
  814 |   expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  815 |   await page.evaluate(() => (document.getElementById('updateBanner').hidden = true));
  816 |   expect(await render()).toEqual(before);
  817 | });
  818 | 
  819 | test('signed-out phone header at 320×844 fits the Update ready banner without overlap', async ({
  820 |   page,
  821 | }) => {
  822 |   await page.setViewportSize({ width: 320, height: 844 });
  823 |   await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  824 |   await page.goto('/');
  825 |   await expect(page.locator('#signInButton')).toBeVisible();
  826 |   await showUpdateBanner(page);
  827 |   const boxes = await page.evaluate(() =>
  828 |     ['.brand img', '#updateBanner', '#signInButton', '#accountMenu'].map((s) => {
  829 |       const r = document.querySelector(s).getBoundingClientRect();
  830 |       return [r.left, r.right];
  831 |     }),
  832 |   );
  833 |   for (let i = 1; i < boxes.length; i++)
  834 |     expect(boxes[i][0]).toBeGreaterThanOrEqual(boxes[i - 1][1]);
> 835 |   expect(boxes[0][1] - boxes[0][0]).toBeGreaterThan(0);
      |                                     ^ Error: expect(received).toBeGreaterThan(expected)
  836 |   expect(boxes[3][1]).toBeLessThanOrEqual(320);
  837 |   expect(await bannerUsable(page)).toBe(true);
  838 |   expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  839 | });
  840 | 
```