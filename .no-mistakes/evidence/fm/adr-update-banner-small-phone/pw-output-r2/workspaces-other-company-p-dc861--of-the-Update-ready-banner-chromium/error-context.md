# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspaces.spec.js >> other company phone at 320×844 keeps Start walkthrough clear of the Update ready banner
- Location: tests/browser/workspaces.spec.js:737:5

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

  Object {
    "clear": true,
-   "unclipped": true,
+   "unclipped": false,
  }
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - banner [ref=e2]:
    - link "Alert Disaster Restoration home" [ref=e3] [cursor=pointer]:
      - /url: /
      - strong [ref=e4]: Other Restoration
    - generic [ref=e5]:
      - generic [ref=e6]: Update ready.
      - button "Save & update" [ref=e7] [cursor=pointer]
    - generic [ref=e8]:
      - button "Help" [ref=e9] [cursor=pointer]: "?"
      - group [ref=e10]:
        - generic "Account +" [ref=e11] [cursor=pointer]
  - generic [ref=e12]:
    - navigation "Company workspace" [ref=e13]:
      - button "Menu +" [ref=e14] [cursor=pointer]
    - region [ref=e15]:
      - generic [ref=e16]:
        - heading "Job coordination" [level=2] [ref=e17]
        - button "Job coordination +" [ref=e18] [cursor=pointer]
  - generic [ref=e19]:
    - generic [ref=e20]:
      - generic [ref=e21]:
        - text: FIELD INSPECTION
        - heading "New inspection" [level=1] [ref=e22]
        - status [ref=e23]: Saved privately · revision 1
      - group [ref=e24]:
        - generic "Jobs +" [ref=e25] [cursor=pointer]
    - navigation "Inspection tasks" [ref=e26]:
      - button "01 Property" [ref=e27] [cursor=pointer]:
        - generic [ref=e28]: "01"
        - text: Property
      - button "02 Walkthrough" [ref=e29] [cursor=pointer]:
        - generic [ref=e30]: "02"
        - text: Walkthrough
      - button "03 Evidence" [ref=e31] [cursor=pointer]:
        - generic [ref=e32]: "03"
        - text: Evidence
      - button "04 Review" [ref=e33] [cursor=pointer]:
        - generic [ref=e34]: "04"
        - text: Review
  - main [ref=e35]:
    - region [ref=e36]:
      - generic [ref=e37]:
        - heading "Field walkthrough" [active] [level=2] [ref=e38]
        - generic [ref=e39]: Not connected
      - generic [ref=e40]:
        - text: Current photo room
        - combobox "Current photo room" [ref=e41]:
          - option "Room 1" [selected]
      - generic [ref=e43]:
        - strong [ref=e44]: Walk the property with live guidance
        - paragraph [ref=e45]: Speak naturally as you inspect. Capture photos for the current room.
      - button "Start walkthrough" [ref=e47] [cursor=pointer]
      - generic [ref=e48]:
        - button "Capture still" [disabled] [ref=e49]
        - button "Camera / upload" [ref=e50] [cursor=pointer]
      - group [ref=e51]:
        - generic "Camera options" [ref=e52] [cursor=pointer]
      - status [ref=e53]: No reading verified.
      - paragraph [ref=e54]: Native camera quality varies by device. Originals up to 8 MB are retained; live video frames are reduced for streaming.
      - generic [ref=e55]:
        - button "Fill scope from walkthrough" [ref=e56] [cursor=pointer]
        - paragraph [ref=e57]: Stops capture and proposes form values from your recorded statements. Review each change before applying it.
      - group [ref=e58]:
        - generic "Walkthrough transcript" [ref=e59] [cursor=pointer]
  - text: +
  - generic [ref=e60]:
    - button "Save draft" [ref=e61] [cursor=pointer]
    - button "Finish & review" [ref=e62] [cursor=pointer]
  - contentinfo [ref=e63]: Other Restoration · Private company workspaces
```

# Test source

```ts
  682 |     const companies = await (
  683 |       await call(page, '/api/admin/companies', 'GET', undefined, 'admin')
  684 |     ).json();
  685 |     expect(companies.companies.map((c) => [c.company_id, c.status]).sort()).toEqual([
  686 |       ['adr', 'active'],
  687 |       ['other', 'active'],
  688 |     ]);
  689 |   });
  690 | }
  691 | 
  692 | // A new release shows the compact "Update ready" banner; it must never hide the first action.
  693 | async function showUpdateBanner(page) {
  694 |   await page.evaluate(() => (document.getElementById('updateBanner').hidden = false));
  695 |   await expect(page.locator('#updateBanner')).toBeVisible();
  696 |   await expect(page.locator('#updateBanner .update-text')).toHaveText('Update ready.');
  697 | }
  698 | // Both the button and the "Update ready." wording must be on screen and uncovered, so the
  699 | // prompt reads as an app update rather than a job save.
  700 | async function bannerUsable(page) {
  701 |   return page.locator('#updateBanner').evaluate((banner) =>
  702 |     ['.update-text', 'button'].every((selector) => {
  703 |       const el = banner.querySelector(selector),
  704 |         r = el.getBoundingClientRect(),
  705 |         top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  706 |       return (
  707 |         r.width > 8 &&
  708 |         r.height > 8 &&
  709 |         r.top >= 0 &&
  710 |         r.left >= 0 &&
  711 |         r.right <= innerWidth &&
  712 |         r.bottom <= innerHeight &&
  713 |         (top === el || el.contains(top))
  714 |       );
  715 |     }),
  716 |   );
  717 | }
  718 | // The company name must stay fully readable beside the banner and must not run under it.
  719 | async function brandReadable(page) {
  720 |   return page.locator('.masthead .brand strong').evaluate((el) => {
  721 |     const r = el.getBoundingClientRect(),
  722 |       banner = document.getElementById('updateBanner').getBoundingClientRect();
  723 |     return {
  724 |       unclipped: el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth,
  725 |       clear: r.right <= banner.left,
  726 |     };
  727 |   });
  728 | }
  729 | for (const mode of [
  730 |   'owner',
  731 |   'estimator',
  732 |   'legacy owner-only',
  733 |   'other company',
  734 |   'other company with logo',
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
> 782 |           expect(await brandReadable(page)).toEqual({ unclipped: true, clear: true });
      |                                             ^ Error: expect(received).toEqual(expected) // deep equality
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
  835 |   expect(boxes[0][1] - boxes[0][0]).toBeGreaterThan(0);
  836 |   expect(boxes[3][1]).toBeLessThanOrEqual(320);
  837 |   expect(await bannerUsable(page)).toBe(true);
  838 |   expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  839 | });
  840 | 
```