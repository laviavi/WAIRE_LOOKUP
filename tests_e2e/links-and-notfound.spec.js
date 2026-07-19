const { test, expect } = require('@playwright/test');

// Phase 5 of the UI-quality review: _renderResults() used to build the
// results header (view tabs, not-found chip, link buttons, quick filter) by
// concatenating HTML strings with onclick="..." attributes baked in — worst
// of all, followLink(JSON.stringify(link).replace(/'/g, "&#39;")) glued a
// JSON-serialized object into an onclick attribute with manual quote-
// escaping, a real injection surface. Rewritten to build DOM nodes with
// addEventListener, capturing the link object by closure instead of
// serializing it into markup at all.
//
// Testing this needs a template with an actual "links" entry, which none of
// the fixture templates have, so these tests intercept the /api/search
// fetch response and splice a synthetic (and deliberately hostile) link
// object into the real SSE payload before search.js ever sees it — this
// exercises the exact code path a real linked-views template would.
const TEMPLATE = 'costar';

// Matches "links": [...] regardless of what costar's real (mutable, git-
// untracked) links config currently holds — costar may legitimately have its
// own real links at any given time (e.g. a real vacancy link an operator
// added through the builder), and this test's injected link must fully
// replace whatever is there, not assume an empty array.
const INJECT_LINK_FETCH_PATCH = `
  var orig = window.fetch.bind(window);
  window.fetch = function(url, opts) {
    if (typeof url === 'string' && url.indexOf('/api/search') === 0) {
      return orig(url, opts).then(function(resp) {
        return resp.text().then(function(text) {
          var nastyLabel = "O'Brien's <b>bold</b> \\"quoted\\" label";
          var replacement = '"links": [{"from_key":"PropertyID","to_template":"ooo","to_key":"PropertyID","to_key_index":0,"label":' + JSON.stringify(nastyLabel) + '}]';
          var injected = text.replace(/"links":\\s*\\[[\\s\\S]*?\\]/, replacement);
          return new Response(injected, {status: 200, headers: {'Content-Type': 'text/event-stream'}});
        });
      });
    }
    return orig(url, opts);
  };
`;

test.describe('linked-views button (result-header rewrite)', () => {

  test('link button renders from a hostile label with no HTML injection and no page error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?template=${TEMPLATE}`);
    await page.evaluate(INJECT_LINK_FETCH_PATCH);
    await page.fill('textarea[name="key_0"]', '100');
    await page.selectOption('select[name="mode"]', 'partial');
    await page.evaluate(() => doSearch());
    await expect(page.locator('.link-btn')).toBeVisible({ timeout: 10000 });

    // The label must render as literal text, not be interpreted as markup —
    // this is the actual regression test: before the fix, "links" was read
    // from the wrong object path (r.links instead of data.links) and the
    // button never appeared at all; before *that*, the old onclick-string
    // approach was vulnerable to breaking out of the attribute.
    const btnText = await page.locator('.link-btn').textContent();
    expect(btnText).toContain(`O'Brien's <b>bold</b> "quoted" label`);
    expect(await page.locator('.link-btn script').count()).toBe(0);
    expect(await page.locator('.res-head script').count()).toBe(0);

    expect(errors).toEqual([]);
  });

  test('clicking the link button passes the link object through, not a re-parsed string', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}`);
    await page.evaluate(INJECT_LINK_FETCH_PATCH);
    await page.fill('textarea[name="key_0"]', '100');
    await page.selectOption('select[name="mode"]', 'partial');
    await page.evaluate(() => doSearch());
    await expect(page.locator('.link-btn')).toBeVisible({ timeout: 10000 });

    const capturedLabel = await page.evaluate(() => {
      return new Promise((resolve) => {
        const real = window.followLink;
        window.followLink = (lk) => { window.followLink = real; resolve(lk.label); };
        document.querySelector('.link-btn').click();
      });
    });
    expect(capturedLabel).toBe(`O'Brien's <b>bold</b> "quoted" label`);
  });

  test('following a link shows a Back button that returns to the original search', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}`);
    await page.evaluate(INJECT_LINK_FETCH_PATCH);
    await page.fill('textarea[name="key_0"]', '100');
    await page.selectOption('select[name="mode"]', 'partial');
    await page.evaluate(() => doSearch());
    await expect(page.locator('.link-btn')).toBeVisible({ timeout: 10000 });

    await page.click('.link-btn');   // navigates to ?template=ooo&key_0=...&run=1&back=<costar deep link>
    await page.waitForURL(/template=ooo/);

    const backBtn = page.locator('.back-btn');
    await expect(backBtn).toBeVisible({ timeout: 10000 });
    await expect(backBtn).toContainText('costar');

    await backBtn.click();
    await page.waitForURL(/template=costar/);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
  });

});

test.describe('not-found panel (result-header rewrite)', () => {

  test('toggle chip shows/hides the panel and lists the not-found value', async ({ page }) => {
    // "10062907" is a real PropertyID (exact match); "zzz-fake-999" is not —
    // guarantees both a match (so the head/not-found chip actually render;
    // 0 total_matches takes an early-return path with no head at all) and a
    // not-found entry.
    await page.goto(`/?template=${TEMPLATE}&key_0=${encodeURIComponent('10062907,zzz-fake-999')}&mode=exact&run=1`);
    await expect(page.locator('.nf-toggle')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.nf-toggle')).toHaveText('1 not found');

    const nfPanel = page.locator('#nf-panel');
    await expect(nfPanel).toBeHidden();
    await page.click('.nf-toggle');
    await expect(nfPanel).toBeVisible();
    await expect(page.locator('#nf-list')).toHaveText('zzz-fake-999');
  });

  test('"Copy list" button in the not-found panel works with no page error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?template=${TEMPLATE}&key_0=${encodeURIComponent('10062907,zzz-fake-999')}&mode=exact&run=1`);
    await expect(page.locator('.nf-toggle')).toBeVisible({ timeout: 10000 });
    await page.click('.nf-toggle');
    await page.click('#nf-panel button');

    expect(errors).toEqual([]);
  });

});
