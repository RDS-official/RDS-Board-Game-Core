import { launchChromium } from './lib/browser.mjs';
import { ensureSoloServer } from './lib/soloserver.mjs';

/**
 * DOM stability probe (docs/UI-ARCHITECTURE.md Phase 3, option B).
 *
 * The persistent panels used to be rebuilt with `innerHTML = …` on every
 * snapshot, which replaced the subtree and threw away everything the browser
 * owned: scroll position, hover state and keyboard focus.
 *
 * This probe drives a real snapshot update and asserts the panels survive it:
 *
 *   - the first row's element identity is unchanged (same object, not just
 *     equal-looking markup);
 *   - a marker attribute set on it survives;
 *   - the feed's scrollTop is preserved;
 *   - document.activeElement is preserved.
 *
 * Run: node scripts/probe-dom-stability.mjs
 */
const dev = await ensureSoloServer();
const browser = await launchChromium();

const failures = [];
let checks = 0;

const record = (name, ok, detail) => {
  checks++;
  if (!ok) failures.push(`${name}: ${detail}`);
};

const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } });
await page.goto(`${dev.url}?game=betrayal&scenario=exploration`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000
});
await page.waitForTimeout(4200);
if (await page.locator('#boot-enter').count()) await page.click('#boot-enter').catch(() => {});
await page.waitForTimeout(2000);

const mounted = await page.evaluate(() => !!document.querySelector('#activity-feed'));
if (!mounted) {
  failures.push('never reached the game view');
} else {
  // Build up enough history that the feed is actually scrollable, then scroll it.
  const prep = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const engine = app.session.engine;
    for (let i = 0; i < 12; i++) {
      const raw = engine.getRawState();
      const active = raw.activeActorId ?? raw.activePlayerId;
      const legal = engine.getLegalActions(active);
      const act = legal.find(a => a.type === 'END_TURN' || a.type === 'END_NPC_TURN') ?? legal[0];
      if (!act) break;
      engine.dispatch(act);
      app.session.setViewer('GOD');
      await new Promise(r => setTimeout(r, 60));
    }
    const body = document.querySelector('#activity-feed .af-body');
    return { rows: body ? body.children.length : 0, scrollHeight: body ? body.scrollHeight : 0, clientHeight: body ? body.clientHeight : 0 };
  });
  console.log('feed prepared:', JSON.stringify(prep));

  /* ---- 1. element identity survives a snapshot update ------------------- */
  const identity = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const engine = app.session.engine;
    const body = document.querySelector('#activity-feed .af-body');
    if (!body) return { skipped: true };

    const first = body.children[0];
    if (first) {
      first.setAttribute('data-probe-tag', 'before');
      window.__probeNode = first;
    }

    const raw = engine.getRawState();
    const active = raw.activeActorId ?? raw.activePlayerId;
    const legal = engine.getLegalActions(active);
    const act = legal.find(a => a.type === 'END_TURN' || a.type === 'END_NPC_TURN') ?? legal[0];
    if (act) engine.dispatch(act);
    app.session.setViewer('GOD');
    await new Promise(r => setTimeout(r, 900));

    const after = document.querySelector('#activity-feed .af-body');
    const tagged = after.querySelector('[data-probe-tag="before"]');
    return {
      skipped: false,
      // The feed prepends new entries, so children[0] is legitimately new; the
      // invariant is that the old node was reused, not recreated.
      reused: tagged === window.__probeNode,
      indexNow: tagged ? Array.prototype.indexOf.call(after.children, tagged) : -1,
      rowsAfter: after.children.length
    };
  });

  if (identity.skipped) {
    failures.push('the feed has no rows to probe');
  } else {
    console.log('identity:', JSON.stringify(identity));
    record('feed', identity.reused, 'the previous first row was replaced instead of reused');
    record('feed', identity.indexNow >= 1, `the reused row was not pushed down by the new entry (index ${identity.indexNow})`);
  }

  /* ---- 2. scroll position survives a snapshot update ------------------- */
  const scroll = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const engine = app.session.engine;
    const body = document.querySelector('#activity-feed .af-body');
    if (!body) return { skipped: true };

    body.scrollTop = Math.min(40, Math.max(0, body.scrollHeight - body.clientHeight));

    // Pin the row sitting at the top of the viewport and where it sits.
    const anchor = Array.from(body.children).find(el => el.offsetTop + el.offsetHeight > body.scrollTop) ?? body.children[0];
    window.__probeAnchor = anchor;
    const anchorOffsetBefore = anchor.offsetTop - body.scrollTop;
    const before = body.scrollTop;

    const raw = engine.getRawState();
    const active = raw.activeActorId ?? raw.activePlayerId;
    const legal = engine.getLegalActions(active);
    const act = legal.find(a => a.type === 'END_TURN' || a.type === 'END_NPC_TURN') ?? legal[0];
    if (act) engine.dispatch(act);
    app.session.setViewer('GOD');
    await new Promise(r => setTimeout(r, 900));

    const after = document.querySelector('#activity-feed .af-body');
    const anchorAfter = window.__probeAnchor;
    const stillThere = anchorAfter && after.contains(anchorAfter);
    const anchorOffsetAfter = stillThere ? anchorAfter.offsetTop - after.scrollTop : NaN;
    return {
      skipped: false,
      before,
      after: after.scrollTop,
      scrollable: body.scrollHeight > body.clientHeight,
      anchorKept: stillThere,
      drift: stillThere ? Math.abs(anchorOffsetAfter - anchorOffsetBefore) : NaN
    };
  });

  if (scroll.skipped) {
    failures.push('the feed has no body to probe');
  } else {
    console.log('scroll:', JSON.stringify(scroll));
    if (!scroll.scrollable) {
      // Not enough rows to scroll: say so rather than passing silently.
      failures.push('feed was not scrollable, so scroll preservation could not be verified');
    } else {
      // scrollTop is expected to grow by the inserted row's height; what must not
      // move is the content under the viewport.
      record('feed', scroll.anchorKept, 'the row at the top of the viewport was removed');
      record('feed', Number.isFinite(scroll.drift) && scroll.drift <= 2, `the viewport jumped by ${scroll.drift}px`);
    }
  }

  /* ---- 3. keyboard focus survives a snapshot update ------------------- */
  const focus = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const engine = app.session.engine;
    const head = document.querySelector('#activity-feed .af-head');
    if (!head) return { skipped: true };
    head.focus();
    const before = document.activeElement === head;

    const raw = engine.getRawState();
    const active = raw.activeActorId ?? raw.activePlayerId;
    const legal = engine.getLegalActions(active);
    const act = legal.find(a => a.type === 'END_TURN' || a.type === 'END_NPC_TURN') ?? legal[0];
    if (act) engine.dispatch(act);
    app.session.setViewer('GOD');
    await new Promise(r => setTimeout(r, 900));

    const after = document.activeElement;
    return { skipped: false, focusedBefore: before, stillFocused: after === head, afterTag: after === document.body ? 'body' : (after?.className || after?.tagName) };
  });

  if (focus.skipped) {
    failures.push('the feed header is missing');
  } else {
    console.log('focus:', JSON.stringify(focus));
    record('feed', focus.focusedBefore, 'the header could not take focus');
    record('feed', focus.stillFocused, `focus left the header and landed on ${focus.afterTag}`);
  }

  /* ---- 4. the toggle still works (listeners survived the reconciler) --- */
  const toggle = await page.evaluate(async () => {
    const head = document.querySelector('#activity-feed .af-head');
    const body = document.querySelector('#activity-feed .af-body');
    if (!head || !body) return { skipped: true };
    const before = body.children.length;
    head.click();
    await new Promise(r => setTimeout(r, 300));
    const collapsed = document.querySelector('#activity-feed .af-body').children.length;
    document.querySelector('#activity-feed .af-head').click();
    await new Promise(r => setTimeout(r, 300));
    const expanded = document.querySelector('#activity-feed .af-body').children.length;
    return { skipped: false, before, collapsed, expanded };
  });
  if (toggle.skipped) {
    failures.push('feed toggle could not be probed');
  } else {
    console.log('toggle:', JSON.stringify(toggle));
    record('feed', toggle.collapsed <= 3, `collapsing did not reduce the rows (${toggle.before} -> ${toggle.collapsed})`);
    record('feed', toggle.expanded >= toggle.collapsed, 'expanding did not restore the rows');
  }
}

/* ---- 5. the action fan is reused across an unchanged repaint -------- */
{
  await page.locator('.dock-fan .act').first().hover();
  await page.waitForTimeout(200);

  const fan = await page.evaluate(() => {
    const app = window.__boardGameApp;
    const card = document.querySelector('.dock-fan .act');
    if (!card) return { skipped: true };

    const hintBefore = document.querySelector('[data-fan-hint]')?.classList.contains('active') ?? false;
    const idsBefore = [...document.querySelectorAll('.dock-fan .act')].map(el => el.dataset.actionId);

    // Repaint with the SAME snapshot: no action changed, so every card must be
    // reused. This is the path a snapshot takes on an opponent move or a tick.
    app.hud.renderDock(app.session.getSnapshot());

    const after = [...document.querySelectorAll('.dock-fan .act')];
    return {
      skipped: false,
      reused: after[0] === card,
      idsStable: JSON.stringify(after.map(el => el.dataset.actionId)) === JSON.stringify(idsBefore),
      hintBefore,
      hintAfter: document.querySelector('[data-fan-hint]')?.classList.contains('active') ?? false,
      cards: after.length
    };
  });

  if (fan.skipped) {
    failures.push('the action fan has no cards to probe');
  } else {
    console.log('fan:', JSON.stringify(fan));
    record('fan', fan.reused, 'an unchanged repaint replaced the fan cards');
    record('fan', fan.idsStable, 'an unchanged repaint changed the card order');
    record('fan', fan.hintBefore, 'hover did not activate the hint bar');
    record('fan', fan.hintAfter, 'the hint bar lost its hover state across an unchanged repaint');
  }
}

/* ---- 6. keyboard focus on a fan card survives a snapshot update ------ */
{
  const cardFocus = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const engine = app.session.engine;
    const card = document.querySelector('.dock-fan .act');
    if (!card) return { skipped: true };
    card.focus();
    const focusedBefore = document.activeElement === card;

    // Unchanged repaint, for the same reason as the identity check.
    app.hud.renderDock(app.session.getSnapshot());
    await new Promise(r => setTimeout(r, 200));

    const after = document.activeElement;
    return {
      skipped: false,
      focusedBefore,
      stillFocused: after === card,
      afterTag: after === document.body ? 'body' : (after?.className || after?.tagName)
    };
  });

  if (cardFocus.skipped) {
    failures.push('no fan card could take focus');
  } else {
    console.log('card focus:', JSON.stringify(cardFocus));
    record('fan', cardFocus.focusedBefore, 'a fan card could not take focus');
    record('fan', cardFocus.stillFocused, `focus left the fan card and landed on ${cardFocus.afterTag}`);
  }
}

/* ---- 7. the player rail is reused across an unchanged repaint -------- */
{
  const rail = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const card = document.querySelector('#player-rail .pc');
    if (!card) return { skipped: true };

    card.setAttribute('data-probe-tag', 'pc');
    card.focus?.();
    const focusedBefore = document.activeElement === card;
    const idsBefore = [...document.querySelectorAll('#player-rail .pc')].map(el => el.dataset.playerId ?? el.className);

    app.hud.renderPlayers(app.session.getSnapshot());
    await new Promise(r => setTimeout(r, 200));

    const after = document.querySelector('#player-rail .pc');
    return {
      skipped: false,
      reused: after === card,
      markerSurvived: !!document.querySelector('[data-probe-tag="pc"]'),
      idsStable: JSON.stringify([...document.querySelectorAll('#player-rail .pc')].map(el => el.dataset.playerId ?? el.className)) === JSON.stringify(idsBefore),
      cards: document.querySelectorAll('#player-rail .pc').length
    };
  });

  if (rail.skipped) {
    failures.push('the player rail has no cards to probe');
  } else {
    console.log('rail:', JSON.stringify(rail));
    record('rail', rail.reused, 'an unchanged repaint replaced the player cards');
    record('rail', rail.markerSurvived, 'a marker attribute on a player card did not survive');
    record('rail', rail.idsStable, 'an unchanged repaint changed the player card order');
  }
}

/* ---- 8. guarded panels skip the repaint entirely -------------------- */
{
  const guarded = await page.evaluate(async () => {
    const app = window.__boardGameApp;
    const snap = app.session.getSnapshot();

    const mini = document.querySelector('#mansion-minimap');
    const room = document.querySelector('#room-card');
    if (!mini && !room) return { skipped: true };

    // Tag a descendant of each panel; if the panel is repainted the tag dies.
    const miniChild = mini?.querySelector('.mm-head') ?? null;
    const roomChild = room?.querySelector('.rc-head') ?? null;
    if (miniChild) miniChild.setAttribute('data-probe-tag', 'mini');
    if (roomChild) roomChild.setAttribute('data-probe-tag', 'room');

    app.hud.renderMinimap(snap);
    app.hud.renderRoomCard(snap);
    await new Promise(r => setTimeout(r, 150));

    return {
      skipped: false,
      miniKept: miniChild ? !!document.querySelector('[data-probe-tag="mini"]') : null,
      roomKept: roomChild ? !!document.querySelector('[data-probe-tag="room"]') : null
    };
  });

  if (guarded.skipped) {
    failures.push('no guarded panel to probe');
  } else {
    console.log('guarded:', JSON.stringify(guarded));
    if (guarded.miniKept !== null) {
      record('minimap', guarded.miniKept, 'an unchanged repaint rebuilt the minimap');
    }
    if (guarded.roomKept !== null) {
      record('dossier', guarded.roomKept, 'an unchanged repaint rebuilt the room dossier');
    }
  }
}

console.log(`\nDOM stability probe: ${checks} checks`);
if (failures.length) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nPanels survive snapshot updates: node identity, scroll, focus and fan hover preserved.');
}

await browser.close();
dev.stop();
