const { test, expect } = require('@playwright/test');

// Regression suite for the Phase-0 bug: functions declared inside the
// DOMContentLoaded closure are invisible to inline onclick/onchange/oninput
// HTML attributes (those execute in global scope). Every name referenced by
// an inline handler in search_c.html must resolve on window.
//
// This list is derived from the template's own markup:
//   grep -oE 'on(click|change|input|submit)="[a-zA-Z_][a-zA-Z0-9_]*\(' search_c.html
const INLINE_HANDLER_FNS = [
  'addTeamsWebhook', 'applyQuickFilter', 'clearInputs', 'closeSetup',
  'closeTeamsManage', 'copyDeepLink', 'copyTableTSV', 'crossSearch',
  'doSearch', 'exportCsv', 'exportTemplate', 'followLink', 'importTemplate',
  'loadLogTail', 'onPollMinutesChange', 'openLogViewer',
  'openSetup', 'refreshResults', 'resetSetupDefaults', 'ribbonRefresh',
  'saveNotifyWebhook', 'saveSetup', 'sendTo', 'setViewMode', 'signIn',
  'signOut', 'switchView', 'testConnection', 'toggleTeamsChooser',
];

const TEMPLATE = 'costar';

test.describe('inline handler wiring', () => {

  test('every function referenced by an inline HTML attribute exists on window', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}`);
    const missing = await page.evaluate((names) => {
      return names.filter((n) => typeof window[n] !== 'function');
    }, INLINE_HANDLER_FNS);
    expect(missing).toEqual([]);
  });

  test('log viewer opens and its own Refresh button works with no page error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?template=${TEMPLATE}`);
    await page.click('.versions'); // onclick="openLogViewer()"
    await expect(page.locator('#log-modal')).toBeVisible();
    await expect(page.locator('#log-pre')).not.toHaveText('Loading…', { timeout: 10000 });

    await page.click('#log-modal button:has-text("Refresh")'); // onclick="loadLogTail()"
    await page.waitForTimeout(300);

    expect(errors).toEqual([]);
  });

  test('quick filter narrows results with no page error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });

    const totalCards = await page.locator('.record-card').count();
    await page.fill('#quick-filter', 'zzz-no-such-value-zzz'); // oninput="applyQuickFilter(this.value)"
    await page.waitForTimeout(300); // debounce in applyQuickFilter

    const visibleAfter = await page.locator('.record-card:visible').count();
    expect(visibleAfter).toBeLessThan(totalCards);
    expect(errors).toEqual([]);
  });

  test('cross-template search ("Search all") opens results with no page error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?template=${TEMPLATE}`);
    await page.fill('textarea[name="key_0"]', '100');
    await page.click('button:has-text("Search all")'); // onclick="crossSearch()"

    await expect(page.locator('#cross-modal')).toBeVisible();
    // crossSearch queries every template sequentially against a single-threaded
    // Flask dev server — genuinely slower than a single-template search.
    await expect(page.locator('#cross-body')).not.toHaveText('Searching…', { timeout: 20000 });

    expect(errors).toEqual([]);
  });

  // Regression test for a real bug found while testing Phase 0: api_search()'s
  // SSE generator used to write session["snapshot_ids"] *inside* generate(), but
  // Flask commits the session cookie header before a streaming generator's body
  // ever runs, so the write was silently lost and /api/more_rows returned 410.
  // Fixed by returning snapshot_ids in the SSE payload and having the client
  // pass them explicitly instead of relying on the session.
  test('numbered pagination loads a different page of rows after an AJAX search', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // "1" partial-matches 1700+ PropertyID rows — guaranteed truncation past the 50-row cap.
    await page.goto(`/?template=${TEMPLATE}&key_0=1&mode=partial&run=1`);
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    await page.click('button:has-text("Table")');

    const block = page.locator('.group-block:not([style*="display: none"])');
    const bar = block.locator('.pagination-bar');
    await expect(bar).toBeVisible();
    const firstRowPage1 = await block.locator('.results-table tbody tr').first().getAttribute('data-cid');

    await bar.locator('.page-btn', { hasText: '2' }).click();
    await expect(bar.locator('.page-btn.active', { hasText: '2' })).toBeVisible();
    const firstRowPage2 = await block.locator('.results-table tbody tr').first().getAttribute('data-cid');
    expect(firstRowPage2).not.toBe(firstRowPage1);
    expect(errors).toEqual([]);
  });

  // Same root cause and fix as above: /export also looks up session["snapshot_ids"].
  test('"Export CSV" (no selection) downloads a file after an AJAX search', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      page.click('#export-csv-btn'),
    ]);
    expect(download.suggestedFilename()).toContain('.csv');
  });

  test('"Export template" triggers a download, not a page navigation, with no page error', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`/?template=${TEMPLATE}`);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("Export")'), // onclick="exportTemplate()"
    ]);
    expect(download.suggestedFilename()).toContain(TEMPLATE);
    expect(page.url()).toContain(`template=${TEMPLATE}`); // still on the search page
    expect(errors).toEqual([]);
  });

  // Regression test: _renderResults used to wire every card twice — once via
  // applyResultsView() -> layoutCards() -> makeCardInteractive(), and again via
  // a now-removed _initCardActions(). Two click listeners on the same collapse
  // button toggled the 'collapsed' class on and immediately back off, so
  // clicking Collapse silently did nothing.
  test('card collapse toggles on every click after an AJAX search', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    const card = page.locator('.record-card').first();
    await expect(card).toBeVisible({ timeout: 10000 });
    const collapseBtn = card.locator('.rc-collapse');

    await expect(card).not.toHaveClass(/collapsed/);
    await collapseBtn.click();
    await expect(card).toHaveClass(/collapsed/);
    await collapseBtn.click();
    await expect(card).not.toHaveClass(/collapsed/);
  });

  // Regression test: the removed duplicate's close handler only hid the card —
  // it never updated the closed-card tracking or removed the found-list entry,
  // leaving stale state. The remaining closeCard() path does both correctly.
  test('closing a card removes it from the Found items list', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    const cards = page.locator('.record-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });
    const cid = await cards.nth(1).getAttribute('data-cid');

    await cards.nth(1).locator('.rc-close').click();

    await expect(page.locator(`.record-card[data-cid="${cid}"]`)).toBeHidden();
    await expect(page.locator(`#found-list .found-item[data-cid="${cid}"]`)).toHaveCount(0);
  });

  // Regression test (Phase 1): #found-panel used to be rendered only inside
  // the now-deleted server-rendered results block ({% if result %}), which
  // was already always-false in real usage (only do_search — never invoked by
  // the AJAX-driven UI — ever passed a non-null result). The Found Items
  // sidebar was therefore invisible in the live app for as long as AJAX
  // search has been the default. Now rendered unconditionally in the empty
  // shell and toggled by applyResultsView().
  test('Found items panel appears and lists every result after a search', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    const foundPanel = page.locator('#found-panel');
    await expect(foundPanel).toBeVisible();
    const cardCount = await page.locator('.record-card').count();
    const foundItemCount = await page.locator('#found-list .found-item').count();
    expect(foundItemCount).toBe(cardCount);
    expect(foundItemCount).toBeGreaterThan(0);
  });

});
