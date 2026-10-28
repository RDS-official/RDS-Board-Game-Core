/**
 * Minimal keyed reconciliation for hand-written DOM.
 *
 * The HUD rebuilt whole panels with `innerHTML = …` on every snapshot. That is
 * simple but it replaces the subtree, so anything the browser owned — scroll
 * position, hover, keyboard focus — is thrown away even when only one row
 * changed.
 *
 * This helper keeps node identity: existing elements are matched by key and
 * reused, only new keys are created and only stale keys are removed. It is
 * deliberately small (no framework, no virtual DOM) because the panels are
 * plain lists and a full diffing library would be more machinery than the
 * problem needs.
 *
 * A row whose markup changed is replaced in place. Rows carry no internal state
 * of their own (no focusable descendant, no scroll), so replacing just that one
 * node is safe; the surrounding nodes — and therefore the panel's scroll and
 * focus — are untouched.
 */

export interface KeyedItem {
  /** Stable identity across renders. Rows with the same key are reused. */
  key: string;
  /** Serialised content; a change here means the node is replaced. */
  html: string;
}

const KEY_ATTR = 'data-key';
const SIG_ATTR = 'data-sig';

/** Cheap, stable string hash (kept for callers that need a content signature). */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function build(item: KeyedItem): HTMLElement | null {
  const template = document.createElement('template');
  template.innerHTML = item.html.trim();
  const el = template.content.firstElementChild as HTMLElement | null;
  if (!el) return null;
  el.setAttribute(KEY_ATTR, item.key);
  el.setAttribute(SIG_ATTR, hash(item.html));
  return el;
}

/**
 * Reconcile `container`'s element children against `items`.
 *
 * Returns the number of nodes that were created, replaced, moved or removed, so
 * callers can tell whether a repaint actually did anything.
 */
export function reconcileKeyed(container: HTMLElement, items: KeyedItem[]): number {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const el = child as HTMLElement;
    const key = el.getAttribute(KEY_ATTR);
    if (key) existing.set(key, el);
  }

  let changes = 0;
  let cursor: Element | null = container.firstElementChild;

  for (const item of items) {
    let node = existing.get(item.key);

    if (!node) {
      // New key: build it and drop it into position.
      const built = build(item);
      if (!built) continue;
      container.insertBefore(built, cursor);
      changes++;
      continue;
    }

    existing.delete(item.key);

    // Content changed: swap the node in place.
    //
    // The comparison uses a stored hash of the markup we rendered, not
    // outerHTML: anything else that touches the node (a hover class, a test
    // marker attribute) would otherwise read as a content change and defeat the
    // reuse this whole helper exists for.
    const fresh = build(item);
    const sig = hash(item.html);
    if (fresh && node.getAttribute(SIG_ATTR) !== sig) {
      container.insertBefore(fresh, node);
      // Keep the cursor on a live node: if it pointed at the node being
      // removed, the next insertBefore would target a detached element.
      if (cursor === node) cursor = fresh;
      node.remove();
      node = fresh;
      changes++;
    }

    // Reorder only when the node is out of place.
    if (node !== cursor) {
      // A stale cursor (already detached) would make insertBefore throw.
      if (cursor && cursor.parentNode !== container) cursor = null;
      container.insertBefore(node, cursor);
      changes++;
    } else {
      cursor = cursor.nextElementSibling;
    }
  }

  // Anything left over is stale.
  for (const stale of existing.values()) {
    stale.remove();
    changes++;
  }

  return changes;
}

/**
 * Reconcile while preserving the reader's scroll position.
 *
 * A list that grows at the top (a newest-first feed) shifts content downward;
 * without this the reader's view jumps. `scrollTop === 0` means the reader is
 * pinned to the newest entry, which should stay pinned.
 */
export function reconcileKeyedPreservingScroll(container: HTMLElement, items: KeyedItem[]): number {
  const beforeTop = container.scrollTop;
  const beforeHeight = container.scrollHeight;
  const changes = reconcileKeyed(container, items);
  if (!changes) return 0;

  if (beforeTop > 0) {
    // Keep the same content under the viewport.
    container.scrollTop = beforeTop + (container.scrollHeight - beforeHeight);
  } else {
    container.scrollTop = 0;
  }
  return changes;
}
