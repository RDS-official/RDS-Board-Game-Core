/**
 * Shared action-clicking helpers for the verification scripts.
 *
 * Two behaviours of the action dock that every script has to account for:
 *
 * 1. Fan cards show only an icon, so the label lives in `data-fan-label` rather
 *    than in the text content. Matching on text alone silently finds nothing.
 * 2. Clicking a fan card opens its detail panel; the action runs from that
 *    panel's button. Scripts that click and immediately assert therefore need
 *    the extra step.
 *
 * Keeping both rules in one place stops each script from rediscovering them.
 */

/** CSS selector matching an action by label, fan or plain. */
export function actionSelector(label, scope = '') {
  const base = scope ? `${scope} .act` : '.act';
  return `${base}[data-fan-label*="${label}"], ${base}:has-text("${label}")`;
}

/**
 * Click an action and carry it through the detail panel when one appears.
 * Accepts a Playwright locator or a label string.
 */
export async function clickAction(page, target, options = {}) {
  const { timeout = 8000 } = options;
  const locator = typeof target === 'string' ? page.locator(actionSelector(target)).first() : target;

  if (!(await locator.count())) throw new Error(`action not found: ${typeof target === 'string' ? target : 'locator'}`);
  await locator.click();

  // The fan opens a detail panel; run from it. Plain buttons (card-sheet
  // shortcuts, other fixtures) execute immediately and skip this.
  const run = page.locator('#ad-run');
  if (await run.count()) {
    await run.click({ timeout }).catch(() => {});
  }
  return true;
}

/** Click an action inside the dock only. */
export async function clickDockAction(page, label, options) {
  const locator = page.locator(actionSelector(label, '.dock-actions')).first();
  return clickAction(page, locator, options);
}
