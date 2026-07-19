const { test, expect } = require('@playwright/test');
const path = require('path');

// SSMS-style template designer (Phase 3 of the builder redesign).
// Fully self-contained: uses checked-in fixtures, never Avi's machine-local
// workbooks. Every test creates uniquely-named templates and deletes them
// in afterEach via the real delete route.
const CSV = path.resolve(__dirname, 'fixtures', 'people.csv');
const XLSX = path.resolve(__dirname, 'fixtures', 'two_sheets.xlsx');

const created = [];
function tplName(suffix) {
  const name = `e2e_builder_${suffix}`;
  created.push(name);
  return name;
}

test.afterEach(async ({ page }) => {
  while (created.length) {
    const name = created.pop();
    await page.request.post(`/templates/${encodeURIComponent(name)}/delete`).catch(() => {});
  }
});

// Loads the designer, types a path, clicks Load, waits for the diagram.
async function loadSource(page, filePath) {
  await page.goto('/templates/new');
  await page.fill('#tpl-path', filePath);
  await page.click('#load-btn');
  await expect(page.locator('.dg-box').first()).toBeVisible({ timeout: 10000 });
}

// A column row inside a diagram box, by box key + column name.
function dgCol(page, boxKey, col) {
  return page.locator(`.dg-box[data-box-key="${boxKey}"] .dg-col[data-col="${col}"]`);
}

test.describe('template designer', () => {

  test('create template end-to-end', async ({ page }) => {
    const name = tplName('create');
    await loadSource(page, CSV);
    await page.fill('#tpl-name', name);

    // CSV → single box with key "|"
    await expect(page.locator('.dg-box')).toHaveCount(1);
    await expect(page.locator('.dg-box .dg-col')).toHaveCount(4);

    // Step 1: key = ID (key-icon toggle)
    await dgCol(page, '|', 'ID').locator('.dg-key-toggle').click();
    // Step 3: View 1 gets Name + Dept (checkboxes target the active view)
    await dgCol(page, '|', 'Name').locator('input[type=checkbox]').check();
    await dgCol(page, '|', 'Dept').locator('input[type=checkbox]').check();
    // Step 2: second view with City
    await page.click('.add-view-btn');
    await dgCol(page, '|', 'City').locator('input[type=checkbox]').check();

    await page.click('#save-btn');
    await page.waitForURL(`**/?template=${name}`);

    // The saved template actually searches (SSE — wait for res-count)
    await page.fill('textarea[name="key_0"]', 'P001');
    await page.selectOption('select[name="mode"]', 'exact');
    await page.evaluate(() => doSearch());
    await expect(page.locator('.res-count')).toBeVisible({ timeout: 10000 });
    expect(parseInt(await page.locator('.res-count').textContent())).toBeGreaterThan(0);
  });

  test('edit existing preserves fields', async ({ page }) => {
    const name = tplName('edit');
    const seed = {
      name,
      source: { type: 'local', path: CSV, sheet_name: null, table_name: null, header_row: 1 },
      key_columns: ['ID'],
      result_columns: ['Name', 'Dept'],
      views: [
        { name: 'main', columns: ['Name', 'Dept'] },
        { name: 'places', columns: ['City'] },
      ],
      labels: { Name: 'Person' },
      default_filter: { column: 'Dept', equals: 'Sales' },
      default_match_mode: 'partial',
      links: [],
    };
    const resp = await page.request.post('/api/save_template', { data: seed });
    expect(resp.ok()).toBeTruthy();

    await page.goto(`/templates/${encodeURIComponent(name)}/edit`);
    await expect(page.locator('.dg-box').first()).toBeVisible({ timeout: 10000 });

    // Hydration checks
    await expect(page.locator('#tpl-name')).toHaveValue(name);
    await expect(page.locator('#tpl-mode')).toHaveValue('partial');
    const summary = await page.locator('#summary-pane').textContent();
    expect(summary).toContain('SEARCH BY ID');
    expect(summary).toContain('VIEW main');
    expect(summary).toContain('VIEW places');
    expect(summary).toContain('Person');   // label applied in summary

    // Edit the label via the grid, save, verify the export round-trips
    const labelInput = page.locator('#criteria-grid tbody tr', { hasText: 'Name' }).first().locator('input[type=text]');
    await labelInput.fill('Full name');
    await page.click('#save-btn');
    await page.waitForURL(`**/?template=${name}`);

    const exported = await (await page.request.get(`/api/template_export?template=${encodeURIComponent(name)}`)).json();
    expect(exported.labels.Name).toBe('Full name');
    expect(exported.default_match_mode).toBe('partial');
    expect(exported.default_filter).toEqual({ column: 'Dept', equals: 'Sales' });
    expect(exported.views.map(v => v.name)).toEqual(['main', 'places']);
    expect(exported.key_columns).toEqual(['ID']);
  });

  test('summary pane reflects state', async ({ page }) => {
    await loadSource(page, CSV);
    await dgCol(page, '|', 'ID').locator('.dg-key-toggle').click();
    await dgCol(page, '|', 'Name').locator('input[type=checkbox]').check();
    const summary = await page.locator('#summary-pane').textContent();
    expect(summary).toContain('SEARCH BY ID');
    expect(summary).toContain('VIEW View 1');
    expect(summary).toContain('Name');
  });

  test('view cannot mix sheets', async ({ page }) => {
    await loadSource(page, XLSX);
    await expect(page.locator('.dg-box')).toHaveCount(2);

    // Bind View 1 to Sheet1 by checking a Sheet1 column
    await dgCol(page, 'Sheet1|', 'Name').locator('input[type=checkbox]').check();

    // Every Sheet2 checkbox must now be disabled for the active view
    const sheet2Cbs = page.locator('.dg-box[data-box-key="Sheet2|"] .dg-col input[type=checkbox]');
    const n = await sheet2Cbs.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await expect(sheet2Cbs.nth(i)).toBeDisabled();
    }
  });

  test('missing-key warning badge', async ({ page }) => {
    await loadSource(page, XLSX);
    // Key ID exists on Sheet1 (primary) but not on Sheet2
    await dgCol(page, 'Sheet1|', 'ID').locator('.dg-key-toggle').click();
    const badge = page.locator('.dg-box[data-box-key="Sheet2|"] .dg-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("missing key 'ID'");
  });

  test('a non-primary sheet can set its own key and clears the badge', async ({ page }) => {
    await loadSource(page, XLSX);
    // Sheet2 has none of the keys yet -> badge shown, and its key toggle
    // must be clickable (not restricted to the primary box).
    await dgCol(page, 'Sheet1|', 'ID').locator('.dg-key-toggle').click();
    const badge = page.locator('.dg-box[data-box-key="Sheet2|"] .dg-badge');
    await expect(badge).toBeVisible();

    await dgCol(page, 'Sheet2|', 'Code').locator('.dg-key-toggle').click();
    // Sheet2 now owns one of the two configured keys (Code) — even though it
    // still lacks ID, it's searchable via Code, so the badge must clear.
    await expect(badge).not.toBeVisible();
    await expect(dgCol(page, 'Sheet2|', 'Code').locator('.dg-key-toggle')).toHaveClass(/on/);
  });

  test('joining two sheets lets one view span both (merged view)', async ({ page }) => {
    const name = tplName('merge');
    await loadSource(page, XLSX);   // Sheet1[ID,Name], Sheet2[Code,Desc]
    await page.fill('#tpl-name', name);

    // Key on Sheet1, one Sheet1 column into View 1.
    await dgCol(page, 'Sheet1|', 'ID').locator('.dg-key-toggle').click();
    await dgCol(page, 'Sheet1|', 'Name').locator('input[type=checkbox]').check();

    // Before a join, Sheet2's column is blocked for a Sheet1-bound view.
    await expect(dgCol(page, 'Sheet2|', 'Desc').locator('input[type=checkbox]')).toBeDisabled();

    // Declare the join via the dialog: Sheet1.ID <-> Sheet2.Code.
    await page.click('#join-add-btn');
    await page.locator('#join-dialog .join-base-sheet').selectOption('Sheet1');
    await page.locator('#join-dialog .join-base-col').selectOption('ID');
    await page.locator('#join-dialog .join-join-sheet').selectOption('Sheet2');
    await page.locator('#join-dialog .join-join-col').selectOption('Code');
    await page.locator('#join-dialog .join-create').click();
    await expect(page.locator('#join-chips .bld-link-chip')).toHaveCount(1);

    // Now Sheet2's Desc is checkable into the Sheet1-bound view; it stores qualified.
    const descCb = dgCol(page, 'Sheet2|', 'Desc').locator('input[type=checkbox]');
    await expect(descCb).toBeEnabled();
    await descCb.check();
    await expect(descCb).toBeChecked();

    await page.click('#save-btn');
    await page.waitForURL(`**/?template=${name}`);

    const exported = await (await page.request.get(`/api/template_export?template=${encodeURIComponent(name)}`)).json();
    const merged = exported.views.find(v => v.join);
    expect(merged).toBeTruthy();
    expect(merged.columns).toContain('Desc (Sheet2)');
    expect(merged.join).toEqual({ sheet_name: 'Sheet2', on: [{ left: 'ID', right: 'Code' }] });
    expect(exported.sheet_joins).toEqual([{ left_sheet: 'Sheet1', right_sheet: 'Sheet2', on: [{ left: 'ID', right: 'Code' }] }]);
  });

  // Phase 4: linking. Seeds a real target template first so it appears in the
  // page's server-rendered ALL_TEMPLATES list, then adds it as a linked box.
  async function seedTarget(page, name) {
    const resp = await page.request.post('/api/save_template', { data: {
      name,
      source: { type: 'local', path: CSV, sheet_name: null, table_name: null, header_row: 1 },
      key_columns: ['ID'],
      result_columns: ['Name'],
      views: [{ name: 'v', columns: ['Name'] }],
      labels: {}, default_filter: null, default_match_mode: 'exact', links: [],
    }});
    expect(resp.ok()).toBeTruthy();
  }

  test('click-to-link creates a link', async ({ page }) => {
    const targetName = tplName('link-target-click');
    const selfName = tplName('link-self-click');
    await seedTarget(page, targetName);

    await loadSource(page, CSV);
    await page.fill('#tpl-name', selfName);
    await dgCol(page, '|', 'ID').locator('.dg-key-toggle').click();
    await dgCol(page, '|', 'Name').locator('input[type=checkbox]').check();

    await page.selectOption('#linked-add', targetName);
    const linkedBox = page.locator(`.dg-box.linked[data-linked-template="${targetName}"]`);
    await expect(linkedBox).toBeVisible({ timeout: 10000 });

    // click the primary key field, then the target's key field
    await dgCol(page, '|', 'ID').locator('.dg-col-name').click();
    await linkedBox.locator('.dg-col[data-col="ID"]').click();

    const summary = await page.locator('#summary-pane').textContent();
    expect(summary).toContain('LINK');
    expect(summary).toContain(`↔ ${targetName}.ID`);
    await expect(page.locator('#link-chips .bld-link-chip')).toHaveCount(1);

    await page.click('#save-btn');
    await page.waitForURL(`**/?template=${selfName}`);

    const exported = await (await page.request.get(`/api/template_export?template=${encodeURIComponent(selfName)}`)).json();
    expect(exported.links).toEqual([{ from_key: 'ID', to_template: targetName, to_key: 'ID', to_key_index: 0 }]);
  });

  test('drag-to-link creates the same link', async ({ page }) => {
    const targetName = tplName('link-target-drag');
    const selfName = tplName('link-self-drag');
    await seedTarget(page, targetName);

    await loadSource(page, CSV);
    await page.fill('#tpl-name', selfName);
    await dgCol(page, '|', 'ID').locator('.dg-key-toggle').click();
    await dgCol(page, '|', 'Name').locator('input[type=checkbox]').check();

    await page.selectOption('#linked-add', targetName);
    const linkedBox = page.locator(`.dg-box.linked[data-linked-template="${targetName}"]`);
    await expect(linkedBox).toBeVisible({ timeout: 10000 });

    const fromEl = dgCol(page, '|', 'ID').locator('.dg-col-name');
    const toEl = linkedBox.locator('.dg-col[data-col="ID"]');
    const fromBox = await fromEl.boundingBox();
    const toBox = await toEl.boundingBox();

    await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await page.mouse.down();
    // Real intermediate move so builder.js's beginDragLink registers a drag
    // (not a plain click) and suppresses the trailing click event.
    await page.mouse.move(
      (fromBox.x + toBox.x) / 2 + toBox.width / 2,
      (fromBox.y + toBox.y) / 2 + toBox.height / 2,
      { steps: 5 }
    );
    await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 5 });
    await page.mouse.up();

    const summary = await page.locator('#summary-pane').textContent();
    expect(summary).toContain('LINK');
    expect(summary).toContain(`↔ ${targetName}.ID`);
    await expect(page.locator('#link-chips .bld-link-chip')).toHaveCount(1);

    await page.click('#save-btn');
    await page.waitForURL(`**/?template=${selfName}`);

    const exported = await (await page.request.get(`/api/template_export?template=${encodeURIComponent(selfName)}`)).json();
    expect(exported.links).toEqual([{ from_key: 'ID', to_template: targetName, to_key: 'ID', to_key_index: 0 }]);
  });

});
