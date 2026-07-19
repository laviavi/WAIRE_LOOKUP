const { test, expect } = require('@playwright/test');

// Uses the "costar" template which has two views: "owner" and "dealer".
// Search term "100" with partial match returns results in both views.
const TEMPLATE = 'costar';
const SEARCH_TERM = '100';

test.describe('AJAX search', () => {

  test('returns results and renders cards', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}`);
    await page.fill('textarea[name="key_0"]', SEARCH_TERM);
    await page.selectOption('select[name="mode"]', 'partial');
    await page.click('button:has-text("Search")');
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    const count = await page.locator('.res-count').textContent();
    expect(parseInt(count)).toBeGreaterThan(0);
    const cards = await page.locator('.record-card').count();
    expect(cards).toBeGreaterThan(0);
  });

  test('card title shows record value with "(partial match)" and no dup badge', async ({ page }) => {
    // Partial search on PropertyID: titles should be actual PropertyID values,
    // tagged "(partial match)", and the old "dup" badge should be gone.
    await page.goto(`/?template=${TEMPLATE}&key_0=${SEARCH_TERM}&mode=partial&run=1`);
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    expect(await page.locator('.rc-dup').count()).toBe(0);

    const title = (await page.locator('.record-card .rc-title').first().textContent()).trim();
    expect(title).toContain('(partial match)');
    // Title must NOT be the old "PropertyID = 100" form
    expect(title).not.toContain('=');
  });

  test('wildcard search anchors to the start of the value', async ({ page }) => {
    // "100*" in Contains mode = starts-with (anchored); plain "100" = substring.
    // Assert the starts-with PROPERTY of every card title (data-independent),
    // and that starts-with results ⊆ contains results — never exact counts.
    await page.goto(`/?template=${TEMPLATE}&key_0=${encodeURIComponent('100*')}&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    const wildcardCount = parseInt(await page.locator('.res-count').textContent());
    expect(wildcardCount).toBeGreaterThan(0);

    const titles = await page.locator('.record-card .rc-title').allTextContents();
    for (const raw of titles) {
      const values = raw.replace(' (partial match)', '').split(' & ');
      for (const v of values) {
        expect(v.trim().startsWith('100')).toBe(true);
      }
    }

    await page.goto(`/?template=${TEMPLATE}&key_0=${SEARCH_TERM}&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    const plainCount = parseInt(await page.locator('.res-count').textContent());
    expect(plainCount).toBeGreaterThanOrEqual(wildcardCount);
  });

  test('multi-value input allows newlines in textarea', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}`);
    const textarea = page.locator('textarea[name="key_0"]');
    await textarea.focus();
    await textarea.type('value1');
    await page.keyboard.press('Enter');
    await textarea.type('value2');
    const val = await textarea.inputValue();
    expect(val).toContain('\n');
    expect(val).toContain('value1');
    expect(val).toContain('value2');
  });

});

test.describe('results footer', () => {

  test('footer is a full-width ribbon below the body, not beside the results', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=${SEARCH_TERM}&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.res-foot')).toBeVisible();

    const geom = await page.evaluate(() => {
      var foot = document.querySelector('.res-foot');
      var body = document.querySelector('.body');
      var fr = foot.getBoundingClientRect();
      var br = body.getBoundingClientRect();
      return {
        parentIsBody: foot.parentNode.classList.contains('body'),
        footWidth: Math.round(fr.width),
        bodyWidth: Math.round(br.width),
        footTop: Math.round(fr.top),
        bodyBottom: Math.round(br.bottom),
      };
    });

    expect(geom.parentIsBody).toBe(false);           // not a flex child of .body
    expect(geom.footWidth).toBe(geom.bodyWidth);      // spans full width
    expect(geom.footTop).toBeGreaterThanOrEqual(geom.bodyBottom - 2); // sits below body
  });

});

test.describe('match column header', () => {

  test('single-field search: header is field name, value is searched value only', async ({ page }) => {
    // costar has 2 key columns; searching only key_0 (PropertyID) should
    // label the match column "PropertyID" and show just the value.
    await page.goto(`/?template=${TEMPLATE}&key_0=${SEARCH_TERM}&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    await page.click('button:has-text("Table")');

    const header = await page.locator('.group-block:not([style*="display: none"]) .results-table thead th.mo-col').textContent();
    // Header text may include an appended sort icon (·/↑/↓)
    expect(header.replace(/[·↑↓]/g, '').trim()).toBe('PropertyID');

    const firstCell = await page.locator('.group-block:not([style*="display: none"]) .results-table tbody tr:first-child td.mo-col').textContent();
    // Value should NOT contain the "PropertyID = " prefix
    expect(firstCell).not.toContain('=');
    expect(firstCell).not.toContain('PropertyID');
    expect(firstCell.trim().length).toBeGreaterThan(0);
  });

});

test.describe('view switching', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=${SEARCH_TERM}&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
  });

  test('view tabs are rendered after AJAX search', async ({ page }) => {
    const tabs = page.locator('.view-tab');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(0)).toHaveText('owner');
    await expect(tabs.nth(1)).toHaveText('dealer');
  });

  test('clicking second view tab shows different columns', async ({ page }) => {
    // Get columns visible in view 1
    const getVisibleHeaders = async () => {
      return page.locator('.group-block:not([style*="display: none"]) .results-table thead th:visible')
        .allTextContents();
    };

    // Switch to table view
    await page.click('button:has-text("Table")');
    const view1Headers = await getVisibleHeaders();

    // Click second view tab
    await page.click('.view-tab:nth-child(2)');
    const view2Headers = await getVisibleHeaders();

    expect(view1Headers.length).toBeGreaterThan(0);
    expect(view2Headers.length).toBeGreaterThan(0);
    // Views should show different column sets
    expect(view1Headers).not.toEqual(view2Headers);
  });

  test('card/table toggle works after switching views', async ({ page }) => {
    // Switch to table
    await page.click('button:has-text("Table")');
    const tableBlock = page.locator('.group-block:not([style*="display: none"]) .table-view');
    await expect(tableBlock).toBeVisible();

    // Switch to cards
    await page.click('button:has-text("Cards")');
    const cardBlock = page.locator('.group-block:not([style*="display: none"]) .card-view');
    await expect(cardBlock).toBeVisible();
  });

});

test.describe('column resize', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=${SEARCH_TERM}&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    await page.click('button:has-text("Table")');
  });

  test('resize handles exist on table headers', async ({ page }) => {
    const resizers = page.locator('.group-block:not([style*="display: none"]) .col-resizer');
    const count = await resizers.count();
    expect(count).toBeGreaterThan(0);
  });

  test('dragging a resize handle changes column width', async ({ page }) => {
    // Use real Playwright mouse drag, not simulated events
    const handle = page.locator('.group-block:not([style*="display: none"]) .col-resizer').first();
    const box = await handle.boundingBox();

    const thBefore = await page.evaluate(() => {
      var th = document.querySelector('.group-block:not([style*="display: none"]) .results-table thead th');
      return th.getBoundingClientRect().width;
    });

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2);
    await page.mouse.up();

    const thAfter = await page.evaluate(() => {
      var th = document.querySelector('.group-block:not([style*="display: none"]) .results-table thead th');
      return th.getBoundingClientRect().width;
    });

    expect(Math.round(thAfter - thBefore)).toBe(80);
  });

  test('resize in second view changes the correct column, not a different one', async ({ page }) => {
    // Switch to second view
    await page.click('.view-tab:nth-child(2)');

    // Get the second visible column's rendered width and position before drag
    const before = await page.evaluate(() => {
      var tbl = document.querySelector('.group-block:not([style*="display: none"]) .results-table');
      var ths = tbl.querySelectorAll('thead th');
      var visible = [];
      ths.forEach(function(th, i) { if (getComputedStyle(th).display !== 'none') visible.push(th); });
      var target = visible[1];
      return {
        targetW: target.getBoundingClientRect().width,
        tableW: parseInt(tbl.style.width),
      };
    });

    // Real drag on 2nd visible column's resizer
    const handle = page.locator('.group-block:not([style*="display: none"]) thead th:visible >> nth=1 >> .col-resizer');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2);
    await page.mouse.up();

    const after = await page.evaluate(() => {
      var tbl = document.querySelector('.group-block:not([style*="display: none"]) .results-table');
      var ths = tbl.querySelectorAll('thead th');
      var visible = [];
      ths.forEach(function(th, i) { if (getComputedStyle(th).display !== 'none') visible.push(th); });
      var target = visible[1];
      return {
        targetW: target.getBoundingClientRect().width,
        tableW: parseInt(tbl.style.width),
      };
    });

    // The dragged column should grow by 60, table by 60
    expect(Math.round(after.targetW - before.targetW)).toBe(60);
    expect(after.tableW - before.tableW).toBe(60);
  });

});
