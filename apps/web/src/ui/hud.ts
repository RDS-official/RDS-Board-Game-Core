import confetti from 'canvas-confetti';
import { cardArtSvg } from './cardArt';
import { handLayout } from './handLayout';
import { diagnostics } from '../diagnostics/install';
import { hash, reconcileKeyed, reconcileKeyedPreservingScroll } from './dom/keyed';
import { DiceRollOverlay } from './dice-overlay';
import {
  CameraView,
  GAME_TABS,
  GamePresenter,
  GameSnapshot,
  PresentationPorts,
  UiAction,
  UiCardDetail,
  UiHistoryEntry,
  UiNotice,
  UiTraitChange,
  UiPlayer
} from '@rds/app/contracts';

/**
 * HTML 转义：玩家可控文本（昵称/头像 URL/参与者名）进入 innerHTML 前必须经过这里。
 * 来源：审查报告 S4——昵称可携带 `<svg/onload=...>` 这类载荷（存储型 XSS）。
 */
const escHtml = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

/** Short trait key → character-sheet abbreviation used by the pip ladder. */
const HUD_TRAIT_SHORT: Record<string, string> = {
  speed: '速',
  might: '力',
  sanity: '智',
  knowledge: '识'
};

export interface HUDOptions {
  onSwitchGame: (gameId: string) => void;
  /** Restart the current game at a named scenario ('' = plain setup). */
  onSwitchScenario?: (scenarioId: string) => void;
}

/**
 * Presentation-only HUD.
 * It renders `GameSnapshot` DTOs and forwards intents to the presenter/ports.
 * It must not import the engine, game modules, audio or Three.js.
 */
function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, ch =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;'
  );
}

export class BoardGameHUD {
  private readonly container: HTMLElement;
  private presenter: GamePresenter;
  private readonly ports: PresentationPorts;
  private readonly options: HUDOptions;

  private unsubSnapshot: (() => void) | null = null;
  private unsubNotice: (() => void) | null = null;
  private announceTimer: number | null = null;
  private latest: GameSnapshot | null = null;
  /** 阶段二：在线玩家（联机对局 presence 映射后的 playerId 集合） */
  private onlinePlayerIds = new Set<string>();
  /** Room the player last clicked; the dossier follows it until the turn moves. */
  private pinnedRoomId?: string;
  /** Latest snapshot, kept for click handlers that need the current data. */
  private lastSnapshot?: GameSnapshot;
  /** Pointer position across the action row: 0 = left edge, 1 = right edge. */
  private fanFocusX = 0.5;
  /** 0 = flat row, 1 = full fisheye. Drops to 0 when the pointer leaves. */
  private fanFocusStrength = 0;
  private lastActorRoomId?: string;
  /** Set of room ids already seen, for the "new room discovered" reveal. */
  private knownRooms?: Set<string>;
  private sheetTimer: number | null = null;
  /** Haunt id whose overture has already played. */
  private lastHauntId?: string;
  /** False until the first snapshot has been observed. */
  private hauntArmed = false;
  private hauntTimer: number | null = null;
  /** Activity feed starts open and remembers the player's choice. */
  private historyCollapsed = false;
  /** Active isolated floor in the 3D scene ('ALL' displays all floors). */
  private selectedFloor = 'ALL';
  /** Phone shell: whether the action drawer is expanded. */
  private dockOpen = false;
  private shellMedia?: MediaQueryList;
  private diceOverlay?: DiceRollOverlay;
  /** The setup roll is not animated: opening a scenario should not play a dice cutscene. */
  private rollPrimed = false;
  /** Stamp of the last roll handed to the overlay, so each roll animates once. */
  private lastAnimatedStamp = '';
  /** Minimap can be collapsed to conserve screen space. */
  private minimapCollapsed = false;

  public setSelectedFloor(floorId: string): void {
    if (this.selectedFloor === floorId) return;
    this.selectedFloor = floorId;
    if (this.latest) {
      this.renderMinimap(this.latest);
      this.renderDock(this.latest);
    }
  }

  public getSelectedFloor(): string {
    return this.selectedFloor;
  }

  constructor(
    container: HTMLElement,
    presenter: GamePresenter,
    ports: PresentationPorts,
    options: HUDOptions
  ) {
    this.container = container;
    this.presenter = presenter;
    this.ports = ports;
    this.options = options;

    this.renderSkeleton();
    this.diceOverlay = new DiceRollOverlay(this.container);
    this.syncSoundButton();
    this.bindPresenter(presenter);
  }

  public setPresenter(presenter: GamePresenter): void {
    this.unsubSnapshot?.();
    this.unsubNotice?.();
    this.closePayload();
    this.closeAbout();
    this.container.querySelector('#card-sheet-layer')?.remove();
    // Switching fixtures must not treat the new board as "rooms discovered".
    this.knownRooms = undefined;
    this.pinnedRoomId = undefined;
    const roomCard = this.container.querySelector('#room-card') as HTMLElement | null;
    if (roomCard) roomCard.style.display = 'none';
    this.lastActorRoomId = undefined;
    this.lastHauntId = undefined;
    this.hauntArmed = false;
    this.selectedFloor = 'ALL';
    this.presenter = presenter;
    this.bindPresenter(presenter);
    this.syncSoundButton();
  }

  public dispose(): void {
    this.unsubSnapshot?.();
    this.unsubNotice?.();
  }

  public setInspectorActive(active: boolean): void {
    this.container.querySelector('#btn-inspector')?.classList.toggle('active', active);
  }

  /** Trigger an action as the user would (keyboard shortcuts). */
  public promptAction(actionId: string): void {
    const snapshot = this.latest;
    const action = snapshot?.actions.find(candidate => candidate.id === actionId);
    if (!snapshot || !action) return;
    // Placement is handled by the inline rotate/confirm controls, not a modal.
    if (snapshot.placement) return;
    this.runAction(action);
  }

  public closePayload(): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer) return;
    layer.style.display = 'none';
    layer.innerHTML = '';
  }

  /** 「关于」弹窗：展示当前构建的版本信息（git hash、作者、仓库地址等）。 */
  public openAbout(): void {
    if (this.container.querySelector('#about-layer')) return;

    const commitHash = typeof __COMMIT_HASH__ !== 'undefined' ? __COMMIT_HASH__ : 'unknown';
    const fullHash = typeof __COMMIT_FULL_HASH__ !== 'undefined' ? __COMMIT_FULL_HASH__ : commitHash;
    const commitDate = typeof __COMMIT_DATE__ !== 'undefined' ? __COMMIT_DATE__ : '';
    const repoUrl = typeof __REPO_URL__ !== 'undefined' ? __REPO_URL__ : '';
    const buildTime = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '';
    const repoHref = /^https?:\/\//.test(repoUrl) ? repoUrl : '';
    const totalCommits = typeof __TOTAL_COMMITS__ !== 'undefined' ? __TOTAL_COMMITS__ : '';

    const rawContributors: Array<{ login: string; commits?: number } | string> =
      typeof __CONTRIBUTORS__ !== 'undefined' && Array.isArray(__CONTRIBUTORS__) && __CONTRIBUTORS__.length > 0
        ? __CONTRIBUTORS__
        : typeof __COMMIT_AUTHOR__ !== 'undefined' && __COMMIT_AUTHOR__
        ? [__COMMIT_AUTHOR__]
        : ['unknown'];

    // 只展示 GitHub contributor ID，剥除可能附带的邮箱地址，并保留对应的 commit 次数统计。
    const contributors = rawContributors
      .map(item => {
        if (typeof item === 'string') {
          const login = item.replace(/<[^>]+>/g, '').trim();
          return login ? { login, commits: 0 } : null;
        }
        const login = String(item?.login || '').replace(/<[^>]+>/g, '').trim();
        return login ? { login, commits: Number(item?.commits) || 0 } : null;
      })
      .filter((item): item is { login: string; commits: number } => Boolean(item));

    const layer = document.createElement('div');
    layer.className = 'about-layer';
    layer.id = 'about-layer';
    // 所有来自构建期注入的值都按纯文本转义
    const esc = (value: string): string =>
      value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const commitBreakdown = contributors
      .filter(c => c.commits > 0)
      .map(c => `${esc(c.login)}: ${c.commits}`)
      .join(' · ');

    layer.innerHTML = `
      <div class="about-backdrop" data-about-close></div>
      <div class="about-card" role="dialog" aria-modal="true" aria-label="关于 · 版本信息">
        <div class="pf-head">
          <div class="pf-ico">𝒢</div>
          <div>
            <div class="pf-title">关于 · 通用桌游模拟器</div>
            <div class="pf-hint">UNIVERSAL BOARD GAME KERNEL · 构建版本信息</div>
          </div>
        </div>
        <dl class="about-rows">
          <div class="about-row">
            <dt>Git Hash</dt>
            <dd><code title="${esc(fullHash)}">${esc(commitHash)}</code></dd>
          </div>
          <div class="about-row">
            <dt>Contributors</dt>
            <dd class="about-contributors">${
              contributors.length > 0
                ? contributors
                    .map(c => {
                      const safeId = esc(c.login);
                      const isGhUser = /^[\w-]+$/.test(c.login);
                      const countBadge = c.commits > 0
                        ? `<span class="contributor-commits" title="${c.commits} 次提交">${c.commits}</span>`
                        : '';
                      return isGhUser
                        ? `<a class="contributor-tag" href="https://github.com/${safeId}" target="_blank" rel="noopener noreferrer">${safeId}${countBadge}</a>`
                        : `<span class="contributor-tag">${safeId}${countBadge}</span>`;
                    })
                    .join('')
                : 'unknown'
            }</dd>
          </div>
          <div class="about-row">
            <dt>Repository</dt>
            <dd class="about-repo">${
              repoHref
                ? `<a href="${esc(repoHref)}" target="_blank" rel="noopener noreferrer">${esc(repoUrl)}</a>`
                : esc(repoUrl) || 'unknown'
            }</dd>
          </div>
          <div class="about-row">
            <dt>Commits</dt>
            <dd class="about-commits">
              <span class="commit-total"><strong>${esc(totalCommits || '140+')}</strong> 次提交</span>
              ${commitBreakdown ? `<span class="commit-breakdown">（${commitBreakdown}）</span>` : ''}
            </dd>
          </div>
          ${commitDate ? `<div class="about-row"><dt>Commit Date</dt><dd>${esc(commitDate)}</dd></div>` : ''}
          ${buildTime ? `<div class="about-row"><dt>Build Time</dt><dd>${esc(buildTime)}</dd></div>` : ''}
        </dl>
        <div class="pf-foot">
          <button class="pf-btn primary about-close" data-about-close>关闭</button>
        </div>
      </div>
    `;
    this.container.appendChild(layer);

    const close = () => this.closeAbout();
    layer.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('[data-about-close]')) close();
    });
    layer.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });
    (layer.querySelector('.about-close') as HTMLElement | null)?.focus();
  }

  public closeAbout(): void {
    const layer = this.container.querySelector('#about-layer') as HTMLElement | null;
    if (!layer) return;
    const opener = this.container.querySelector('#btn-about') as HTMLElement | null;
    layer.remove();
    opener?.focus();
  }

  /** Reflect the renderer's camera state without owning the camera. */
  public syncCamera(view: CameraView): void {
    this.container.querySelectorAll<HTMLElement>('.cam-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.cam === view);
    });
  }

  /**
   * Lightweight hover chip for the 3D board: shows what the cursor is over and
   * what a click will do, without stealing focus from the action dock.
   */
  public showHoverHint(
    hint: { title: string; detail?: string; art?: string } | null
  ): void {
    let el = this.container.querySelector('#hover-hint') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = 'hover-hint';
      el.className = 'hover-hint';
      this.container.appendChild(el);
    }
    if (!hint) {
      el.classList.remove('on');
      el.classList.remove('with-art');
      return;
    }
    // A new hover invalidates an open sheet for a previous card: keeping it up
    // would show one card's detail beside another card's preview.
    const sheetLayer = this.container.querySelector('#card-sheet-layer');
    if (sheetLayer?.classList.contains('open')) {
      sheetLayer.classList.remove('open', 'is-reveal');
      sheetLayer.innerHTML = '';
    }
    const signature = `${hint.title}|${hint.detail ?? ''}|${hint.art ?? ''}`;
    if (el.dataset.signature === signature) {
      el.classList.add('on');
      return;
    }
    el.dataset.signature = signature;
    // A card face gets a full preview above the caption: a one-line tooltip
    // cannot convey a card's art at board scale.
    el.classList.toggle('with-art', !!hint.art);
    el.innerHTML =
      (hint.art ? `<img class="hh-art" src="${escapeAttr(hint.art)}" alt="${escapeAttr(hint.title)}" />` : '') +
      `<span class="hh-body"><b>${hint.title}</b>${hint.detail ? `<span>${hint.detail}</span>` : ''}</span>`;
    el.classList.add('on');
  }

  public pushToast(icon: string, text: string, ttl = 3600, detail?: string): void {
    const stack = document.getElementById('toast-container');
    if (!stack) return;

    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="t-ico">${icon}</span><span class="t-txt">${text}${
      detail ? `<span class="t-detail">${detail}</span>` : ''
    }</span>`;
    stack.appendChild(el);

    while (stack.children.length > 4) stack.removeChild(stack.firstElementChild!);

    window.setTimeout(() => {
      el.classList.add('out');
      window.setTimeout(() => el.remove(), 260);
    }, ttl);
  }

  public showAnnouncement(title: string, durationMs = 2000): void {
    const banner = this.container.querySelector('#announce') as HTMLElement | null;
    if (!banner) return;

    if (this.announceTimer) window.clearTimeout(this.announceTimer);

    banner.innerHTML = `<span class="a-mark">❖</span><span>${title}</span>`;
    banner.style.display = 'flex';
    banner.classList.remove('out');

    if (/Winner|HU!|Game Over|胜利|结束/.test(title)) {
      confetti({ particleCount: 90, spread: 78, origin: { y: 0.62 }, colors: ['#d9b45b', '#f6dc9c', '#ffffff'] });
    }

    this.announceTimer = window.setTimeout(() => {
      banner.classList.add('out');
      window.setTimeout(() => {
        banner.style.display = 'none';
        banner.classList.remove('out');
      }, 280);
    }, Math.max(1200, durationMs));
  }

  /* ------------------------------------------------------------------ */

  private bindPresenter(presenter: GamePresenter): void {
    this.unsubSnapshot = presenter.subscribe(snapshot => this.render(snapshot));
    this.unsubNotice = presenter.onNotice(notice => this.renderNotice(notice));
  }

  /** Mirror the slide-over state onto the toggles for assistive tech. */
  private syncShellAria(): void {
    for (const [attr, sel] of [
      ['data-side', '[data-toggle="side"]'],
      ['data-rail', '[data-toggle="rail"]']
    ] as const) {
      const button = this.container.querySelector(sel) as HTMLElement | null;
      if (button) button.setAttribute('aria-expanded', this.container.getAttribute(attr) === 'open' ? 'true' : 'false');
    }
  }

  /**
   * Phone shell: the topbar cannot fit the scenario/viewer/camera controls, so
   * they are relocated into the side panel instead of being dropped. The same
   * DOM nodes move, so their listeners and values survive.
   */
  private applyShellLayout(): void {
    const slot = this.container.querySelector('#side-panel-extras') as HTMLElement | null;
    const actions = this.container.querySelector('.topbar-actions') as HTMLElement | null;
    if (!slot || !actions) return;

    const movers = ['.scenario-switch', '.viewer-switch', '.cam-switch']
      .map(sel => this.container.querySelector(sel) as HTMLElement | null)
      .filter((el): el is HTMLElement => !!el);

    const phone = window.matchMedia('(max-width: 767px)').matches;
    for (const el of movers) {
      if (phone) {
        if (el.parentElement !== slot) slot.append(el);
      } else if (el.parentElement !== actions) {
        // Restore the original order: before the first icon button.
        const anchor = actions.querySelector('.icon-btn');
        actions.insertBefore(el, anchor);
      }
    }
  }

  private openPayloadForm(action: UiAction): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer || (!action.fields?.length && !action.selection)) return;

    const fields = (action.fields ?? [])
      .map(field => {
        if (field.kind === 'enum') {
          const options = (field.options ?? [])
            .map(option => {
              const selected = field.default === option.value ? ' selected' : '';
              return `<option value="${option.value}"${selected}>${option.label}</option>`;
            })
            .join('');
          return `
            <label class="pf-row" data-field-row="${field.key}">
              <span class="pf-label">${field.label}</span>
              <select class="pf-control" data-field="${field.key}">${options}</select>
            </label>
          `;
        }

        if (field.kind === 'boolean') {
          return `
            <label class="pf-row pf-check" data-field-row="${field.key}">
              <input class="pf-control" data-field="${field.key}" type="checkbox" ${field.default ? 'checked' : ''} />
              <span class="pf-label">${field.label}</span>
            </label>
          `;
        }

        if (field.kind === 'string') {
          return `
            <label class="pf-row" data-field-row="${field.key}">
              <span class="pf-label">${field.label}</span>
              <input class="pf-control" data-field="${field.key}" type="text" value="${field.default ?? ''}" />
            </label>
          `;
        }

        if (field.kind === 'json') {
          return `
            <label class="pf-row" data-field-row="${field.key}">
              <span class="pf-label">${field.label}</span>
              <textarea class="pf-control" data-field="${field.key}" rows="3">${
                field.default === undefined ? '' : JSON.stringify(field.default)
              }</textarea>
            </label>
          `;
        }

        const value = field.default ?? field.min ?? 0;
        return `
          <label class="pf-row" data-field-row="${field.key}">
            <span class="pf-label">${field.label}</span>
            <input class="pf-control" data-field="${field.key}" type="number"
              value="${value}" min="${field.min ?? ''}" max="${field.max ?? ''}" step="${field.step ?? 1}" />
          </label>
        `;
      })
      .join('');

    const selection = action.selection
      ? `
        <div class="pf-row">
          <span class="pf-label">选择目标（${action.selection.spec.min}–${action.selection.spec.max}）</span>
          <div class="pf-targets" data-selection-min="${action.selection.spec.min}" data-selection-max="${action.selection.spec.max}">
            ${
              action.selection.candidates.length > 0
                ? action.selection.candidates
                    .map(
                      candidate => `
                        <label class="pf-target">
                          <input type="checkbox" data-target="${candidate.id}" />
                          <span>${candidate.icon ? `${candidate.icon} ` : ''}${candidate.label}</span>
                        </label>`
                    )
                    .join('')
                : '<div class="pf-empty">当前没有可选目标</div>'
            }
          </div>
        </div>`
      : '';

    layer.innerHTML = `
      <div class="payload-backdrop"></div>
      <form class="payload-card" autocomplete="off">
        <header class="pf-head">
          <span class="pf-ico">${action.icon}</span>
          <div>
            <div class="pf-title">${action.label}</div>
            <div class="pf-hint">${action.hint}</div>
          </div>
        </header>
        <div class="pf-body">${selection}${fields}</div>
        <footer class="pf-foot">
          <button type="button" class="pf-btn" id="pf-cancel">取消</button>
          <button type="submit" class="pf-btn primary">确认</button>
        </footer>
      </form>
    `;
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.innerHTML = '';
    };

    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#pf-cancel')?.addEventListener('click', close);

    const form = layer.querySelector('form') as HTMLFormElement;

    const fieldValue = (key: string): unknown => {
      const control = form.querySelector(`[data-field="${key}"]`) as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement
        | null;
      if (!control) return undefined;
      if (control instanceof HTMLInputElement && control.type === 'checkbox') return control.checked;
      return control.value;
    };
    const applyFieldVisibility = (): void => {
      for (const field of action.fields ?? []) {
        const row = form.querySelector(`[data-field-row="${field.key}"]`) as HTMLElement | null;
        if (!row) continue;
        const dep = field.dependsOn;
        if (!dep) {
          row.style.display = '';
          continue;
        }
        const value = fieldValue(dep.key);
        const visible =
          dep.truthy !== undefined
            ? Boolean(value) === dep.truthy
            : dep.equals !== undefined
            ? String(value) === String(dep.equals)
            : true;
        row.style.display = visible ? '' : 'none';
      }
    };
    form.querySelectorAll('[data-field]').forEach(control => {
      control.addEventListener('change', applyFieldVisibility);
      control.addEventListener('input', applyFieldVisibility);
    });
    applyFieldVisibility();

    form.addEventListener('submit', event => {
      event.preventDefault();
      const payload: Record<string, unknown> = {};
      for (const field of action.fields ?? []) {
        const row = form.querySelector(`[data-field-row="${field.key}"]`) as HTMLElement | null;
        if (row && row.style.display === 'none') continue;
        const control = form.querySelector(`[data-field="${field.key}"]`) as
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement
          | null;
        if (!control) continue;
        if (field.kind === 'boolean') {
          payload[field.key] = (control as HTMLInputElement).checked;
        } else if (field.kind === 'json') {
          try {
            payload[field.key] = control.value.trim() === '' ? null : JSON.parse(control.value);
          } catch {
            this.pushToast('⚠️', `${field.label} 不是合法 JSON`);
            return;
          }
        } else {
          payload[field.key] = field.kind === 'number' ? Number(control.value) : control.value;
        }
      }

      const targets = Array.from(form.querySelectorAll<HTMLInputElement>('[data-target]:checked')).map(
        input => input.dataset.target ?? ''
      );
      if (action.selection) {
        if (targets.length < action.selection.spec.min || targets.length > action.selection.spec.max) {
          this.pushToast('◌', `请选择 ${action.selection.spec.min}–${action.selection.spec.max} 个目标`);
          return;
        }
      }

      const result = this.performAction(action.id, payload, targets);
      if (!result.ok) {
        this.pushToast('⚠️', result.error ?? '动作被拒绝');
        return;
      }
      close();
    });

    (form.querySelector('[data-field]') as HTMLElement | null)?.focus();
  }

  private renderNotice(notice: UiNotice): void {
    if (notice.roomId) {
      this.pinnedRoomId = notice.roomId;
      // Inspection does not dispatch an action, so no snapshot arrives with it:
      // repaint the dossier straight away.
      if (this.latest) this.renderRoomCard(this.latest);
    }
    // Trait movement gets the loud treatment: banner, card shake, pip flash,
    // screen tint and a 3D burst over the miniature.
    if (notice.trait) this.flashTraitChange(notice.trait);
    if (notice.kind === 'announce') {
      this.showAnnouncement(notice.title, notice.durationMs ?? 1800);
      return;
    }
    if (notice.card) {
      this.showCardSheet(notice.card);
      return;
    }
    this.pushToast(notice.icon, notice.title, notice.durationMs ?? 3200, notice.detail);
  }

  /**
   * Emphasise a trait movement.
   *
   * The rail has already been repainted with the new ladder when this runs, so
   * the effect re-targets the fresh DOM instead of the pre-damage values.
   */
  private flashTraitChange(change: UiTraitChange): void {
    const loss = change.delta < 0;
    const tone = loss ? (change.damageKind === 'MENTAL' ? 'mental' : 'physical') : 'heal';

    // 1. Full-screen vignette + board shake.
    this.pulseScreen(tone);

    // 2. Card shake, pip flash and floating delta over the affected sheet.
    const card = this.container.querySelector<HTMLElement>(
      `#player-rail .pc[data-player-id="${change.playerId}"]`
    );
    if (card) {
      card.classList.remove('trait-hit', 'trait-heal');
      // Force a reflow so the animation restarts on repeated hits.
      void card.offsetWidth;
      card.classList.add(loss ? 'trait-hit' : 'trait-heal');

      const short = HUD_TRAIT_SHORT[change.traitKey] ?? '';
      card.querySelectorAll<HTMLElement>('.trait-row').forEach(row => {
        if ((row.querySelector('.trait-key')?.textContent ?? '').trim() !== short) return;
        row.classList.remove('flash-down', 'flash-up');
        void row.offsetWidth;
        row.classList.add(loss ? 'flash-down' : 'flash-up');
      });

      const burst = document.createElement('div');
      burst.className = `trait-burst ${tone}`;
      burst.textContent = `${change.traitLabel} ${change.delta > 0 ? '+' : ''}${change.delta}`;
      card.appendChild(burst);
      window.setTimeout(() => burst.remove(), 1500);
    }

    // 3. Renderer-side burst + matching SFX.
    this.ports.showTraitChange?.(change);
  }

  /** Coloured edge flash; mental damage reads violet, physical reads blood. */
  private pulseScreen(tone: 'physical' | 'mental' | 'heal'): void {
    let layer = this.container.querySelector<HTMLElement>('#screen-hit');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'screen-hit';
      layer.className = 'screen-hit';
      this.container.appendChild(layer);
    }
    layer.classList.remove('physical', 'mental', 'heal');
    void layer.offsetWidth;
    layer.classList.add(tone);
  }

  /**
   * Framed card detail sheet in the mansion's own visual language: aged
   * parchment, a suit-coloured header ribbon, and a wax seal for omens.
   */
  public showCardSheet(card: UiCardDetail, options: { reveal?: boolean; footer?: string } = {}): void {
    // The sheet supersedes the hover preview: both describe the same card, and
    // leaving the little preview up next to the full sheet reads as two
    // different cards (the tooltip sits behind the sheet's corner).
    this.showHoverHint(null);
    let layer = this.container.querySelector('#card-sheet-layer') as HTMLElement | null;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'card-sheet-layer';
      layer.className = 'card-sheet-layer';
      this.container.appendChild(layer);
    }

    // Ink is the *light* text on the dark plate; ribbon is the dark category band.
    const palette: Record<string, { ink: string; ribbon: string; label: string; seal: string }> = {
      OMEN: { ink: '#f2cfd8', ribbon: '#4a1020', label: '预兆 · OMEN', seal: '👁' },
      ITEM: { ink: '#f0dfc2', ribbon: '#3f2c12', label: '遗物 · ITEM', seal: '◆' },
      EVENT: { ink: '#dbe6f2', ribbon: '#1d2733', label: '事件 · EVENT', seal: '✦' },
      ROOM: { ink: '#efdfc6', ribbon: '#33261a', label: '房间 · ROOM', seal: '⌂' }
    };
    const theme = palette[card.kind] ?? palette.ITEM;

    const facts = (card.facts ?? [])
      .map(row => `<li><span>${row.label}</span><b>${row.value}</b></li>`)
      .join('');

    layer.classList.toggle('is-reveal', !!options.reveal);
    layer.innerHTML = `
      <article class="card-sheet" data-kind="${card.kind}" style="--ink:${theme.ink};--ribbon:${theme.ribbon}">
        <button class="cs-close" type="button" aria-label="关闭">×</button>
        <div class="cs-ribbon"><span>${theme.label}</span></div>
        <div class="cs-body">
          <div class="cs-art">${
            card.art
              ? `<img class="cs-art-img" src="${escapeAttr(card.art)}" alt="${escapeAttr(card.title)}" />`
              : cardArtSvg(card)
          }</div>
          ${card.actions?.length ? `<div class="cs-actions">${card.actions
            .map(action => `<button type="button" class="cs-action" data-card-action="${action.id}"><span>${action.icon}</span>${action.label}</button>`)
            .join('')}</div>` : ''}
          <div class="cs-seal">${theme.seal}</div>
          <h2 class="cs-title">${card.title}</h2>
          ${card.en ? `<div class="cs-en">${card.en}</div>` : ''}
          <div class="cs-rule"></div>
          <p class="cs-desc">${card.desc}</p>
          ${facts ? `<ul class="cs-facts">${facts}</ul>` : ''}
        </div>
        <div class="cs-foot">${options.footer ?? '点击牌堆或场景实体继续'}</div>
      </article>
    `;
    layer.classList.add('open');

    const close = () => {
      layer!.classList.remove('open', 'is-reveal');
      layer!.innerHTML = '';
    };
    layer.querySelector('.cs-close')?.addEventListener('click', close);
    layer.querySelectorAll<HTMLElement>('[data-card-action]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const actionId = button.dataset.cardAction;
        close();
        if (actionId) this.performAction(actionId);
      });
    });
    layer.addEventListener('click', event => {
      if (event.target === layer) close();
    });
    if (this.sheetTimer) window.clearTimeout(this.sheetTimer);
    this.sheetTimer = window.setTimeout(close, options.reveal ? 7000 : 9000);
  }

  /**
   * Discovery moment: when a newly explored room enters the projection, present
   * it like a drawn card instead of silently growing the board.
   */
  /**
   * 所有动作的统一入口。
   *
   * 除了转交 presenter，还把「做了什么、成功没有」记进诊断面包屑 —— 卡死时
   * 这份最近动作清单就是最直接的线索（见 apps/web/src/diagnostics）。
   */
  private performAction(
    actionId: string,
    payload?: Record<string, unknown>,
    targets?: string[]
  ): { ok: boolean; error?: string } {
    // Must call the presenter, not this method: an earlier mechanical edit turned
    // this line into a self-call, so every action recursed until the stack blew.
    const result = this.presenter.perform(actionId, payload, targets);
    const label = payload ? `${actionId} ${JSON.stringify(payload)}` : actionId;
    diagnostics()?.action(targets ? `${label} -> ${targets.join(',')}` : label, result.ok, result.error);
    return result;
  }

  private maybeRevealRoom(snapshot: GameSnapshot): void {
    const rooms = Object.values(snapshot.board.mapGraph.nodes).filter(node => node.type === 'ROOM');
    if (!this.knownRooms) {
      // First paint: register the opening layout without a cutscene.
      this.knownRooms = new Set(rooms.map(node => node.id));
      return;
    }
    const fresh = rooms.filter(node => !this.knownRooms!.has(node.id));
    for (const node of rooms) this.knownRooms.add(node.id);
    if (fresh.length === 0) return;

    const node = fresh[fresh.length - 1];
    const props = (node.props ?? {}) as Record<string, unknown>;
    const floorId = String(props.floor ?? '');
    const floorLabel = floorId === 'BASEMENT' ? '地下室' : floorId === 'UPPER' ? '二楼' : '一楼';
    const doors = Array.isArray(props.doors) ? (props.doors as string[]) : [];
    const symbol =
      props.symbol === 'OMEN'
        ? '预兆 👁'
        : props.symbol === 'ITEM'
        ? '遗物 ◆'
        : props.symbol === 'EVENT'
        ? '事件 ✦'
        : '无符号';
    this.pinnedRoomId = node.id;
    this.showCardSheet(
      {
        title: String(props.name ?? '房间'),
        en: String(props.en ?? ''),
        kind: 'ROOM',
        desc: String(props.text ?? ''),
        facts: [
          { label: '楼层', value: floorLabel },
          { label: '已连通门位', value: doors.join(' · ') || '无' },
          { label: '符号', value: symbol }
        ]
      },
      { reveal: true, footer: '新房间已加入洋馆布局' }
    );
  }

  /**
   * Full-screen haunt overture. The rules already flip `hauntTriggered` and
   * write a role-filtered objective into `mission`; this is pure presentation.
   */
  private maybeShowHaunt(snapshot: GameSnapshot): void {
    const vars = (snapshot.board.globalVars ?? {}) as Record<string, unknown>;
    const haunt = vars.haunt as
      | { id?: string; number?: number; title?: string; intro?: string; traitorId?: string }
      | null
      | undefined;
    if (!vars.hauntTriggered || !haunt?.id) {
      this.hauntArmed = true;
      return;
    }
    if (!this.hauntArmed) {
      // Scenario jumps can open straight into a haunt; do not replay the
      // overture for a board the player just loaded.
      this.hauntArmed = true;
      this.lastHauntId = haunt.id;
      return;
    }
    if (this.lastHauntId === haunt.id) return;
    this.lastHauntId = haunt.id;

    const traitor = haunt.traitorId ? snapshot.board.players[haunt.traitorId] : undefined;
    let layer = this.container.querySelector('#haunt-cine') as HTMLElement | null;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'haunt-cine';
      layer.className = 'haunt-cine';
      this.container.appendChild(layer);
    }
    layer.innerHTML = `
      <div class="hc-vignette"></div>
      <div class="hc-inner">
        <div class="hc-kicker">作祟开始 · THE HAUNT BEGINS</div>
        <div class="hc-number">HAUNT No.${String(haunt.number ?? '?').padStart(2, '0')}</div>
        <h1 class="hc-title">${String(haunt.title ?? '未知作祟')}</h1>
        <div class="hc-rule"></div>
        ${haunt.intro ? `<p class="hc-story">${haunt.intro}</p>` : ''}
        ${
          traitor
            ? `<div class="hc-traitor">背叛者 · <b>${traitor.name}</b></div>`
            : '<div class="hc-traitor">背叛者尚未现身</div>'
        }
        <p class="hc-objective">${snapshot.mission ?? ''}</p>
        <div class="hc-hint">点击任意处继续</div>
      </div>
    `;
    layer.classList.add('open');

    const close = () => {
      layer!.classList.remove('open');
      layer!.innerHTML = '';
      layer!.removeEventListener('click', close);
    };
    layer.addEventListener('click', close);
    if (this.hauntTimer) window.clearTimeout(this.hauntTimer);
    this.hauntTimer = window.setTimeout(close, 9000);
  }

  private syncSoundButton(): void {
    const button = this.container.querySelector('#btn-audio') as HTMLElement | null;
    if (!button) return;
    const on = this.ports.isSoundOn();
    button.classList.toggle('active', on);
    button.textContent = on ? '♪' : '✕';
  }

  /** 阶段二：设置在线玩家并刷新玩家卡在线点（未知 playerId 视为离线）。 */
  public setOnlinePlayers(playerIds: string[]): void {
    this.onlinePlayerIds = new Set(playerIds);
    if (this.latest) this.renderPlayers(this.latest);
  }

  private renderSkeleton(): void {
    this.container.classList.add('app-shell');
    this.container.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">𝒢</div>
          <div class="brand-text">
            <div class="brand-title">通用桌游内核</div>
            <div class="brand-sub">UNIVERSAL GAME KERNEL</div>
          </div>
        </div>

        <nav class="game-switch" id="game-switch">
          ${GAME_TABS.map(
            tab => `
            <button class="game-pill" data-game="${tab.id}">
              <span class="gp-ico">${tab.icon}</span><span>${tab.name}</span>
            </button>
          `
          ).join('')}
        </nav>

        <button class="shell-toggle" data-toggle="rail" aria-label="显示角色栏">☰ 角色</button>

        <div class="topbar-actions">
          <div class="scenario-switch" id="scenario-switch" style="display:none" title="切换局内场景 · 会重开牌局">
            <span class="vs-label">❖ 局内场景</span>
            <select id="scenario-select"></select>
          </div>

          <div class="viewer-switch" title="认知滤镜 O(s,i)：切换全知视角或受限玩家视角">
            <span class="vs-label">𝒪 滤镜</span>
            <select id="viewer-select"></select>
          </div>

          <div class="cam-switch">
            <button class="cam-btn active" data-cam="iso">2.5D等轴</button>
            <button class="cam-btn" data-cam="top">俯视</button>
            <button class="cam-btn" data-cam="seat">座位</button>
          </div>

          <button class="icon-btn" id="btn-undo" aria-label="撤销上一步">↶<span class="tip">撤销上一步动作</span></button>
          <button class="icon-btn danger" id="btn-exit-net" aria-label="退出对局" hidden>⎋<span class="tip">退出对局</span></button>
          <button class="icon-btn" id="btn-audio" aria-label="音效">♪<span class="tip">音效开关</span></button>
          <button class="icon-btn" id="btn-inspector" aria-label="数学模型">𝒢<span class="tip">内核检查器 · I</span></button>
          <button class="icon-btn" id="btn-diagnostics" aria-label="导出诊断日志">⤓<span class="tip">导出诊断日志（问题反馈用）</span></button>
          <button class="icon-btn" id="btn-about" aria-label="关于">ⓘ<span class="tip">关于 · 版本信息</span></button>
          <button class="shell-toggle" data-toggle="side" aria-label="显示信息栏">▤ 信息</button>
        </div>
      </header>

      <aside class="player-rail" id="player-rail"></aside>
      <!-- Right-hand panels share one column so they stack instead of
           overlapping; each used to be absolutely positioned with a
           hand-computed top offset. -->
      <div class="side-column" id="side-column">
        <div class="side-panel-extras" id="side-panel-extras"></div>
        <!-- Edition picker: only shown when the game ships several rule sets,
             so a single-variant fixture keeps the column unchanged. -->
        <aside class="room-card" id="room-card" style="display:none"></aside>
        <aside class="mansion-minimap" id="mansion-minimap" style="display:none"></aside>
        <aside class="activity-feed" id="activity-feed"></aside>
      </div>
      <div class="action-dock" id="action-dock"></div>
      <div class="announcement-banner" id="announce" style="display:none"></div>
      <div class="payload-layer" id="payload-layer" style="display:none"></div>
    `;

    // Tablet/phone slide-overs. Only one panel is open at a time so the board
    // is never covered by two overlays.
    this.applyShellLayout();
    this.syncShellAria();
    window.addEventListener('resize', () => this.applyShellLayout());
    this.shellMedia = window.matchMedia('(max-width: 767px)');
    this.shellMedia.addEventListener('change', () => this.applyShellLayout());

    // Escape closes whatever slide-over is open, so keyboard users are never
    // trapped behind a panel they cannot see past.
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      let closed = false;
      for (const [attr, sel] of [
        ['data-side', '[data-toggle="side"]'],
        ['data-rail', '[data-toggle="rail"]']
      ] as const) {
        if (this.container.getAttribute(attr) === 'open') {
          this.container.removeAttribute(attr);
          (this.container.querySelector(sel) as HTMLElement | null)?.focus();
          closed = true;
        }
      }
      if (closed) event.preventDefault();
    });

    this.container.querySelectorAll<HTMLElement>('[data-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        const which = button.dataset.toggle === 'rail' ? 'data-rail' : 'data-side';
        const other = which === 'data-rail' ? 'data-side' : 'data-rail';
        const isOpen = this.container.getAttribute(which) === 'open';
        this.container.removeAttribute(other);
        if (isOpen) this.container.removeAttribute(which);
        else this.container.setAttribute(which, 'open');
        this.syncShellAria();
      });
    });

    this.container.querySelectorAll<HTMLElement>('.game-pill').forEach(button => {
      button.addEventListener('click', () => {
        const id = button.dataset.game;
        if (id) this.options.onSwitchGame(id);
      });
    });

    this.container.querySelector('#viewer-select')?.addEventListener('change', event => {
      this.presenter.setViewer((event.target as HTMLSelectElement).value);
    });

    this.container.querySelector('#scenario-select')?.addEventListener('change', event => {
      const id = (event.target as HTMLSelectElement).value;
      this.options.onSwitchScenario?.(id);
    });

    this.container.querySelectorAll<HTMLElement>('.cam-btn').forEach(button => {
      button.addEventListener('click', () => {
        const view = button.dataset.cam as CameraView | undefined;
        if (!view) return;
        this.container.querySelectorAll('.cam-btn').forEach(b => { b.classList.remove('active'); });
        button.classList.add('active');
        this.ports.setCamera(view);
      });
    });

    this.container.querySelector('#btn-audio')?.addEventListener('click', () => {
      this.ports.setSound(!this.ports.isSoundOn());
      this.syncSoundButton();
    });

    this.container.querySelector('#btn-diagnostics')?.addEventListener('click', () => {
      diagnostics()?.download();
    });
    this.container.querySelector('#btn-inspector')?.addEventListener('click', () => {
      this.ports.toggleInspector();
    });

    this.container.querySelector('#btn-about')?.addEventListener('click', () => {
      this.openAbout();
    });

    this.container.querySelector('#btn-undo')?.addEventListener('click', () => {
      const snapshot = this.latest;
      if (!snapshot || snapshot.log.cursor <= 0) {
        this.pushToast('↶', '没有可撤销的动作');
        return;
      }
      this.presenter.rewind(snapshot.log.cursor - 1);
      this.pushToast('↶', '已撤销上一步');
    });
  }

  private render(snapshot: GameSnapshot): void {
    this.latest = snapshot;
    if (!this.rollPrimed) {
      // Mark whatever the session already carries as seen: reloading mid-game must
      // not replay an old roll, but any roll after this point must animate.
      this.rollPrimed = true;
      this.lastAnimatedStamp = snapshot.lastRoll?.stamp ?? '';
    }
    this.maybeAnimateRoll(snapshot);
    // Betrayal uses a candle-lit parchment palette; other fixtures stay slate.
    this.lastSnapshot = snapshot;
    this.container.dataset.theme = snapshot.gameId === 'betrayal' ? 'gothic' : '';
    this.container.querySelectorAll<HTMLElement>('.game-pill').forEach(button => {
      button.classList.toggle('active', button.dataset.game === snapshot.gameId);
    });

    this.renderViewerSelect(snapshot);
    this.renderScenarioSelect(snapshot);
    this.renderPlayers(snapshot);
    this.renderRoomCard(snapshot);
    this.renderMinimap(snapshot);
    this.renderHistory(snapshot);
    this.renderDock(snapshot);
    this.maybeRevealRoom(snapshot);
    this.maybeShowHaunt(snapshot);
  }

  /**
   * Architectural vector minimap for Betrayal: shows all three floors
   * (2F Upper, 1F Ground, B Basement) as a vertical cutaway slice with real room
   * layout, player position dots, and viewport isolation indicator.
   */
  private renderMinimap(snapshot: GameSnapshot): void {
    const el = this.container.querySelector('#mansion-minimap') as HTMLElement | null;
    if (!el) return;
    if (snapshot.gameId !== 'betrayal') {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.classList.toggle('collapsed', this.minimapCollapsed);

    const floors = [
      { id: 'UPPER', level: '2F', name: '二楼' },
      { id: 'GROUND', level: '1F', name: '一楼' },
      { id: 'BASEMENT', level: 'B', name: '地下室' }
    ];

    const isAll = this.selectedFloor === 'ALL';
    const activeActorId = snapshot.focus[0] ?? snapshot.viewer;
    const actorPlayer = snapshot.board.players[activeActorId];
    const actorRoomId = String(actorPlayer?.customProps?.currentRoomId ?? '');
    const actorRoom = snapshot.board.mapGraph.nodes[actorRoomId];
    const actorFloor = String(actorRoom?.props?.floor ?? '');

    const floorItems = floors.map(floor => {
      const rooms = Object.values(snapshot.board.mapGraph.nodes).filter(
        n => n.type === 'ROOM' && String(n.props?.floor ?? '') === floor.id
      );

      // Find players on this floor
      const playersOnFloor = Object.values(snapshot.board.players).filter(p => {
        if (!p.alive || p.customProps?.banished) return false;
        const r = snapshot.board.mapGraph.nodes[String(p.customProps?.currentRoomId ?? '')];
        return String(r?.props?.floor ?? '') === floor.id;
      });

      // Find monsters on this floor
      const monstersOnFloor = Object.values(snapshot.board.entities ?? {}).filter(e => {
        const custom = e?.components?.custom as Record<string, unknown> | undefined;
        if (e.type !== 'MEEPLE' || !custom?.monster || custom?.destroyed) return false;
        const r = snapshot.board.mapGraph.nodes[String(custom.roomId ?? '')];
        return String(r?.props?.floor ?? '') === floor.id;
      });

      let svgHtml = '';
      if (rooms.length === 0) {
        svgHtml = `<div class="mm-empty-floor">未探索</div>`;
      } else {
        const cols = rooms.map(r => Number(r.props?.col ?? 2));
        const rows = rooms.map(r => Number(r.props?.row ?? 2));
        const minCol = Math.min(...cols);
        const maxCol = Math.max(...cols);
        const minRow = Math.min(...rows);
        const maxRow = Math.max(...rows);

        const cellSize = 16;
        const roomSize = 13;
        const padding = 3;
        const svgW = (maxCol - minCol + 1) * cellSize + padding * 2;
        const svgH = (maxRow - minRow + 1) * cellSize + padding * 2;

        const roomRects = rooms.map(r => {
          const c = Number(r.props?.col ?? 2);
          const rw = Number(r.props?.row ?? 2);
          const rx = (c - minCol) * cellSize + padding;
          const ry = (rw - minRow) * cellSize + padding;
          const isActorHere = actorRoomId === r.id;
          const isPinned = this.pinnedRoomId === r.id;

          const herePlayers = playersOnFloor.filter(p => p.customProps?.currentRoomId === r.id);
          const hereMonsters = monstersOnFloor.filter(m => (m.components?.custom as any)?.roomId === r.id);

          const dots = [
            ...herePlayers.map((p, idx) => `<circle cx="${rx + 3.5 + idx * 5}" cy="${ry + roomSize / 2}" r="2.8" fill="${p.color}" stroke="#000" stroke-width="0.8"/>`),
            ...hereMonsters.map((_, idx) => `<circle cx="${rx + roomSize - 3.5 - idx * 5}" cy="${ry + roomSize / 2}" r="2.8" fill="#b07bf0" stroke="#ff4d4d" stroke-width="0.8"/>`)
          ].join('');

          const fill = isActorHere ? 'rgba(217, 180, 91, 0.45)' : isPinned ? 'rgba(87, 192, 139, 0.4)' : 'rgba(217, 180, 91, 0.14)';
          const stroke = isActorHere ? '#f6dc9c' : isPinned ? '#57c08b' : 'rgba(217, 180, 91, 0.38)';

          return `
            <g class="mm-room-node" data-room-id="${r.id}" data-floor="${floor.id}">
              <rect x="${rx}" y="${ry}" width="${roomSize}" height="${roomSize}" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="${isActorHere || isPinned ? 1.5 : 1}">
                <title>${r.props?.name ?? ''} (${floor.name})</title>
              </rect>
              ${dots}
            </g>
          `;
        }).join('');

        svgHtml = `
          <svg class="mm-floor-svg" viewBox="0 0 ${svgW} ${svgH}" style="width:${Math.min(130, svgW)}px; height:${Math.min(50, svgH)}px;">
            ${roomRects}
          </svg>
        `;
      }

      const isCurrentFloor = this.selectedFloor === floor.id;
      const isActorFloor = actorFloor === floor.id;

      return `
        <div class="mm-floor-card ${isCurrentFloor ? 'active' : ''} ${isAll ? 'in-view' : ''}" data-floor="${floor.id}">
          <div class="mm-card-left">
            <span class="mm-level-tag ${isActorFloor ? 'has-actor' : ''}">${floor.level}</span>
            <div class="mm-card-text">
              <span class="mm-name">${floor.name}</span>
              <span class="mm-count">${rooms.length}间</span>
            </div>
            ${isActorFloor ? `<span class="mm-actor-pin" title="当前行动者在此层">👤</span>` : ''}
          </div>
          <div class="mm-card-right">
            ${svgHtml}
          </div>
        </div>
      `;
    }).join('');

    const minimapHtml = `
      <div class="mm-head">
        <div class="mm-title">
          <span class="mm-ico">🧭</span>
          <span class="mm-label">洋馆总览</span>
        </div>
        <div class="mm-controls">
          <button class="mm-btn-all ${isAll ? 'active' : ''}" data-floor="ALL" type="button" title="查看全宅三层">全部</button>
          <button class="mm-btn-toggle" id="mm-toggle" type="button" title="折叠/展开小地图">${this.minimapCollapsed ? '▸' : '▾'}</button>
        </div>
      </div>
      <div class="mm-body">
        ${floorItems}
      </div>
    `;

    const minimapSig = hash(minimapHtml);
    if (el.dataset.sig !== minimapSig) {
      el.innerHTML = minimapHtml;
      el.dataset.sig = minimapSig;
    }

    el.querySelector('#mm-toggle')?.addEventListener('click', e => {
      e.stopPropagation();
      this.minimapCollapsed = !this.minimapCollapsed;
      if (this.latest) this.renderMinimap(this.latest);
    });
  }

  /**
   * Recent activity feed: newest event on top, grouped by kind colour so a
   * glance separates damage from movement, cards and haunt beats.
   */
  /**
   * Animate a fresh trait check. `lastRoll` persists between snapshots, so the
   * overlay dedupes on its stamp and a plain re-render never replays the roll.
   */
  private maybeAnimateRoll(snapshot: GameSnapshot): void {
    const roll = snapshot.lastRoll;
    if (!roll || !this.diceOverlay) return;

    // Animate every roll we have not shown yet; the stamp keeps a single roll from
    // replaying on each repaint.
    if (roll.stamp === this.lastAnimatedStamp) return;
    this.lastAnimatedStamp = roll.stamp;
    this.diceOverlay.show({ roll, label: this.rollLabel(roll) });
  }

  private rollLabel(roll: NonNullable<GameSnapshot['lastRoll']>): string {
    const traitZh: Record<string, string> = {
      speed: '速度',
      might: '力量',
      sanity: '神智',
      knowledge: '知识'
    };
    const trait = roll.trait ? traitZh[roll.trait] ?? roll.trait : '';
    const source = roll.label?.trim();
    if (source && trait) return `${source} · ${trait}检定`;
    if (source) return source;
    return trait ? `${trait}检定` : '检定';
  }

  private renderHistory(snapshot: GameSnapshot): void {
    const feed = this.container.querySelector('#activity-feed') as HTMLElement | null;
    if (!feed) return;
    const entries = snapshot.history ?? [];
    feed.classList.toggle('empty', entries.length === 0);
    feed.classList.toggle('collapsed', this.historyCollapsed);

    // Cheap structural signature: only repaint when the head or count moves.
    const signature = `${entries.length}|${entries[0]?.id ?? ''}|${this.historyCollapsed}|${snapshot.gameId}`;
    if (feed.dataset.signature === signature) return;
    feed.dataset.signature = signature;

    // The header is created once and then only its text changes, so the toggle
    // keeps its focus and listeners across snapshots.
    let head = feed.querySelector('#af-toggle') as HTMLButtonElement | null;
    let body = feed.querySelector('.af-body') as HTMLElement | null;
    if (!head || !body) {
      feed.innerHTML = `
        <button class="af-head" id="af-toggle" type="button" title="展开 / 收起近期记录">
          <span class="af-title">近期动态</span>
          <span class="af-count"></span>
          <span class="af-caret"></span>
        </button>
        <div class="af-body"></div>
      `;
      head = feed.querySelector('#af-toggle') as HTMLButtonElement;
      body = feed.querySelector('.af-body') as HTMLElement;
      head.addEventListener('click', () => {
        this.historyCollapsed = !this.historyCollapsed;
        if (this.latest) this.renderHistory(this.latest);
      });
    }

    const count = head.querySelector('.af-count');
    if (count) count.textContent = String(entries.length);
    const caret = head.querySelector('.af-caret');
    if (caret) caret.textContent = this.historyCollapsed ? '▸' : '▾';

    // Rows are reconciled by entry id: appending one entry creates one node and
    // leaves the rest — and therefore the reader's scroll position — alone.
    const visible = entries.slice(0, this.historyCollapsed ? 3 : 18);
    if (visible.length === 0) {
      body.innerHTML = '<div class="af-empty">尚无记录，行动后会在这里留下痕迹</div>';
    } else {
      body.querySelector('.af-empty')?.remove();
      reconcileKeyedPreservingScroll(
        body,
        visible.map(entry => ({ key: entry.id, html: this.historyRow(entry) }))
      );
    }
  }

  private historyRow(entry: UiHistoryEntry): string {
    const delta =
      typeof entry.delta === 'number' && entry.delta !== 0
        ? `<span class="af-delta ${entry.delta > 0 ? 'up' : 'down'}">${entry.delta > 0 ? '+' : ''}${entry.delta}</span>`
        : '';
    const stamp = entry.round ? `<span class="af-stamp">R${entry.round}·T${entry.turn ?? 1}</span>` : '';
    const detail = entry.detail ? `<span class="af-detail">${entry.detail}</span>` : '';
    return `
      <div class="af-row kind-${entry.kind} ${entry.critical ? 'critical' : ''}">
        <span class="af-ico">${entry.icon}</span>
        <span class="af-main">
          <span class="af-text">${entry.title}</span>
          ${detail}
        </span>
        ${delta}
        ${stamp}
      </div>
    `;
  }

  /**
   * Room dossier for the focused actor's current room: name, floor, door
   * compass, printed flavour text and who is standing in it.
   */
  private renderRoomCard(snapshot: GameSnapshot): void {
    const card = this.container.querySelector('#room-card') as HTMLElement | null;
    if (!card) return;

    const board = snapshot.board;
    const placement = snapshot.placement;

    // During room placement, the Room Dossier immediately pins to the preview room,
    // displaying its flavour text, symbol, floor, and dynamic rotating door compass!
    if (placement) {
      const floorId = String(placement.floor ?? '');
      const floorLabel = floorId === 'BASEMENT' ? '地下室' : floorId === 'UPPER' ? '二楼' : '一楼';
      const symbolBadge =
        placement.symbol === 'OMEN'
          ? '👁 预兆'
          : placement.symbol === 'ITEM'
          ? '◆ 遗物'
          : placement.symbol === 'EVENT'
          ? '✦ 事件'
          : '· 无符号';

      const connMap = new Map((placement.connections ?? []).map(c => [c.dir, c]));
      const compass = ['N', 'E', 'S', 'W']
        .map(dir => {
          const conn = connMap.get(dir);
          const cls = conn?.connected
            ? 'on connected'
            : conn?.status === 'blocked'
            ? 'blocked'
            : conn?.status === 'open'
            ? 'on open'
            : '';
          const glyph = conn?.connected ? '🔗' : conn?.status === 'open' ? '▲' : conn?.status === 'blocked' ? '✕' : dir;
          const title = conn?.connected
            ? `${conn.dirZh} ↔ ${conn.neighborRoomName}`
            : conn?.status === 'blocked'
            ? `${conn.dirZh}（面墙阻挡）`
            : conn?.status === 'open'
            ? `${conn.dirZh}（通向未探索空间）`
            : `${dir}（实墙）`;
          return `<span class="rc-door ${cls}" title="${title}">${glyph}</span>`;
        })
        .join('');

      const connectedList = (placement.connections ?? []).filter(c => c.connected);
      const connChips = connectedList.length > 0
        ? connectedList
            .map(c => `<span class="rc-chip" style="--chip:#22dd77"><i></i>${c.dirZh} ↔ ${c.neighborRoomName}</span>`)
            .join('')
        : '<span class="rc-chip" style="--chip:#e0604e"><i></i>暂未打通相邻门</span>';

      const signature = `placement|${placement.defId}|${placement.rotation}|${connectedList.length}|${placement.col}:${placement.row}`;
      if (card.dataset.signature === signature) return;
      card.dataset.signature = signature;

      card.style.display = '';
      card.innerHTML = `
        <div class="rc-head">
          <span class="rc-floor">[待定放置] ${floorLabel}</span>
          <span class="rc-angle">${placement.rotation * 90}°</span>
        </div>
        <div class="rc-title">${placement.name}</div>
        ${placement.en ? `<div class="rc-en">${placement.en}</div>` : ''}
        <div class="rc-meta">
          <div class="rc-compass">${compass}</div>
          <div class="rc-symbol">${symbolBadge}</div>
        </div>
        <p class="rc-text">${placement.text ?? '探索发现的新房间，请选择朝向确认放置。'}</p>
        <div class="rc-occupants">${connChips}</div>
      `;
      return;
    }

    const focusId = snapshot.focus[0] ?? snapshot.viewer;
    const actor = board.players[focusId];
    const actorRoomId = String(actor?.customProps?.currentRoomId ?? '');

    // Following the active actor is the default; a explicit room click pins the
    // dossier until the actor moves somewhere else.
    if (actorRoomId !== this.lastActorRoomId) {
      this.lastActorRoomId = actorRoomId;
      this.pinnedRoomId = undefined;
    }
    const pinnedNode = this.pinnedRoomId ? board.mapGraph.nodes[this.pinnedRoomId] : undefined;
    const roomId = pinnedNode && pinnedNode.type === 'ROOM' ? this.pinnedRoomId! : actorRoomId;
    const node = roomId ? board.mapGraph.nodes[roomId] : undefined;

    if (!node || node.type !== 'ROOM') {
      card.style.display = 'none';
      card.dataset.signature = '';
      return;
    }

    const props = (node.props ?? {}) as Record<string, unknown>;
    const doors = Array.isArray(props.doors) ? (props.doors as string[]) : [];
    const floorId = String(props.floor ?? '');
    const floorLabel = floorId === 'BASEMENT' ? '地下室' : floorId === 'UPPER' ? '二楼' : '一楼';
    const occupants = Object.values(board.players).filter(
      p => p.alive && !p.customProps?.banished && p.customProps?.currentRoomId === roomId
    );
    const monsters = Object.values(board.entities ?? {}).filter(entity => {
      const custom = entity?.components?.custom as Record<string, unknown> | undefined;
      return entity.type === 'MEEPLE' && !!custom?.monster && custom?.roomId === roomId && !custom?.destroyed;
    });
    const loot = Object.values(board.entities ?? {}).filter(entity => {
      const custom = entity?.components?.custom as Record<string, unknown> | undefined;
      return entity.zoneId === `zone_room_${roomId}` && custom?.cardType === 'ITEM';
    });

    const signature = `${roomId}|${doors.join('')}|${occupants.map(p => p.id).join(',')}|${monsters.length}|${loot.length}`;
    if (card.dataset.signature === signature) return;
    card.dataset.signature = signature;

    const compass = ['N', 'E', 'S', 'W']
      .map(dir => `<span class="rc-door ${doors.includes(dir) ? 'on' : ''}">${dir}</span>`)
      .join('');

    const ppl = occupants
      .map(p => {
        const role = p.role === 'TRAITOR' ? '叛徒' : p.role === 'HERO' ? '英雄' : '探索者';
        return `<span class="rc-chip" style="--chip:${escHtml(p.color)}"><i></i>${escHtml(p.name)} · ${role}</span>`;
      })
      .join('');
    const mobs = monsters
      .map(m => `<span class="rc-chip monster"><i></i>${String((m.components?.custom as Record<string, unknown>)?.name ?? '怪物')}</span>`)
      .join('');
    const items = loot.length ? `<span class="rc-chip loot"><i></i>遗物 ×${loot.length}</span>` : '';

    card.style.display = '';
    const dossierHtml = `
      <div class="rc-head">
        <span class="rc-floor">${floorLabel}</span>
        <button class="rc-focus" id="rc-focus" title="镜头聚焦该房间">◎</button>
      </div>
      <div class="rc-title">${String(props.name ?? '房间')}</div>
      <div class="rc-en">${String(props.en ?? '')}</div>
      <div class="rc-meta">
        <div class="rc-compass">${compass}</div>
        <div class="rc-symbol">${props.symbol === 'OMEN' ? '👁 预兆' : props.symbol === 'ITEM' ? '◆ 遗物' : props.symbol === 'EVENT' ? '✦ 事件' : '· 无事'}</div>
      </div>
      <p class="rc-text">${String(props.text ?? '')}</p>
      <div class="rc-occupants">${
        ppl || mobs || items ? `${ppl}${mobs}${items}` : '<span class="rc-empty">空无一人</span>'
      }</div>
    `;

    // Guarded paint: the dossier is small and changes rarely, so skipping the
    // rebuild when nothing moved removes a per-snapshot cost without keying
    // every row inside it.
    const dossierSig = hash(dossierHtml);
    if (card.dataset.dossierSig !== dossierSig) {
      card.innerHTML = dossierHtml;
      card.dataset.dossierSig = dossierSig;
    }

    card.querySelector('#rc-focus')?.addEventListener('click', () => {
      if (this.ports.focusRoom) this.ports.focusRoom(roomId);
      this.openRoomCardWindow(roomId, snapshot);
    });
  }

  /**
   * The room dossier as a floating window, matching what the placement preview
   * shows. Triggered from the room card's focus button.
   */
  private openRoomCardWindow(roomId: string, snapshot: GameSnapshot): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer) return;

    const node = snapshot.board.mapGraph.nodes[roomId];
    if (!node || node.type !== 'ROOM') return;
    const props = (node.props ?? {}) as Record<string, unknown>;
    const doors = Array.isArray(props.doors) ? (props.doors as string[]) : [];

    const floorLabel = String(props.floor ?? '') === 'BASEMENT' ? '地下室' : String(props.floor ?? '') === 'UPPER' ? '二楼' : '一楼';
    const compass = ['N', 'E', 'S', 'W']
      .map(dir => `<span class="rc-door ${doors.includes(dir) ? 'on' : ''}">${dir}</span>`)
      .join('');

    const occupants = Object.values(snapshot.board.players).filter(
      p => p.alive && !p.customProps?.banished && p.customProps?.currentRoomId === roomId
    );
    const monsters = Object.values(snapshot.board.entities ?? {}).filter(entity => {
      const custom = entity?.components?.custom as Record<string, unknown> | undefined;
      return entity.type === 'MEEPLE' && !!custom?.monster && custom?.roomId === roomId && !custom?.destroyed;
    });
    const loot = Object.values(snapshot.board.entities ?? {}).filter(entity => {
      return entity.zoneId === `zone_room_${roomId}` && entity.components?.custom?.cardType === 'ITEM';
    });

    const chips =
      occupants.map(p => `<span class="rc-chip" style="--chip:${p.color}"><i></i>${p.name}</span>`).join('') +
      monsters
        .map(m => `<span class="rc-chip monster"><i></i>${String((m.components?.custom as Record<string, unknown>)?.name ?? '怪物')}</span>`)
        .join('') +
      (loot.length ? `<span class="rc-chip loot"><i></i>遗物 ×${loot.length}</span>` : '');

    layer.innerHTML = `
      <div class="payload-backdrop"></div>
      <div class="payload-card room-card-window">
        <header class="rc-head">
          <span class="rc-floor">${floorLabel}</span>
          <button type="button" class="pf-btn" id="rcw-close">关闭</button>
        </header>
        <div class="rc-title">${String(props.name ?? '房间')}</div>
        <div class="rc-en">${String(props.en ?? '')}</div>
        <div class="rc-meta">
          <div class="rc-compass">${compass}</div>
          <div class="rc-symbol">${props.symbol === 'OMEN' ? '👁 预兆' : props.symbol === 'ITEM' ? '◆ 遗物' : props.symbol === 'EVENT' ? '✦ 事件' : '· 无符号'}</div>
        </div>
        <p class="rc-text">${String(props.text ?? '')}</p>
        <div class="rc-occupants">${chips || '<span class="rc-empty">空无一人</span>'}</div>
      </div>
    `;
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.innerHTML = '';
    };
    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#rcw-close')?.addEventListener('click', close);
  }

  private renderViewerSelect(snapshot: GameSnapshot): void {
    const select = this.container.querySelector('#viewer-select') as HTMLSelectElement | null;
    if (!select) return;

    const signature = snapshot.viewers.map(v => `${v.id}:${v.name}`).join('|');
    if (select.dataset.signature !== signature) {
      select.innerHTML = snapshot.viewers
        .map(viewer => `<option value="${viewer.id}">${viewer.name}</option>`)
        .join('');
      select.dataset.signature = signature;
    }
    select.value = snapshot.viewer;
  }

  /**
   * Scenario picker: only shown when the current game actually ships
   * scenarios, so the plain fixtures keep a clean top bar.
   */
  private renderScenarioSelect(snapshot: GameSnapshot): void {
    const host = this.container.querySelector('#scenario-switch') as HTMLElement | null;
    const select = this.container.querySelector('#scenario-select') as HTMLSelectElement | null;
    if (!host || !select) return;

    const options = snapshot.scenarios ?? [];
    if (options.length === 0) {
      host.style.display = 'none';
      return;
    }
    host.style.display = '';

    const signature = options.map(option => `${option.id}:${option.description}`).join('|');
    if (select.dataset.signature !== signature) {
      select.innerHTML = options
        .map(option => `<option value="${option.id}">${option.description}</option>`)
        .join('');
      select.dataset.signature = signature;
      // The description doubles as the option label, so keep the control compact.
      select.title = options.find(option => option.selected)?.description ?? '';
    }
    const selected = options.find(option => option.selected)?.id;
    if (selected) select.value = selected;
  }


  private renderPlayers(snapshot: GameSnapshot): void {
    const rail = this.container.querySelector('#player-rail') as HTMLElement | null;
    if (!rail) return;

    const playerCards = snapshot.players
      .map(player => {
        const hp = player.hp
          ? `<div class="hp-track">${Array.from({ length: player.hp.max })
              .map((_, index) => `<span class="hp-seg ${index < player.hp!.current ? 'on' : ''}"></span>`)
              .join('')}</div>`
          : '';

        // Betrayal traits carry a printed 0..8 track: draw a character-sheet
        // style ladder with the start value ringed instead of a flat pill.
        const ladder = player.pips.filter(pip => typeof pip.max === 'number' && pip.max > 0);
        const plainPips = player.pips.filter(pip => !(typeof pip.max === 'number' && pip.max > 0));

        const traitRows = ladder.length
          ? `<div class="pc-traits">${ladder
              .map(pip => {
                const max = pip.max ?? 8;
                const value = Number(pip.value);
                const start = Number(pip.start ?? -1);
                const segs = Array.from({ length: max })
                  .map((_, index) => {
                    const on = Number.isFinite(value) && index < value ? 'on' : '';
                    const mark = index === start ? 'start' : '';
                    return `<span class="trait-seg ${on} ${mark}"></span>`;
                  })
                  .join('');
                const bonus = Number(pip.modifier ?? 0);
                const bonusChip =
                  bonus === 0
                    ? ''
                    : `<span class="trait-mod ${bonus > 0 ? 'up' : 'down'}" title="携带物品加成">${bonus > 0 ? '+' : ''}${bonus}</span>`;
                return `<div class="trait-row ${player.alive ? '' : 'dead'}" style="--trait-color:${pip.color}" title="${pip.label}">
                  <span class="trait-key">${pip.short ?? ''}</span>
                  <span class="trait-track">${segs}</span>
                  <span class="trait-val">${pip.value}</span>${bonusChip}
                </div>`;
              })
              .join('')}</div>`
          : '';

        const pips =
          plainPips.length > 0
            ? `<div class="pc-pips">${plainPips
                .map(
                  pip =>
                    `<span class="pip" title="${pip.label}">${
                      pip.icon ? `<span>${pip.icon}</span>` : ''
                    }${pip.short ? `<span class="pip-k">${pip.short}</span>` : ''}<i style="background:${pip.color}"></i>${pip.value}</span>`
                )
                .join('')}</div>`
            : '';

        const stats = player.stats
          .map(stat => `<div class="pc-row"><span class="k">${stat.label}</span><span class="v">${stat.value}</span></div>`)
          .join('');

        const effectChips = (player.effects ?? [])
          .map(
            effect =>
              `<span class="pc-effect ${effect.tone ?? 'neutral'}" title="${escHtml(effect.detail ?? effect.label)}">${escHtml(effect.label)}</span>`
          )
          .join('');
        const effectRow = effectChips
          ? `<div class="pc-effects">${effectChips}<button class="pc-effects-more" data-effect-open="${player.id}" title="查看全部状态">${(player.effects ?? []).length}</button></div>`
          : '';

        const card = `
          <article class="pc ${player.isFocus ? 'active' : ''} ${player.alive ? '' : 'dead'}" data-player-id="${player.id}" style="--pc-color:${player.color}">
            <div class="pc-head">
              <div class="pc-avatar"><span class="pc-online${this.onlinePlayerIds.has(player.id) ? ' on' : ''}" title="在线状态"></span>${player.avatarUrl ? `<img src="${escHtml(player.avatarUrl)}" alt="" loading="lazy" />` : player.avatar}</div>
              <div class="pc-id">
                <div class="pc-name">${escHtml(player.name)}</div>
                <div class="pc-tags">
                  ${player.roleLabel ? `<span class="pc-role ${player.roleClass ?? ''}">${player.roleLabel}</span>` : ''}
                  ${player.alive ? '' : '<span class="pc-role dead-chip" title="角色已退场，不再参与行动">☠ 已阵亡</span>'}
                  ${player.isFocus ? `<span class="pc-turn"><span class="dot"></span>决策中</span>` : ''}
                </div>
              </div>
              <div class="pc-score"><b>${player.score}</b><span>${player.scoreLabel}</span></div>
            </div>
            ${effectRow}
            <div class="pc-body">
              ${hp}
              ${traitRows}
              ${pips}
              ${stats}
            </div>
          </article>
        `;
        return { key: player.id, html: card };
      });

    const npcCards = (snapshot.npcs ?? [])
      .map(npc => {
        const stats = npc.stats
          .map(stat => `<div class="pc-row"><span class="k">${stat.label}</span><span class="v">${stat.value}</span></div>`)
          .join('');
        const card = `
          <article class="pc npc ${npc.isFocus ? 'active' : ''}" style="--pc-color:${npc.color}">
            <div class="pc-head">
              <div class="pc-avatar">${npc.avatar}</div>
              <div class="pc-id">
                <div class="pc-name">${npc.name}</div>
                <div class="pc-tags">
                  <span class="pc-role npc">NPC</span>
                  ${npc.isFocus ? `<span class="pc-turn"><span class="dot"></span>决策中</span>` : ''}
                </div>
              </div>
            </div>
            <div class="pc-body">${stats}</div>
          </article>
        `;
        return { key: npc.id, html: card };
      });

    // Reconcile instead of rebuilding: a player card holds focus and hover, and
    // the rail holds the scroll position.
    reconcileKeyed(rail, [...playerCards, ...npcCards]);
  }

  private renderDock(snapshot: GameSnapshot): void {
    const dock = this.container.querySelector('#action-dock') as HTMLElement | null;
    if (!dock) return;

    const alert = snapshot.decision
      ? `
        <div class="alert-strip decision">
          <div class="al-ico">🔒</div>
          <div class="al-body">
            <div class="al-title">${snapshot.decision.secret ? '秘密决策窗口' : '决策窗口'} · ${snapshot.decision.title}</div>
            <div class="al-desc">${snapshot.decision.description || snapshot.decision.policyLabel}</div>
          </div>
          <div class="al-wait">
            ${
              snapshot.decision.remaining !== undefined
                ? `<span class="chip timer">⏱ ${snapshot.decision.remaining} ticks</span>`
                : ''
            }
            ${snapshot.decision.participants
              .map(
                participant =>
                  `<span class="chip ${participant.committed ? 'done' : 'wait'}"><span class="c-dot"></span>${
                    escHtml(participant.name)
                  }${participant.committed ? ' · 已锁定' : ' · 待提交'}</span>`
              )
              .join('')}
          </div>
        </div>
      `
      : snapshot.stackDepth > 0 && snapshot.stack[0]?.window
      ? `
        <div class="alert-strip">
          <div class="al-ico">⚡</div>
          <div class="al-body">
            <div class="al-title">响应窗口开启 · ${snapshot.stack[0].title}</div>
            <div class="al-desc">${snapshot.stack[0].description}</div>
          </div>
          <div class="al-wait">
            ${
              snapshot.stack[0].window.remaining !== undefined
                ? `<span class="chip timer">⏱ ${snapshot.stack[0].window.remaining} ticks</span>`
                : ''
            }
            ${snapshot.stack[0].window.eligible
              .map(
                player =>
                  `<span class="chip ${player.pending ? 'wait' : 'done'}"><span class="c-dot"></span>${escHtml(player.name)}</span>`
              )
              .join('')}
          </div>
        </div>
      `
      : '';

    const total = snapshot.actions.length;
    const buttons = snapshot.actions
      .map((action, index) => {
        const mid = (total - 1) / 2;
        const offset = index - mid;
        const tone = action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : '';
        return `
        <button class="act ${tone}"
                data-action-id="${action.id}"
                data-fan-label="${action.label}"
                data-fan-hint="${action.hint}"
                style="--i:${index};--off:${offset.toFixed(2)};--abs:${Math.abs(offset).toFixed(2)}"
                title="${action.label}">
          <span class="act-ico">${action.icon}</span>
          <span class="act-key">${index + 1}</span>
        </button>
      `;
      })
      .join('');

    const isAll = this.selectedFloor === 'ALL';
    const floorTabs = snapshot.spatial?.floors?.length
      ? `<div class="floor-tabs">
          <button class="floor-tab ${isAll ? 'active' : ''}" data-floor="ALL">全部</button>
          ${snapshot.spatial.floors
            .map(
              floor =>
                `<button class="floor-tab ${this.selectedFloor === floor.id ? 'active' : ''}" data-floor="${floor.id}">${floor.name}</button>`
            )
            .join('')}
        </div>`
      : '';

    const placement = snapshot.placement;
    const placementPanel = placement
      ? (() => {
          const connectedList = (placement.connections ?? []).filter(c => c.connected);
          const openDoors = (placement.connections ?? []).filter(c => c.status === 'open');
          const blockedDoors = (placement.connections ?? []).filter(c => c.status === 'blocked');

          const symbolBadge =
            placement.symbol === 'OMEN'
              ? '<span class="pp-sym omen">👁 预兆</span>'
              : placement.symbol === 'ITEM'
              ? '<span class="pp-sym item">◆ 遗物</span>'
              : placement.symbol === 'EVENT'
              ? '<span class="pp-sym event">✦ 事件</span>'
              : '';

          const connHtml =
            connectedList.length > 0
              ? `<div class="pp-conn ok">🔗 已打通 ${connectedList.length} 门：${connectedList
                  .map(c => `<b>${c.dirZh}</b> ↔ ${c.neighborRoomName}`)
                  .join('，')}</div>`
              : '<div class="pp-conn warn">⚠️ 当前朝向尚未与任何相邻门打通</div>';

          const openHtml =
            openDoors.length > 0
              ? `<div class="pp-conn open">🚪 敞开通路：${openDoors.map(c => c.dirZh).join('、')}（通向未探索空间）</div>`
              : '';

          const blockedHtml =
            blockedDoors.length > 0
              ? `<div class="pp-conn blocked">⛔ 贴墙截断：${blockedDoors.map(c => c.dirZh).join('、')}（直对邻室实墙）</div>`
              : '';

          return `
            <div class="placement-panel">
              <div class="placement-preview">
                <div class="pp-header">
                  <span class="pp-ico">🧭</span>
                  <span class="pp-name">${placement.name}</span>
                  ${placement.en ? `<span class="pp-en">${placement.en}</span>` : ''}
                  <span class="pp-angle">${placement.rotation * 90}°</span>
                  ${symbolBadge}
                </div>
                <div class="pp-connections">
                  ${connHtml}
                  ${openHtml}
                  ${blockedHtml}
                </div>
                <div class="pp-hint">合法朝向 ${placement.rotations.length} 个（${placement.rotations
                  .map(rotation => `${rotation * 90}°`)
                  .join(' / ')}）；点击3D铜环或按钮旋转，确认后落板块进入</div>
              </div>
              <button class="act primary placement-btn" data-place-rotate>
                <span class="act-ico">↻</span>
                <span class="act-txt"><span class="act-label">旋转房间</span><span class="act-hint">切换下一个合法朝向</span></span>
              </button>
              <button class="act primary placement-btn" data-place-confirm>
                <span class="act-ico">✔</span>
                <span class="act-txt"><span class="act-label">确认放置</span><span class="act-hint">按当前朝向落板块并进入房间</span></span>
              </button>
            </div>
          `;
        })()
      : '';

    // ---- skeleton, created once ---------------------------------------
    // The dock used to be rebuilt wholesale on every snapshot, which replaced
    // the fan cards mid-gesture and dropped their hover state. The skeleton and
    // its delegated listeners now survive; each render only patches what moved.
    if (!dock.querySelector('.dock-shell')) {
      dock.innerHTML = `
        <button class="dock-handle" data-dock-toggle aria-expanded="false">
          <span class="dh-grip"></span>
          <span class="dh-label"></span>
          <span class="dh-count"></span>
        </button>
        <div data-slot="alert"></div>
        <div data-slot="mission"></div>
        <div data-slot="floors"></div>
        <div class="dock-shell">
          <div class="dock-bar">
            <span class="dock-phase"><span class="ph-dot"></span><span data-bar="phase"></span></span>
            <span class="dock-who">行动者 <b data-bar="actor"></b></span>
            <span class="dock-meta">
              <span class="m" data-bar="round"></span>
              <span class="m" data-bar="stack"></span>
              <span class="m" data-bar="decisions"></span>
              <span class="m" data-bar="legal"></span>
            </span>
          </div>
          <div class="dock-actions" data-slot="actions"></div>
        </div>
      `;
      this.bindDockEvents(dock);
      this.bindPlayerRail();
    }

    const slot = (name: string) => dock.querySelector(`[data-slot="${name}"]`) as HTMLElement | null;
    const setText = (selector: string, text: string) => {
      const el = dock.querySelector(selector) as HTMLElement | null;
      if (el && el.textContent !== text) el.textContent = text;
    };
    // Signature-guarded paint: these slots have no persistent state, so a full
    // innerHTML is fine as long as it only happens when the content changed.
    const setHtml = (el: HTMLElement | null, html: string) => {
      if (!el) return;
      const sig = hash(html);
      if (el.dataset.sig === sig) return;
      el.innerHTML = html;
      el.dataset.sig = sig;
    };

    dock.setAttribute('data-dock', this.dockOpen ? 'open' : 'closed');
    const handle = dock.querySelector('.dock-handle') as HTMLElement | null;
    if (handle) {
      handle.setAttribute('aria-expanded', this.dockOpen ? 'true' : 'false');
      const label = handle.querySelector('.dh-label');
      const labelText = this.dockOpen ? '收起动作' : '展开动作';
      if (label && label.textContent !== labelText) label.textContent = labelText;
      const count = handle.querySelector('.dh-count');
      const countText = `${snapshot.actions.length} 个可选`;
      if (count && count.textContent !== countText) count.textContent = countText;
    }

    setHtml(slot('alert'), alert);
    setHtml(
      slot('mission'),
      snapshot.mission
        ? `<div class="alert-strip mission">
             <div class="al-ico">🎯</div>
             <div class="al-body">
               <div class="al-title">当前目标</div>
               <div class="al-desc">${snapshot.mission}</div>
             </div>
           </div>`
        : ''
    );
    setHtml(slot('floors'), floorTabs);

    setText('[data-bar="phase"]', snapshot.phaseLabel);
    setText('[data-bar="actor"]', snapshot.actorName);
    setText('[data-bar="round"]', `R${snapshot.round}·T${snapshot.turn}`);
    setText('[data-bar="stack"]', `Σ ${snapshot.stackDepth}`);
    setText('[data-bar="decisions"]', `Δ ${snapshot.openDecisions}`);
    setText('[data-bar="legal"]', `|ℒ| ${snapshot.legalCount}`);

    // ---- actions slot -------------------------------------------------
    const actionsSlot = slot('actions');
    if (actionsSlot) {
      const mode = placement
        ? 'placement'
        : snapshot.actions.length > 0
        ? 'fan'
        : snapshot.gameOver
        ? 'over'
        : 'idle';

      // Rebuilding is only correct when the dock changes shape.
      if (actionsSlot.dataset.mode !== mode) {
        actionsSlot.dataset.mode = mode;
        actionsSlot.removeAttribute('data-sig');
        actionsSlot.innerHTML =
          mode === 'fan'
            ? `<div class="fan-hint" data-fan-hint><span class="fh-label">悬停查看动作</span><span class="fh-detail">点击牌面执行该动作 · 数字键直接执行</span></div><div class="dock-fan" data-fan></div>`
            : '';
      }

      if (mode === 'placement') {
        setHtml(actionsSlot, placementPanel);
      } else if (mode === 'over') {
        setHtml(
          actionsSlot,
          `<div class="empty-hint"><span class="e-ico">🏁</span><span>对局已结束${
            snapshot.winnerLabel ? ` — 胜者：${snapshot.winnerLabel}` : ''
          }${snapshot.winnerReason ? ` · ${snapshot.winnerReason}` : ''}</span></div>`
        );
      } else if (mode === 'idle') {
        setHtml(
          actionsSlot,
          '<div class="empty-hint"><span class="e-ico">◌</span><span>暂无可执行的合法动作 — 等待其他玩家，或正在结算响应栈。</span></div>'
        );
      } else {
        // Fan mode: reconcile the cards by action id so hover survives a repaint.
        const fan = actionsSlot.querySelector('[data-fan]') as HTMLElement | null;
        if (fan) {
          const total = snapshot.actions.length;
          const mid = (total - 1) / 2;
          reconcileKeyed(
            fan,
            snapshot.actions.map((action, index) => {
              const offset = index - mid;
              const tone =
                action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : '';
              return {
                key: action.id,
                html: `<button class="act ${tone}"
                  data-action-id="${action.id}"
                  data-fan-label="${action.label}"
                  data-fan-hint="${action.hint}"
                  style="--i:${index};--off:${offset.toFixed(2)};--abs:${Math.abs(offset).toFixed(2)}"
                  title="${action.label}">
                  <span class="act-ico">${action.icon}</span>
                  <span class="act-key">${index + 1}</span>
                </button>`
              };
            })
          );
          this.layoutActionFan(fan);
        }
      }
    }
  }

  /**
   * Re-position the action cards as a fisheye row.
   *
   * The cards keep their size and the gaps carry the fisheye: `lockCardWidth`
   * plus a low context ratio stacks the far end almost on top of itself, which is
   * what lets an unbounded number of actions stay inside one row.
   */
  private layoutActionFan(fan: HTMLElement): void {
    const cards = [...fan.querySelectorAll<HTMLElement>('.act')];
    if (cards.length === 0) return;

    const cardWidth = cards[0].offsetWidth || 76;
    if (cardWidth <= 0) return;

    // Absolutely positioned children are laid out against the padding box, while
    // clientWidth includes the padding, so the row is inset by it. The extra
    // hover inset keeps a scaled edge card from poking out of the container.
    const style = getComputedStyle(fan);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const hoverInset = Math.ceil(cardWidth * 0.07) + 1;
    const containerWidth = fan.clientWidth - padLeft - padRight - hoverInset * 2;
    if (containerWidth <= 0) return;

    const hoverIndex = cards.findIndex(card => card.matches(':hover'));
    const layout = handLayout({
      count: cards.length,
      containerWidth,
      cardWidth,
      focusX: this.fanFocusX,
      focusStrength: this.fanFocusStrength,
      hoverIndex: hoverIndex >= 0 ? hoverIndex : null,
      lockCardWidth: true,
      focusPitchRatio: 1.15,
      contextPitchRatio: 0.1
    });

    // Gaps are capped at one card width, so a short row can be narrower than the
    // container; centre it rather than leaving a lopsided tail of empty space.
    const span = layout.span || containerWidth;
    const centreOffset = padLeft + hoverInset + Math.max(0, (containerWidth - span) / 2);

    layout.cards.forEach((card, index) => {
      const el = cards[index];
      if (!el) return;
      // The card is left-anchored at 0, so shift by centre minus half a card.
      el.style.setProperty('--fan-x', `${(card.x - card.width / 2 + centreOffset).toFixed(1)}px`);
      el.style.setProperty('--fan-scale', card.scale.toFixed(3));
      el.style.setProperty('--fan-lift', card.lift.toFixed(2));
      el.style.zIndex = String(card.z);
    });
  }

  /**
   * Dock listeners, bound once with the skeleton.
   *
   * Delegation rather than per-element binding: the fan cards are reconciled,
   * so re-binding on every render would leak listeners onto removed nodes and
   * make hover state impossible to keep.
   */
  /**
   * Player rail: opening the effect list for one character.
   *
   * Bound once and delegated, because the rail is reconciled on every snapshot.
   */
  private bindPlayerRail(): void {
    const rail = this.container.querySelector('#player-rail') as HTMLElement | null;
    if (!rail) return;
    rail.addEventListener('click', event => {
      const target = event.target as HTMLElement | null;
      const trigger = target?.closest('[data-effect-open]') as HTMLElement | null;
      const card = target?.closest('.pc[data-player-id]') as HTMLElement | null;
      const playerId = trigger?.dataset.effectOpen ?? card?.dataset.playerId;
      if (!playerId) return;
      const player = this.lastSnapshot?.players.find(entry => entry.id === playerId);
      if (!player) return;
      if (player.effects && player.effects.length > 0) this.openEffectsWindow(player);
    });
  }

  /** Floating list of the character's current buffs and debuffs. */
  private openEffectsWindow(player: UiPlayer): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer) return;

    const rows = (player.effects ?? [])
      .map(
        effect => `<li class="fx-row ${effect.tone ?? 'neutral'}">
          <span class="fx-name">${escHtml(effect.label)}</span>
          <span class="fx-detail">${escHtml(effect.detail ?? '')}</span>
        </li>`
      )
      .join('');

    layer.innerHTML = `
      <div class="payload-backdrop"></div>
      <div class="payload-card effects-window">
        <header class="rc-head">
          <span class="rc-floor">当前状态</span>
          <button type="button" class="pf-btn" id="fx-close">关闭</button>
        </header>
        <div class="rc-title">${escHtml(player.name)}</div>
        <ul class="fx-list">${rows || '<li class="fx-row neutral"><span class="fx-name">无</span></li>'}</ul>
      </div>
    `;
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.innerHTML = '';
    };
    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#fx-close')?.addEventListener('click', close);
  }

  private bindDockEvents(dock: HTMLElement): void {
    const REST_HINT =
      '<span class="fh-label">悬停查看动作</span><span class="fh-detail">点击牌面执行该动作 · 数字键直接执行</span>';

    // The action row is a fisheye: the pointer position decides which gaps open
    // up. Delegated on the dock so it survives every reconcile.
    const fanPointerBound = (event: PointerEvent) => {
      const fan = dock.querySelector('[data-fan]') as HTMLElement | null;
      if (!fan) return;
      const rect = fan.getBoundingClientRect();
      if (rect.width <= 0) return;
      this.fanFocusX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      this.fanFocusStrength = 1;
      this.layoutActionFan(fan);
    };
    dock.addEventListener('pointermove', fanPointerBound);
    dock.addEventListener('pointerleave', () => {
      const fan = dock.querySelector('[data-fan]') as HTMLElement | null;
      if (!fan) return;
      this.fanFocusStrength = 0;
      this.layoutActionFan(fan);
    });
    window.addEventListener('resize', () => {
      const fan = dock.querySelector('[data-fan]') as HTMLElement | null;
      if (fan) this.layoutActionFan(fan);
    });
    dock.addEventListener('click', event => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (target.closest('[data-dock-toggle]')) {
        this.dockOpen = !this.dockOpen;
        dock.setAttribute('data-dock', this.dockOpen ? 'open' : 'closed');
        const handle = dock.querySelector('.dock-handle');
        if (handle) {
          handle.setAttribute('aria-expanded', this.dockOpen ? 'true' : 'false');
          const label = handle.querySelector('.dh-label');
          if (label) label.textContent = this.dockOpen ? '收起动作' : '展开动作';
        }
        return;
      }

      if (target.closest('[data-place-rotate]')) {
        this.presenter.rotatePlacement(1);
        return;
      }

      if (target.closest('[data-place-confirm]')) {
        const result = this.presenter.confirmPlacement();
        if (!result.ok) this.pushToast('⚠️', result.error ?? '放置被拒绝');
        return;
      }

      const card = target.closest('[data-action-id]') as HTMLElement | null;
      const id = card?.dataset.actionId;
      if (id) {
        const action = this.latest?.actions.find(candidate => candidate.id === id);
        if (action) this.openActionDetail(action);
      }
    });

    const bar = () => dock.querySelector('[data-fan-hint]') as HTMLElement | null;
    const showHint = (card: HTMLElement) => {
      const el = bar();
      if (!el) return;
      el.innerHTML =
        `<span class="fh-label">${card.dataset.fanLabel ?? ''}</span>` +
        `<span class="fh-detail">${card.dataset.fanHint ?? ''}</span>`;
      el.classList.add('active');
    };
    const hideHint = () => {
      const el = bar();
      if (!el) return;
      el.innerHTML = REST_HINT;
      el.classList.remove('active');
    };
    // relatedTarget checks keep the hint from flickering as the pointer crosses
    // the card's inner spans.
    dock.addEventListener('mouseover', event => {
      const card = (event.target as HTMLElement | null)?.closest('.dock-fan .act') as HTMLElement | null;
      if (!card) return;
      if ((event.relatedTarget as HTMLElement | null)?.closest?.('.dock-fan .act') === card) return;
      showHint(card);
    });
    dock.addEventListener('mouseout', event => {
      const card = (event.target as HTMLElement | null)?.closest('.dock-fan .act') as HTMLElement | null;
      if (!card) return;
      if ((event.relatedTarget as HTMLElement | null)?.closest?.('.dock-fan .act') === card) return;
      hideHint();
    });
    dock.addEventListener('focusin', event => {
      const card = (event.target as HTMLElement | null)?.closest('.dock-fan .act') as HTMLElement | null;
      if (card) showHint(card);
    });
    dock.addEventListener('focusout', () => hideHint());
  }

  /**
   * Detail card for one action: full label + hint, with the execute button.
   * Reuses the payload layer so the two modals never stack.
   */
  private openActionDetail(action: UiAction): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer) return;

    const needsInput = !!(action.fields?.length || action.selection);
    const toneClass = action.tone === 'primary' ? 'primary' : action.tone === 'danger' ? 'danger' : '';

    layer.innerHTML = `
      <div class="payload-backdrop"></div>
      <div class="payload-card action-detail ${toneClass}">
        <header class="pf-head">
          <span class="pf-ico">${action.icon}</span>
          <div>
            <div class="pf-title">${action.label}</div>
            <div class="pf-hint">${action.hint}</div>
          </div>
        </header>
        <div class="pf-body">
          <div class="ad-row"><span class="ad-k">动作</span><span class="ad-v">${action.actionType ?? action.id}</span></div>
          ${
            action.highlightIds?.length
              ? `<div class="ad-row"><span class="ad-k">可选目标</span><span class="ad-v">${action.highlightIds.length} 处</span></div>`
              : ''
          }
          ${
            needsInput
              ? `<div class="ad-note">该动作需要补充参数，执行时会打开选择面板。</div>`
              : `<div class="ad-note">该动作无需额外参数，点击执行立即生效。</div>`
          }
        </div>
        <footer class="pf-foot">
          <button type="button" class="pf-btn" id="ad-close">关闭</button>
          <button type="button" class="pf-btn primary" id="ad-run">执行</button>
        </footer>
      </div>
    `;
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.innerHTML = '';
    };

    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#ad-close')?.addEventListener('click', close);
    layer.querySelector('#ad-run')?.addEventListener('click', () => {
      close();
      this.runAction(action);
    });
  }

  /** Execute an action exactly as the dock/keyboard paths do. */
  private runAction(action: UiAction): void {
    if (action.fields?.length || action.selection) {
      this.openPayloadForm(action);
      return;
    }

    if (action.highlightIds) this.ports.highlightBoard(action.highlightIds);
    else this.ports.highlightBoard(null);

    if (action.placementEntityId) {
      const result = this.presenter.armPlacement(action.id);
      if (!result.ok) this.pushToast('⚠️', result.error ?? '无法进入放置模式');
      return;
    }
    this.performAction(action.id);
  }
}
