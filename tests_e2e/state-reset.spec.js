const { test, expect } = require('@playwright/test');

// Phase 3 of the UI-quality review: card ids are "<group_key>::<row_index>",
// which a new search reuses verbatim — so _selected/_closed state left over
// from a previous search silently applied to unrelated cards in the next
// one. Confirmed manually before the fix: select a card, search again,
// select/ctrl-click anything else, and the new card at the same index
// appeared selected without ever being clicked. resetResultState() (called
// at the top of _renderResults()) clears _selected/_closed/_zTop on every
// search so this can't happen.
const TEMPLATE = 'costar';

test.describe('search-lifecycle state reset', () => {

  test('selecting a card, then running a new search, does not leave a stale card pre-selected', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    // Select the first card of search #1.
    const firstCid = await page.locator('.record-card').first().getAttribute('data-cid');
    await page.evaluate((cid) => selectCard(cid, false), firstCid);

    // Run a second search that reuses the same group_key (same template),
    // so its cards get the exact same "<group_key>::<index>" ids.
    await page.fill('textarea[name="key_0"]', '271002');
    await page.evaluate(() => doSearch());
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    // Trigger a selection-visuals sync the way a real user action would
    // (any ctrl+click toggle re-syncs every card's .selected class from
    // the _selected Set) without selecting the new card at firstCid.
    await page.evaluate(() => selectCard('unrelated-cid-from-this-test', true));

    const newCardAtSameId = page.locator(`.record-card[data-cid="${firstCid}"]`);
    if (await newCardAtSameId.count() > 0) {
      await expect(newCardAtSameId).not.toHaveClass(/selected/);
    }

    const selected = await page.evaluate(() => Array.from(_selected));
    expect(selected).not.toContain(firstCid);
  });

  test('closing a card, then running a new search, does not leave a stale card excluded from Found items', async ({ page }) => {
    await page.goto(`/?template=${TEMPLATE}&key_0=100&mode=partial&run=1`);
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    const secondCid = await page.locator('.record-card').nth(1).getAttribute('data-cid');
    await page.evaluate((cid) => closeCard(cid), secondCid);

    await page.fill('textarea[name="key_0"]', '271002');
    await page.evaluate(() => doSearch());
    await expect(page.locator('.record-card').first()).toBeVisible({ timeout: 10000 });

    const closed = await page.evaluate(() => Object.keys(_closed));
    expect(closed).not.toContain(secondCid);

    // Every card rendered for this search should have a Found-items entry —
    // none silently excluded by leftover _closed state.
    const cardCount = await page.locator('.record-card').count();
    const foundCount = await page.locator('#found-list .found-item').count();
    expect(foundCount).toBe(cardCount);
  });

});
