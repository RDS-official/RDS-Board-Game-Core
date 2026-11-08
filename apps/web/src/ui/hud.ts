import { escapeHtml } from '../htmlEscape';
import confetti from 'canvas-confetti';
import { cardArtSvg } from './cardArt';
import { detailTone } from './detailView';
import { OverlayArbiter, OverlayEntry, OverlayState } from './overlay';
import { deriveActionCard, executionRoute, isSimpleCard } from './actionCards';
import { badgeFor } from './actionHand';
import { iconHtml } from './actionHandHtml';
import { CardHand, type HandCardItem } from './cardHand/cardHand';
import { type Point, rectPolygon } from './cardHand/polygon';
import { RadialPickerOverlay } from './radialPickerOverlay';
import { SHORTCUT_HINT_KEY, shouldShowShortcutHint } from './keymap';
import { shortcutHelpHtml } from './shortcutHelp';
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
  UiDetailView,
  UiHistoryEntry,
  UiNotice,
  UiObserver,
  UiPokerRanking,
  UiTraitChange,
  UiPlayer
} from '@rds/app/contracts';
import { html, raw, setHtml } from './dom/html';

/**
 * HTML 转义：玩家可控文本（昵称/头像 URL/参与者名）进入 innerHTML 前必须经过这里。
 * 来源：昵称可携带 `<svg/onload=...>` 这类载荷（存储型 XSS）。
 */
const escHtml = (v: unknown) => escapeHtml(v);

/**
 * 操作栏抖动排查的一行记录。
 *
 * `ev` 说明这一次到底是哪一类动作：`render` 快照重绘、`shape` 动作区整块换形、
 * `cards` 卡片节点被替换/移动、`layout` 重新算了一次鱼眼位置。抖动时导出这串
 * 事件就能看出是「DOM 一直被重建」还是「DOM 没动」。
 */
interface DockTraceEntry {
  /** performance.now()（毫秒）。 */
  t: number;
  ev: 'render' | 'shape' | 'cards' | 'layout';
  n?: number;
  mode?: string;
  open?: boolean;
  cw?: number;
  span?: number;
  fx?: number;
  fs?: number;
  changed?: boolean;
}

/**
 * Minimum height of one player card in the desktop fisheye rail, in px. Cards
 * size to their content when stacked; the fisheye only needs a uniform floor so
 * a compressed stack still shows the head and one body row.
 */
const PLAYER_CARD_HEIGHT = 132;

/** Right-column tab keys for the shared leaderboard / activity card. */
type SideTab = 'ranking' | 'feed';

/** Arbiter owner id for the enlarged seat plaque window. */
const SEAT_PEEK_OWNER = 'hud.seat';

/** Hand slot: hold-to-confirm timing, drag cancel distance and cycle pitch. */
const HAND_LONG_PRESS_MS = 500;
const HAND_PRESS_CANCEL_PX = 14;
const HAND_DRAG_STEP_PX = 40;
/** Wheel input is accumulated so a high-resolution trackpad does not skip cards. */
const HAND_WHEEL_STEP_PX = 24;

interface HandPressState {
  pointerId: number;
  actionId: string;
  /** Slot that owns the press: the desktop/tablet plaque or the phone dock card. */
  slot: HTMLElement;
  startX: number;
  startY: number;
  /** Horizontal or vertical drag axis, locked after the first few pixels. */
  axis: 'x' | 'y' | null;
  /** Number of whole 40px steps already consumed by the drag. */
  stepCount: number;
  moved: boolean;
  frame: number;
  timer: number | null;
}

export interface HUDOptions {
  onSwitchGame: (gameId: string) => void;
  /** Restart the current game at a named scenario ('' = plain setup). */
  onSwitchScenario?: (scenarioId: string) => void;
  /**
   * Plain-pixel rectangle the shell is covering. The composition root forwards
   * this to the renderer; the HUD itself never imports render code.
   */
  onViewportInsets?: (insets: { left: number; right: number; bottom: number; top: number }) => void;
}

/**
 * Presentation-only HUD.
 * It renders `GameSnapshot` DTOs and forwards intents to the presenter/ports.
 * It must not import the engine, game modules, audio or Three.js.
 */
function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/** 卡面 data URL 的轻量指纹：用来判断"这张牌的外观变了吗"，不必逐字符比较。 */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** `localStorage` 可能被无痕模式或企业策略禁用：包一层，失败就当作「没有存储」。 */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
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
  /** Node the player last clicked; the dossier follows it until the turn moves. */
  private pinnedNodeId?: string;
  /** Latest snapshot, kept for click handlers that need the current data. */
  private lastSnapshot?: GameSnapshot;
  /** Pointer position across the action row: 0 = left edge, 1 = right edge. */
  private fanFocusX = 0.5;
  /** 0 = flat row, 1 = full fisheye. Drops to 0 when the pointer leaves. */
  private fanFocusStrength = 0;
  private lastActorRoomId?: string;
  /** Set of node ids already seen, for the "new node discovered" reveal. */
  private knownNodes?: Set<string>;
  private sheetTimer: number | null = null;
  /** Last pointer position, used to place the seat peek window. */
  private pointerAt = { x: 0, y: 0 };
  /**
   * Pointer position along the player rail (0 = top, 1 = bottom), or null when
   * it is outside. The fisheye focus is derived from this, never from which card
   * the DOM reports as hovered: the layout moves the cards, so a DOM-derived
   * focus feeds back into itself and the rail oscillates.
   */
  private railFocusY: number | null = null;
  /** Pending animation frame for the rail fisheye (pointer events are coalesced). */
  private railFrame = 0;
  /** Selected right-column tab (shared leaderboard / recent activity card). */
  private sideTab: SideTab = 'ranking';
  /** Once the player picks a tab, automatic fallback must not override them. */
  private sideTabTouched = false;
  /** 冷却角标的刷新定时器（dock 建好后启动一次）。 */
  private cooldownTimer: number | null = null;
  /**
   * 操作栏抖动排查：把「重绘 / 换形 / 重建卡片 / 布局」记成一条时间线。
   * 诊断导出（⤓ 按钮）原样带出；`?docktrace=1` 时还会在左下角实时显示每秒次数，
   * 用来区分「DOM 在被反复重建」和「DOM 没动、只是合成层在闪」。
   */
  private dockTrace: DockTraceEntry[] = [];
  private dockTraceCounters = { render: 0, layout: 0, shape: 0, cards: 0, move: 0 };
  private dockTraceOverlay: HTMLElement | null = null;
  private dockTraceTimer: number | null = null;
  private dockTraceLastSig = '';
  private dockTraceLastLayout = { cw: 0, span: 0 };

  /** 德州扑克排行榜：当前页签与最近一次拉到的全服数据。 */
  private rankingTab: 'table' | 'global' = 'table';
  private accountRanking?: UiPokerRanking;
  private accountRankingPending = false;
  /** presenter 是否声明了全服数据源（决定「全服」页签出不出现）。 */
  private hasAccountRanking = false;
  /** 已绑定过一次的排行榜点击处理（面板重绘不重复挂监听）。 */
  private rankingBound = false;

  /** Stamp of the sheet currently painted, so a repaint does not restart its timer. */
  private paintedSheetStamp = 0;
  /** The layer outlives a repaint, so its backdrop handler must be replaced, not added again. */
  private sheetBackdrop?: (event: Event) => void;
  /** Single owner of every subject overlay: hover preview, sheet, modal. */
  private readonly overlays = new OverlayArbiter();
  /** Key of the game-declared moment whose curtain has already played. */
  private lastMomentKey?: string;
  /** False until the first snapshot has been observed. */
  private momentArmed = false;
  private momentTimer: number | null = null;
  /** Moment key whose manual-close lock is running, and its wall-clock deadline. */
  private momentLockKey?: string;
  private momentLockUntil = 0;
  private momentLockTimer: number | null = null;
  /** The currently mounted curtain's click handler. */
  private momentClickHandler?: (event: Event) => void;
  /** 结算幕布打开前的焦点，关闭时还回去（a11y）。 */
  private momentReturnFocus: HTMLElement | null = null;
  private momentKeyHandler?: (event: KeyboardEvent) => void;
  /** Activity feed starts open and remembers the player's choice. */
  private historyCollapsed = false;
  /** Active isolated floor in the 3D scene ('ALL' displays all floors). */
  private selectedFloor = 'ALL';
  /** Phone shell: whether the action drawer is expanded. */
  private dockOpen = false;
  /** Coalesced relayout of the fisheye after the drawer changes size. */
  private dockRelayoutFrame = 0;
  /** Re-runs the fan layout when the dock's width changes (drawer open, tier swap). */
  private dockResizeObserver?: ResizeObserver;
  private shellMedia?: MediaQueryList;
  /** Keeps inert/ARIA honest even if the drawer attribute is flipped externally. */
  private shellObserver?: MutationObserver;
  /** Trigger that opened the current drawer, so Escape can return focus to it. */
  private drawerOpener: HTMLElement | null = null;
  /** Centered hamburger dialog state and the controls temporarily moved into it. */
  private menuOpen = false;
  private menuOpener: HTMLElement | null = null;
  private menuRoot: HTMLElement | null = null;
  private readonly menuMoved = new Set<HTMLElement>();
  /** Latest inset push, skipped when the measured rectangle did not change. */
  private lastViewportInsets = { left: 0, right: 0, bottom: 0, top: 0 };
  private insetNotifyFrame = 0;
  /** Action currently held by the hand slot, mirrored on its fan card. */
  private heldActionId: string | null = null;
  private heldIndex = 0;
  /** Shadow unified action hand (docs/INTERACTION-REDESIGN.md). Off by default;
   *  flip with `?unified-hand` until P7 removes the legacy dock. */
  private actionHandEnabled = false;
  /** Radial target chooser, created lazily while the shadow hand is enabled. */
  private radialPicker: RadialPickerOverlay | null = null;
  /** 快捷键清单（`? `）：只提示一次，免得每局都弹。 */
  private shortcutHintShown = false;
  /** 统一手牌的物理层（弧形 / 跟手拖拽 / 弹簧回弹）；仅在 `?unified-hand` 下创建。 */
  private actionHand?: CardHand;
  /** 本次渲染用到的卡面 data URL（签名比对与建节点共用，避免重复取纹理）。 */
  private readonly handArt = new Map<string, string>();
  /** 出牌区（桌面矩形）的缓存：指针移动时不能每次都读布局。 */
  private handZone = { at: 0, points: null as Point[] | null };
  /** 已经回响过的最新一条历史（"打出的牌落在桌上"的幂等标记）。 */
  private lastEchoId = '';
  private handPress: HandPressState | null = null;
  private handSuppressClick = false;
  private handWheelDelta = 0;
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
    // One subscription drives both surfaces: the hover chip and the card sheet
    // are two renderings of the same arbiter state, so they can never disagree
    // about who owns the screen.
    this.overlays.subscribe(state => this.paintOverlays(state));
    this.bindRankingPanel();
    this.bindPresenter(presenter);
  }

  /**
   * 排行榜面板的点击处理：切页签、点账号开生涯战绩。
   *
   * 面板每手都会重绘，所以监听挂在容器上（一次），用 `closest` 找目标——
   * 给每行单独挂监听会在重建时泄漏。
   */
  private bindRankingPanel(): void {
    if (this.rankingBound) return;
    this.rankingBound = true;
    const panel = this.container.querySelector('#chip-ranking') as HTMLElement | null;
    if (!panel) return;
    panel.addEventListener('click', event => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const tabButton = target.closest<HTMLElement>('[data-rank-tab]');
      if (tabButton) {
        const tab = tabButton.dataset.rankTab === 'global' ? 'global' : 'table';
        // 点已选中的「全服」= 重试拉取：断线恢复后不用切走再切回来。
        if (tab === this.rankingTab && !(tab === 'global' && !this.accountRanking)) return;
        this.rankingTab = tab;
        if (tab === 'global') this.refreshAccountRanking();
        if (this.latest) this.renderChipRanking(this.latest);
        return;
      }
      const row = target.closest<HTMLElement>('[data-rank-user]');
      if (row?.dataset.rankUser) this.openAccountDetail(row.dataset.rankUser);
    });
  }

  public setPresenter(presenter: GamePresenter): void {
    this.unsubSnapshot?.();
    this.unsubNotice?.();
    this.closePayload();
    this.closeAbout();
    this.closeShortcutHelp();
    this.closeAccountDetail();
    this.accountRanking = undefined;
    this.accountRankingPending = false;
    this.hasAccountRanking = false;
    this.rankingTab = 'table';
    this.sideTab = 'ranking';
    this.sideTabTouched = false;
    this.overlays.closeAll();
    this.actionHand?.destroy();
    this.actionHand = undefined;
    this.resetHandSlot();
    this.container.querySelector('#card-sheet-layer')?.remove();
    // Switching fixtures must not treat the new board as "already discovered".
    this.knownNodes = undefined;
    this.pinnedNodeId = undefined;
    const roomCard = this.container.querySelector('#room-card') as HTMLElement | null;
    if (roomCard) roomCard.style.display = 'none';
    this.lastActorRoomId = undefined;
    this.lastMomentKey = undefined;
    this.momentArmed = false;
    this.selectedFloor = 'ALL';
    this.presenter = presenter;
    this.bindPresenter(presenter);
    this.syncSoundButton();
  }

  public dispose(): void {
    if (this.menuOpen) this.closeMenu(false);
    this.unsubSnapshot?.();
    this.unsubNotice?.();
    if (this.observerTimer !== null) {
      window.clearInterval(this.observerTimer);
      this.observerTimer = null;
    }
    if (this.dockTraceTimer !== null) {
      window.clearInterval(this.dockTraceTimer);
      this.dockTraceTimer = null;
    }

    this.dockTraceOverlay?.remove();
    this.dockTraceOverlay = null;
    this.dockResizeObserver?.disconnect();
    this.dockResizeObserver = undefined;
    this.shellObserver?.disconnect();
    this.shellObserver = undefined;
    if (this.insetNotifyFrame) {
      cancelAnimationFrame(this.insetNotifyFrame);
      this.insetNotifyFrame = 0;
    }
    if (this.dockRelayoutFrame) {
      cancelAnimationFrame(this.dockRelayoutFrame);
      this.dockRelayoutFrame = 0;
    }
    const hand = this.container.querySelector('#hand-slot') as HTMLElement | null;
    if (hand) this.cancelHandPress(hand);
    const dockHeld = this.container.querySelector('[data-dock-held]') as HTMLElement | null;
    if (dockHeld) this.cancelHandPress(dockHeld);
  }

  /** 观察席倒计时的本地刷新：只做减法，不动游戏状态。 */
  private observerRows: UiObserver[] = [];
  private observerAnchor = 0;
  private observerTimer: number | null = null;

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
    if (this.menuOpen) this.closeMenu(false);
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer) return;
    layer.style.display = 'none';
    layer.replaceChildren();
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

    setHtml(layer, html`
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
            <dd><code title="${fullHash}">${commitHash}</code></dd>
          </div>
          <div class="about-row">
            <dt>Contributors</dt>
            <dd class="about-contributors">${raw(contributors.length > 0
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
                : 'unknown')}</dd>
          </div>
          <div class="about-row">
            <dt>Repository</dt>
            <dd class="about-repo">${raw(repoHref
                ? `<a href="${esc(repoHref)}" target="_blank" rel="noopener noreferrer">${esc(repoUrl)}</a>`
                : esc(repoUrl) || 'unknown')}</dd>
          </div>
          <div class="about-row">
            <dt>Commits</dt>
            <dd class="about-commits">
              <span class="commit-total"><strong>${totalCommits || '140+'}</strong> 次提交</span>
              ${raw(commitBreakdown ? `<span class="commit-breakdown">（${commitBreakdown}）</span>` : '')}
            </dd>
          </div>
          ${raw(commitDate ? `<div class="about-row"><dt>Commit Date</dt><dd>${esc(commitDate)}</dd></div>` : '')}
          ${raw(buildTime ? `<div class="about-row"><dt>Build Time</dt><dd>${esc(buildTime)}</dd></div>` : '')}
        </dl>
        <div class="pf-foot">
          <button class="pf-btn primary about-close" data-about-close>关闭</button>
        </div>
      </div>
    `);
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

  /**
   * 快捷键清单（`? `）。
   *
   * 审查 G4 说的是「快捷键几乎不可发现」——键位本身一直能用，只是没人告诉玩家。
   * 清单整块由 `keymap.ts` 那张唯一键位表渲染（`shortcutHelp.ts`），所以「加了键
   * 却忘了写进清单」在结构上不可能发生；顶栏 ⌨ 与首屏提示都指向同一个面板。
   */
  public toggleShortcutHelp(): void {
    if (this.container.querySelector('#shortcut-layer')) this.closeShortcutHelp();
    else this.openShortcutHelp();
  }

  public openShortcutHelp(): void {
    this.closeShortcutHelp();
    // 清单是模态：先让悬停芯片让位，免得它贴在清单边上闪。
    this.overlays.close('peek');

    const layer = document.createElement('div');
    layer.className = 'about-layer shortcut-layer';
    layer.id = 'shortcut-layer';
    setHtml(layer, html`
      <div class="about-backdrop" data-shortcut-close></div>
      <div class="about-card shortcut-card" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
        <div class="pf-head">
          <div class="pf-ico">⌨</div>
          <div>
            <div class="pf-title" id="shortcut-title">快捷键</div>
            <div class="pf-hint">焦点在输入框 / 下拉框里时不会误触这些键 · Esc 随时可退</div>
          </div>
        </div>
        ${raw(shortcutHelpHtml())}
        <div class="pf-foot">
          <button class="pf-btn primary shortcut-close" data-shortcut-close>关闭</button>
        </div>
      </div>
    `);
    this.container.appendChild(layer);

    layer.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('[data-shortcut-close]')) this.closeShortcutHelp();
    });
    layer.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.closeShortcutHelp();
        return;
      }
      // 再按一次 `?` 就收起：与打开它的手势对称，不必回头找按钮。
      if (event.key === '?' || event.key === '？') {
        event.preventDefault();
        event.stopPropagation();
        this.closeShortcutHelp();
      }
    });
    (layer.querySelector('.shortcut-close') as HTMLElement | null)?.focus();
  }

  public closeShortcutHelp(): void {
    const layer = this.container.querySelector('#shortcut-layer') as HTMLElement | null;
    if (!layer) return;
    const opener = this.container.querySelector('#btn-shortcuts') as HTMLElement | null;
    layer.remove();
    opener?.focus();
  }

  /**
   * 首屏一次性提示：给「不可发现」一个真实入口，而不是要求玩家先猜「?」。
   *
   * 同一浏览器只提示一次（`rds.shortcuts.hinted`）；存储不可用时安静跳过——
   * 每次刷新都弹一遍比不弹更烦。
   */
  private maybeHintShortcuts(): void {
    if (this.shortcutHintShown) return;
    this.shortcutHintShown = true;
    const storage = safeLocalStorage();
    if (!shouldShowShortcutHint(storage)) return;
    try {
      storage?.setItem(SHORTCUT_HINT_KEY, '1');
    } catch {
      // 存不进去就当本次会话已经提示过：宁可少提示，也不要卡住。
    }
    this.pushToast('⌨', '按 ? 查看快捷键清单', 4200);
  }

  /**
   * 账号生涯战绩弹窗（德州扑克 · 全服排行）。
   *
   * 数据全部来自服务端账本（`UiAccountRank`），这里只排版：比率已经在
   * presenter / 服务端算好，界面不做除法，也不认识「入池率」该怎么算——
   * 口径写在弹窗脚注里，改口径只改一处。
   */
  public openAccountDetail(userId: string): void {
    const row = this.accountRanking?.accounts.find(entry => entry.userId === userId);
    if (!row) return;
    this.closeAccountDetail();

    const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
    const stat = (label: string, value: string, hint?: string): string => `
      <div class="ad-stat"${hint ? ` title="${escapeAttr(hint)}"` : ''}>
        <span class="ad-stat-k">${escHtml(label)}</span>
        <span class="ad-stat-v">${escHtml(value)}</span>
      </div>`;

    const layer = document.createElement('div');
    layer.className = 'about-layer account-detail-layer';
    layer.id = 'account-detail-layer';
    setHtml(layer, html`
      <div class="about-backdrop" data-account-close></div>
      <div class="about-card account-detail" role="dialog" aria-modal="true" aria-label="账号生涯战绩">
        <div class="pf-head">
          <div class="pf-ico">${raw(row.avatarUrl
              ? `<img class="ad-avatar" src="${escapeAttr(row.avatarUrl)}" alt="" />`
              : escHtml(row.name.slice(0, 1).toUpperCase()))}</div>
          <div>
            <div class="pf-title">${row.name}</div>
            <div class="pf-hint">${raw(row.roomId
              ? `正在对局 · ${escHtml(row.roomId)} · ${escHtml(row.seat ?? '')} 座位`
              : '当前不在牌桌')}</div>
          </div>
        </div>
        <div class="ad-hero">
          <span class="ad-hero-v">${raw(row.chips)}</span>
          <span class="ad-hero-k">总筹码</span>
          <span class="ad-hero-split">余额 ${raw(row.bankroll)} · 在桌 ${raw(row.onTable)}</span>
        </div>
        <div class="ad-stats">
          ${raw(stat('手数', String(row.stats.hands), '参与过的手牌总数（不含旁观）'))}
          ${raw(stat('胜率', percent(row.stats.winRate), '赢下至少一个底池的手数 / 参与手数'))}
          ${raw(stat('入池率', percent(row.stats.vpipRate), '翻前自愿投钱（跟注 / 加注 / 全押）的手数占比，盲注不算'))}
          ${raw(stat('看翻牌', percent(row.stats.sawFlopRate), '翻牌发出时仍在牌局里的手数占比'))}
          ${raw(stat('摊牌率', percent(row.stats.showdownRate), '走到摊牌的手数占比'))}
          ${raw(stat('摊牌胜率', percent(row.stats.showdownWinRate), '摊牌中赢下底池的手数 / 摊牌手数'))}
          ${raw(stat('净输赢', `${row.stats.netChips >= 0 ? '+' : ''}${row.stats.netChips}`, '赢回 - 投入的累计筹码'))}
          ${raw(stat('最大底池', String(row.stats.bestPot), '单手提走的最大底池'))}
          ${raw(stat('峰值筹码', String(row.peakChips), '生涯最高总筹码'))}
        </div>
        <div class="ad-foot">
          入池率 = 翻前自愿投钱手数 / 参与手数 · 胜率 = 赢下底池手数 / 参与手数
        </div>
        <div class="pf-foot">
          <button class="pf-btn primary account-close" data-account-close>关闭</button>
        </div>
      </div>
    `);
    this.container.appendChild(layer);

    const close = (): void => this.closeAccountDetail();
    layer.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('[data-account-close]')) close();
    });
    layer.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    });
    (layer.querySelector('.account-close') as HTMLElement | null)?.focus();
  }

  public closeAccountDetail(): void {
    this.container.querySelector('#account-detail-layer')?.remove();
  }

  /** Reflect the renderer's camera state without owning the camera. */
  public syncCamera(view: CameraView): void {
    this.container.querySelectorAll<HTMLElement>('.cam-btn').forEach(button => {
      button.classList.toggle('active', button.dataset.cam === view);
    });
  }

  /**
   * Screen areas the shell is currently painting over the 3D canvas.
   *
   * The renderer needs this to keep the player's own cards out from under the
   * dock (see `render/handRowDepth.ts`). The HUD is the only layer that knows
   * where its panels actually land — at 1920×1080 the dock owns the left third
   * of the bottom edge, below 1200px it becomes a full-width drawer, and on a
   * phone it collapses again — so the geometry is measured here and handed over
   * as plain rectangles instead of being guessed from a breakpoint.
   *
   * Only opaque, interactive panels count. Decorative washes and the hover chip
   * are excluded: reserving them would push the cards around for no reason.
   */
  public reservedScreenBoxes(): { x: number; y: number; width: number; height: number }[] {
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    const selectors = [
      '#action-dock',
      '.app-shell > .hand-slot',
      '#player-rail',
      '#activity-feed',
      '#room-card'
    ];
    for (const selector of selectors) {
      const el = this.container.querySelector(selector) as HTMLElement | null;
      if (!el) continue;
      // A collapsed slide-over / hidden panel reserves nothing.
      let node: HTMLElement | null = el;
      let hidden = false;
      while (node) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          hidden = true;
          break;
        }
        node = node.parentElement;
      }
      if (hidden) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      boxes.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    return boxes;
  }

  /**
   * Lightweight hover chip for the 3D board: shows what the cursor is over and
   * what a click will do, without stealing focus from the action dock.
   *
   * The chip is the arbiter's `peek` slot, so it cannot displace a sheet the
   * player deliberately opened, and it disappears the moment one opens.
   */
  public showHoverHint(view: UiDetailView | null): void {
    if (!view) {
      this.overlays.close('peek');
      return;
    }
    this.overlays.open({ owner: 'hud.hover', mode: 'peek', view });
  }

  /** Paint both overlay surfaces from the one authoritative state. */
  private paintOverlays(state: OverlayState): void {
    this.paintHover(state.peek);
    this.paintSheet(state.modal ?? state.pinned);
  }

  /**
   * Enlarged preview of a seat plaque, shown while the pointer rests on it.
   *
   * It is the arbiter's `peek` slot (so a deliberate sheet always wins) but it
   * paints into its own window rather than the one-line chip: a plaque carries
   * four rows, and the whole point is to read it from across the table.
   */
  public showSeatPeek(view: UiDetailView | null): void {
    if (!view) {
      if (this.overlays.current().peek?.owner === SEAT_PEEK_OWNER) this.overlays.close('peek');
      return;
    }
    this.overlays.open({ owner: SEAT_PEEK_OWNER, mode: 'peek', view });
  }

  private paintHover(entry?: OverlayEntry): void {
    // One peek at a time: the seat plaque window and the one-line chip are two
    // surfaces of the same slot, so each hides the other.
    this.paintSeatPeek(entry?.owner === SEAT_PEEK_OWNER ? entry : undefined);

    let el = this.container.querySelector('#hover-hint') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = 'hover-hint';
      el.className = 'hover-hint';
      this.container.appendChild(el);
    }
    if (!entry || entry.owner === SEAT_PEEK_OWNER) {
      el.classList.remove('on');
      el.classList.remove('with-art');
      return;
    }
    const hint = entry.view;
    const signature = `${hint.title}|${hint.desc ?? ''}|${hint.art ?? ''}`;
    if (el.dataset.signature === signature) {
      el.classList.add('on');
      return;
    }
    el.dataset.signature = signature;
    // A card face gets a full preview above the caption: a one-line tooltip
    // cannot convey a card's art at board scale.
    el.classList.toggle('with-art', !!hint.art);
    setHtml(el, raw((hint.art ? `<img class="hh-art" src="${escapeAttr(hint.art)}" alt="${escapeAttr(hint.title)}" />` : '') +
      `<span class="hh-body"><b>${escHtml(hint.title)}</b>${hint.desc ? `<span>${escHtml(hint.desc)}</span>` : ''}</span>`));
    el.classList.add('on');
  }

  /**
   * The enlarged seat window.
   *
   * Positioned beside the pointer (never under it — a window that covers the
   * cursor would end the board hover that opened it, and the pair would
   * flicker). Height is capped at a third of the viewport, as asked, and the
   * board's own 0.86 : 1.24 aspect decides the width.
   */
  private paintSeatPeek(entry?: OverlayEntry): void {
    let el = this.container.querySelector('#seat-peek') as HTMLElement | null;
    if (!el) {
      el = document.createElement('div');
      el.id = 'seat-peek';
      el.className = 'seat-peek';
      this.container.appendChild(el);
    }
    if (!entry) {
      el.classList.remove('on');
      el.dataset.key = '';
      return;
    }

    const view = entry.view;
    if (el.dataset.key !== view.key) {
      el.dataset.key = view.key;
      const rows = view.sections
        .map(row => `<div class="sp-row"><span class="sp-k">${escHtml(row.label)}</span><span class="sp-v">${escHtml(row.value)}</span></div>`)
        .join('');
      setHtml(el, html`
        <div class="sp-coin">${view.seal ?? '👤'}</div>
        <div class="sp-name">${view.title}</div>
        ${raw(view.badge ? `<div class="sp-badge">${escHtml(view.badge)}</div>` : '')}
        ${raw(view.subtitle ? `<div class="sp-sub">${escHtml(view.subtitle)}</div>` : '')}
        <div class="sp-rows">${raw(rows)}</div>
      `);
    }

    const rect = el.getBoundingClientRect();
    const height = rect.height || Math.round(window.innerHeight / 3);
    const gap = 26;
    const fitsRight = this.pointerAt.x + gap + rect.width <= window.innerWidth - 8;
    const left = fitsRight ? this.pointerAt.x + gap : this.pointerAt.x - gap - rect.width;
    const top = Math.min(
      Math.max(8, this.pointerAt.y - height / 2),
      window.innerHeight - height - 8
    );
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${top}px`;
    el.classList.add('on');
  }

  public pushToast(icon: string, text: string, ttl = 3600, detail?: string): void {
    const stack = document.getElementById('toast-container');
    if (!stack) return;

    const el = document.createElement('div');
    el.className = 'toast';
    setHtml(el, html`<span class="t-ico">${raw(icon)}</span><span class="t-txt">${raw(text)}${raw(detail ? `<span class="t-detail">${detail}</span>` : '')}</span>`);
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

    setHtml(banner, html`<span class="a-mark">❖</span><span>${raw(title)}</span>`);
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

  /** Drawers only exist as overlays below 1200px (landscape phones included). */
  private isOverlayShell(): boolean {
    return window.matchMedia('(max-width: 1199px), (max-height: 480px) and (min-width: 600px)').matches;
  }

  private drawerFor(which: 'rail' | 'side'): HTMLElement | null {
    return this.container.querySelector(which === 'rail' ? '#player-rail' : '#side-column') as HTMLElement | null;
  }

  private openDrawerWhich(): 'rail' | 'side' | null {
    if (this.container.getAttribute('data-rail') === 'open') return 'rail';
    if (this.container.getAttribute('data-side') === 'open') return 'side';
    return null;
  }

  /** Buttons/links/tabs reachable with Tab inside one drawer, in DOM order. */
  private drawerFocusables(drawer: HTMLElement): HTMLElement[] {
    const selectors = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(drawer.querySelectorAll<HTMLElement>(selectors)).filter(
      el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    );
  }

  /** Buttons/links/tabs reachable with Tab inside the centered menu. */
  private menuFocusables(): HTMLElement[] {
    if (!this.menuRoot) return [];
    const selectors =
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(this.menuRoot.querySelectorAll<HTMLElement>(selectors)).filter(
      el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    );
  }

  /** Keep Tab inside the menu dialog and wrap at both ends. */
  private trapMenuFocus(event: KeyboardEvent): void {
    const items = this.menuFocusables();
    if (items.length === 0) {
      event.preventDefault();
      this.menuRoot?.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const outside = !active || !this.menuRoot?.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  /** The menu is modal; put the rest of the shell and the canvas out of reach. */
  private syncMenuInert(): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (this.menuOpen) {
      for (const child of Array.from(this.container.children) as HTMLElement[]) {
        child.toggleAttribute('inert', child !== layer);
      }
      for (const id of ['canvas-container', 'stage-vignette', 'inspector-container']) {
        document.getElementById(id)?.setAttribute('inert', '');
      }
      return;
    }
    // Closing the menu may have been caused by a drawer toggle. Re-derive the
    // drawer's inert state instead of clearing everything blindly.
    this.syncShellInert();
  }

  /**
   * Centered hamburger dialog. It reuses the existing payload modal layer (one
   * backdrop, one focus trap), and moves the live topbar controls inside rather
   * than cloning them.
   */
  private openMenu(opener: HTMLElement): void {
    if (this.menuOpen) return;
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    const topbar = this.container.querySelector('.topbar') as HTMLElement | null;
    const games = topbar?.querySelector('.game-switch') as HTMLElement | null;
    const actions = topbar?.querySelector('.topbar-actions') as HTMLElement | null;
    if (!layer || !topbar || !games || !actions) return;

    const open = this.openDrawerWhich();
    if (open) this.closeDrawer(open, false);
    this.closeAbout();
    this.closeAccountDetail();
    this.closePayload();

    setHtml(layer, html`
      <div class="payload-backdrop" data-menu-backdrop></div>
      <div class="menu-card" id="menu-dialog" role="dialog" aria-modal="true" aria-labelledby="menu-dialog-title" tabindex="-1">
        <header class="menu-head">
          <div class="menu-heading">
            <span class="menu-kicker">UNIVERSAL GAME KERNEL</span>
            <h2 class="menu-title" id="menu-dialog-title">主菜单</h2>
          </div>
          <button class="menu-close" type="button" data-menu-close aria-label="关闭菜单">×</button>
        </header>
        <div class="menu-body">
          <section class="menu-section" aria-labelledby="menu-games-title">
            <h3 class="menu-section-title" id="menu-games-title">游戏</h3>
            <div class="menu-slot" data-menu-slot="games"></div>
          </section>
          <section class="menu-section" aria-labelledby="menu-controls-title">
            <h3 class="menu-section-title" id="menu-controls-title">对局与视图</h3>
            <div class="menu-slot" data-menu-slot="controls"></div>
          </section>
        </div>
      </div>
    `);
    const root = layer.querySelector('.menu-card') as HTMLElement | null;
    const gamesSlot = layer.querySelector('[data-menu-slot="games"]') as HTMLElement | null;
    const controlsSlot = layer.querySelector('[data-menu-slot="controls"]') as HTMLElement | null;
    if (!root || !gamesSlot || !controlsSlot) {
      layer.replaceChildren();
      return;
    }

    this.menuMoved.clear();
    this.menuMoved.add(games);
    this.menuMoved.add(actions);
    gamesSlot.append(games);
    controlsSlot.append(actions);

    this.menuRoot = root;
    this.menuOpener = opener;
    this.menuOpen = true;
    layer.style.display = 'flex';
    opener.setAttribute('aria-expanded', 'true');

    layer.querySelector('.payload-backdrop')?.addEventListener('click', () => this.closeMenu(true));
    layer.querySelector('[data-menu-close]')?.addEventListener('click', () => this.closeMenu(true));
    layer.onclick = event => {
      const target = event.target as HTMLElement | null;
      if (!target || target.closest('[data-menu-backdrop], [data-menu-close]')) return;
      if (
        target.closest(
          '.game-pill, #btn-about, #btn-undo, #btn-inspector, #btn-diagnostics, [data-toggle="rail"], [data-toggle="side"]'
        )
      ) {
        this.closeMenu(false);
      }
    };
    layer.onchange = event => {
      if ((event.target as HTMLElement | null)?.closest('#scenario-select')) this.closeMenu(false);
    };

    this.syncMenuInert();
    requestAnimationFrame(() => {
      const first = (root.querySelector('.menu-body .game-pill') as HTMLElement | null) ?? this.menuFocusables()[0];
      (first ?? this.menuRoot)?.focus({ preventScroll: true });
    });
  }

  /** Restore the topbar controls and return focus to the ☰ button. */
  private closeMenu(restoreFocus: boolean): void {
    if (!this.menuOpen) return;
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    const topbar = this.container.querySelector('.topbar') as HTMLElement | null;
    const moved = [...this.menuMoved];
    this.menuMoved.clear();
    this.menuOpen = false;
    this.menuRoot = null;
    if (topbar && moved.length > 0) topbar.append(...moved);
    if (layer) {
      layer.style.display = 'none';
      layer.replaceChildren();
      layer.onclick = null;
      layer.onchange = null;
    }
    this.syncMenuInert();
    const opener = this.menuOpener;
    this.menuOpener = null;
    opener?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) opener?.focus({ preventScroll: true });
  }

  /**
   * Open one slide-over, focus its first control and make the rest of the shell
   * inert. The ARIA dialog state is applied here rather than in the skeleton so
   * the desktop persistent panels are not announced as modal dialogs.
   */
  private openDrawer(which: 'rail' | 'side', opener?: HTMLElement | null): void {
    const drawer = this.drawerFor(which);
    if (!drawer) return;
    this.container.removeAttribute(which === 'rail' ? 'data-side' : 'data-rail');
    this.container.setAttribute(which === 'rail' ? 'data-rail' : 'data-side', 'open');
    this.drawerOpener =
      opener ?? (this.container.querySelector(`[data-toggle="${which}"]`) as HTMLElement | null);
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', which === 'rail' ? 'drawer-rail-title' : 'drawer-side-title');
    this.syncShellAria();
    this.syncShellInert();
    this.notifyViewportInsets();
    const focusFirst = () => {
      if (this.openDrawerWhich() !== which) return;
      // Never steal focus once the user is already inside the drawer.
      if (drawer.contains(document.activeElement) && document.activeElement !== drawer) return;
      const first = this.drawerFocusables(drawer)[0];
      if (first) {
        first.focus({ preventScroll: true });
      } else {
        drawer.tabIndex = -1;
        drawer.focus({ preventScroll: true });
      }
    };
    // The drawer's just-applied visibility can still be pending in this task.
    // Focus on the next turn, when its controls are measurable and focusable;
    // the delayed pass covers reduced-motion style flushes.
    window.setTimeout(focusFirst, 0);
    requestAnimationFrame(focusFirst);
    window.setTimeout(focusFirst, 350);
  }

  /** Close a drawer, drop inert and hand focus back to the button that opened it. */
  private closeDrawer(which: 'rail' | 'side', restoreFocus = true): void {
    const attr = which === 'rail' ? 'data-rail' : 'data-side';
    if (this.container.getAttribute(attr) !== 'open') return;
    const drawer = this.drawerFor(which);
    this.container.removeAttribute(attr);
    drawer?.removeAttribute('role');
    drawer?.removeAttribute('aria-modal');
    drawer?.removeAttribute('aria-labelledby');
    this.syncShellAria();
    this.syncShellInert();
    this.notifyViewportInsets();
    if (!restoreFocus) return;
    const opener =
      this.drawerOpener ?? (this.container.querySelector(`[data-toggle="${which}"]`) as HTMLElement | null);
    this.drawerOpener = null;
    opener?.focus({ preventScroll: true });
  }

  /**
   * Background is inert while a drawer is a modal surface. The scrim stays
   * clickable, and the canvas/inspector are inert too so keyboard focus cannot
   * wander behind the panel.
   */
  private syncShellInert(): void {
    const open = this.openDrawerWhich();
    const active = open ? this.drawerFor(open) : null;
    for (const child of Array.from(this.container.children) as HTMLElement[]) {
      // The topbar keeps its toggles clickable: it is the visible opener/closer
      // strip above the scrim and is excluded from the Tab trap by the trap
      // itself. Everything that can hold a board interaction goes inert.
      if (child === active || child.classList.contains('shell-scrim') || child.classList.contains('topbar')) {
        child.removeAttribute('inert');
      } else {
        child.toggleAttribute('inert', !!open);
      }
    }
    for (const id of ['canvas-container', 'stage-vignette', 'inspector-container']) {
      document.getElementById(id)?.toggleAttribute('inert', !!open);
    }
  }

  /** Keep Tab inside the open drawer and wrap at both ends. */
  private trapDrawerFocus(event: KeyboardEvent): void {
    const which = this.openDrawerWhich();
    if (!which) return;
    const drawer = this.drawerFor(which);
    if (!drawer) return;
    const items = this.drawerFocusables(drawer);
    const active = document.activeElement as HTMLElement | null;
    if (items.length === 0) {
      event.preventDefault();
      drawer.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const outside = !active || active === drawer || !drawer.contains(active);
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  /**
   * Publish the rectangle covered by the current overlay to the composition
   * root. The HUD knows the real CSS box; the renderer only receives numbers.
   */
  private notifyViewportInsets(): void {
    const callback = this.options.onViewportInsets;
    if (!callback) return;
    const width = window.innerWidth;
    const height = window.innerHeight;
    let left = 0;
    let right = 0;
    let bottom = 0;
    const top = 0;
    if (this.isOverlayShell()) {
      const open = this.openDrawerWhich();
      if (open) {
        const drawer = this.drawerFor(open);
        const measured = drawer ? Math.round(drawer.offsetWidth) : 0;
        if (open === 'rail') left = Math.max(0, measured);
        else right = Math.max(0, measured);
      }
      const dock = this.container.querySelector('#action-dock') as HTMLElement | null;
      if (this.dockOpen && dock) {
        const rect = dock.getBoundingClientRect();
        bottom = Math.max(0, Math.round(height - rect.top));
      }
    }
    const clamped = {
      left: Math.min(left, width - 1),
      right: Math.min(right, Math.max(0, width - left - 1)),
      bottom: Math.min(bottom, height - 1),
      top
    };
    const last = this.lastViewportInsets;
    if (
      Math.abs(clamped.left - last.left) < 0.5 &&
      Math.abs(clamped.right - last.right) < 0.5 &&
      Math.abs(clamped.bottom - last.bottom) < 0.5 &&
      Math.abs(clamped.top - last.top) < 0.5
    ) {
      return;
    }
    this.lastViewportInsets = clamped;
    callback(clamped);
  }

  /** Dock height animates via max-height; re-measure after it settles. */
  private notifyViewportInsetsSoon(): void {
    this.notifyViewportInsets();
    if (this.insetNotifyFrame) cancelAnimationFrame(this.insetNotifyFrame);
    this.insetNotifyFrame = requestAnimationFrame(() => {
      this.insetNotifyFrame = 0;
      this.notifyViewportInsets();
    });
    window.setTimeout(() => this.notifyViewportInsets(), 240);
  }

  /** Mirror slide-over state, controls and labels onto the toggles. */
  private syncShellAria(): void {
    for (const [attr, sel, target] of [
      ['data-side', '[data-toggle="side"]', 'side-column'],
      ['data-rail', '[data-toggle="rail"]', 'player-rail']
    ] as const) {
      const button = this.container.querySelector(sel) as HTMLElement | null;
      const drawer = this.container.querySelector(`#${target}`) as HTMLElement | null;
      if (!button) continue;
      const overlayOpen = this.container.getAttribute(attr) === 'open';
      const expanded = !this.isOverlayShell() && drawer?.getAttribute('data-expanded') === '1';
      const open = overlayOpen || expanded;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
      button.setAttribute('aria-controls', target);
      const label = attr === 'data-rail' ? '角色栏' : '信息栏';
      button.setAttribute('aria-label', `${open ? '收起' : '展开'}${label}`);
    }
  }

  /**
   * Keep shell-owned geometry in sync when the viewport or drawer state changes.
   * Controls stay in the topbar DOM (hidden) and are only moved into the
   * hamburger dialog while it is open, so there is still one source of state.
   */
  private applyShellLayout(): void {
    this.applySideTab();
    // Crossing back to desktop turns the drawers into persistent panels; clear
    // the modal state so inert/focus trap cannot outlive the overlay layout.
    if (!this.isOverlayShell()) {
      const open = this.openDrawerWhich();
      if (open) this.closeDrawer(open, false);
    }

    // 顶栏可能因换行而变高：把真实高度写回 --topbar-h，侧栏/角色栏据此定位。
    // 不占用额外的 ResizeObserver：布局变更本来就要过一次这里。
    const bar = this.container.querySelector('.topbar') as HTMLElement | null;
    if (bar) {
      const h = Math.round(bar.getBoundingClientRect().height);
      if (h > 0) this.container.style.setProperty('--topbar-h', h + 'px');
    }

    this.syncRailExpandedGeometry();
    this.syncHandSlotGeometry();
    const rail = this.container.querySelector('#player-rail') as HTMLElement | null;
    if (rail) this.layoutPlayerRail(rail);
    this.relayoutDock();
    this.notifyViewportInsets();
  }

  /**
   * The right column is one tabbed card at every width: leaderboard and recent
   * activity are two views of the same window, so only one panel is visible.
   * Observer rows live outside this card and stay independent.
   */
  private applySideTab(): void {
    const host = this.container.querySelector('#side-tabs') as HTMLElement | null;
    if (!host) return;
    host.dataset.sideTab = this.sideTab;
    const panels: Array<[SideTab, string]> = [
      ['ranking', '#chip-ranking'],
      ['feed', '#activity-feed']
    ];
    for (const [key, selector] of panels) {
      const panel = this.container.querySelector(selector) as HTMLElement | null;
      if (!panel) continue;
      panel.hidden = key !== this.sideTab;
    }
    for (const button of this.container.querySelectorAll<HTMLElement>('[data-side-tab-target]')) {
      button.setAttribute('aria-selected', button.dataset.sideTabTarget === this.sideTab ? 'true' : 'false');
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
        if (
          field.kind === 'number' &&
          field.widget === 'slider' &&
          field.min !== undefined &&
          field.max !== undefined
        ) {
          const marks = (field.marks ?? [])
            .filter(mark => mark.value >= (field.min ?? -Infinity) && mark.value <= (field.max ?? Infinity))
            .map(mark => `<button type="button" class="pf-quick" data-quick="${mark.value}">${mark.label}</button>`)
            .join('');
          return `
            <div class="pf-row pf-slider-row" data-field-row="${field.key}">
              <div class="pf-slider-head">
                <span class="pf-label">${field.label}</span>
                <span class="pf-slider-bounds">${field.min} – ${field.max}</span>
              </div>
              <div class="pf-slider-line">
                <input class="pf-slider" data-slider="${field.key}" type="range"
                  min="${field.min}" max="${field.max}" step="${field.step ?? 1}" value="${value}"
                  aria-label="${field.label}" />
                <input class="pf-control pf-slider-num" data-field="${field.key}" type="number"
                  value="${value}" min="${field.min}" max="${field.max}" step="1"
                  aria-label="${field.label}" />
              </div>
              ${marks ? `<div class="pf-slider-quick" data-slider-quick="${field.key}">${marks}</div>` : ''}
            </div>
          `;
        }
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

    setHtml(layer, html`
      <div class="payload-backdrop"></div>
      <form class="payload-card" autocomplete="off">
        <header class="pf-head">
          <span class="pf-ico">${raw(action.icon)}</span>
          <div>
            <div class="pf-title">${raw(action.label)}</div>
            <div class="pf-hint">${raw(action.hint)}</div>
          </div>
        </header>
        <div class="pf-body">${raw(selection)}${raw(fields)}</div>
        <footer class="pf-foot">
          <button type="button" class="pf-btn" id="pf-cancel">取消</button>
          <button type="submit" class="pf-btn primary">确认</button>
        </footer>
      </form>
    `);
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.replaceChildren();
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

    // Slider widget: keep the drag control and the exact-entry number box in
    // lockstep, and let the game-declared quick stops jump straight to a value.
    for (const field of action.fields ?? []) {
      if (field.kind !== 'number' || field.widget !== 'slider') continue;
      const slider = form.querySelector<HTMLInputElement>(`[data-slider="${field.key}"]`);
      const numberBox = form.querySelector<HTMLInputElement>(`[data-field="${field.key}"]`);
      if (!slider || !numberBox) continue;
      const paintSlider = (): void => {
        const min = Number(slider.min);
        const max = Number(slider.max);
        const progress = max > min ? (Number(slider.value) - min) / (max - min) : 0;
        slider.style.setProperty('--pct', `${(progress * 100).toFixed(2)}%`);
      };
      slider.addEventListener('input', () => {
        numberBox.value = slider.value;
        paintSlider();
      });
      numberBox.addEventListener('input', () => {
        const amount = Number(numberBox.value);
        if (!Number.isFinite(amount)) return;
        slider.value = String(Math.min(Number(slider.max), Math.max(Number(slider.min), amount)));
        paintSlider();
      });
      form.querySelectorAll<HTMLButtonElement>(`[data-slider-quick="${field.key}"] .pf-quick`).forEach(button => {
        button.addEventListener('click', () => {
          const amount = Number(button.dataset.quick);
          if (!Number.isFinite(amount)) return;
          // 快捷档（含「全押」）必须写**精确值**：range 的 value 会被 step 吸附到
          // 最近的整盲注，1185 的全押会变成 1180，按钮就退化成了普通加注（issue #191）。
          // 数字输入框是最终提交来源，滑块只负责视觉位置。
          numberBox.value = String(amount);
          slider.value = String(Math.min(Number(slider.max), Math.max(Number(slider.min), amount)));
          paintSlider();
        });
      });
      paintSlider();
    }

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
      this.pinnedNodeId = notice.roomId;
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
    if (notice.view) {
      this.showCardSheet(notice.view);
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

      card.querySelectorAll<HTMLElement>('.trait-row').forEach(row => {
        if (row.dataset.traitKey !== change.traitKey) return;
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
   * Framed detail sheet for one subject.
   *
   * The plate is neutral: the game only supplies the category band text
   * (`view.badge`), an opaque tone token and an optional seal glyph, so a new
   * fixture gets the same sheet without teaching the HUD its vocabulary.
   */
  public showCardSheet(view: UiDetailView, options: { reveal?: boolean; footer?: string } = {}): void {
    this.overlays.open({
      owner: 'hud.sheet',
      mode: options.reveal ? 'modal' : 'pinned',
      view,
      footer: options.footer,
      reveal: options.reveal
    });
  }

  private paintSheet(entry?: OverlayEntry): void {
    let layer = this.container.querySelector('#card-sheet-layer') as HTMLElement | null;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'card-sheet-layer';
      layer.className = 'card-sheet-layer';
      this.container.appendChild(layer);
    }
    // A repaint that keeps the same entry must not restart the dismiss timer or
    // replay the entrance animation.
    if (entry && entry.stamp === this.paintedSheetStamp) return;
    if (this.sheetTimer) {
      window.clearTimeout(this.sheetTimer);
      this.sheetTimer = null;
    }
    if (!entry) {
      this.paintedSheetStamp = 0;
      layer.classList.remove('open', 'is-reveal');
      layer.replaceChildren();
      return;
    }
    this.paintedSheetStamp = entry.stamp;
    const view = entry.view;
    // Ink is the *light* text on the dark plate; ribbon is the dark category band.
    const theme = detailTone(view.tone);
    const facts = (view.sections ?? [])
      .map(row => `<li><span>${escHtml(row.label)}</span><b>${escHtml(row.value)}</b></li>`)
      .join('');

    layer.classList.toggle('is-reveal', !!entry.reveal);
    setHtml(layer, html`
      <article class="card-sheet" data-tone="${view.tone ?? 'neutral'}" style="--ink:${raw(theme.ink)};--ribbon:${raw(theme.ribbon)}">
        <button class="cs-close" type="button" aria-label="关闭">×</button>
        ${raw(view.badge ? `<div class="cs-ribbon"><span>${escHtml(view.badge)}</span></div>` : '')}
        <div class="cs-body">
          <div class="cs-art">${raw(view.art
              ? `<img class="cs-art-img" src="${escapeAttr(view.art)}" alt="${escapeAttr(view.title)}" />`
              : cardArtSvg(view))}</div>
          ${raw(view.actions?.length ? `<div class="cs-actions">${view.actions
            .map(
              action =>
                `<button type="button" class="cs-action" data-card-action="${escapeAttr(action.id)}"><span>${escHtml(
                  action.icon
                )}</span>${escHtml(action.label)}</button>`
            )
            .join('')}</div>` : '')}
          ${raw(view.seal ? `<div class="cs-seal">${escHtml(view.seal)}</div>` : '')}
          <h2 class="cs-title">${view.title}</h2>
          ${raw(view.subtitle ? `<div class="cs-en">${escHtml(view.subtitle)}</div>` : '')}
          <div class="cs-rule"></div>
          <p class="cs-desc">${view.desc ?? ''}</p>
          ${raw(facts ? `<ul class="cs-facts">${facts}</ul>` : '')}
        </div>
        <div class="cs-foot">${entry.footer ?? '点击牌堆或场景实体继续'}</div>
      </article>
    `);
    layer.classList.add('open');

    const close = () => this.overlays.close(entry.mode);
    layer.querySelector('.cs-close')?.addEventListener('click', close);
    layer.querySelectorAll<HTMLElement>('[data-card-action]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        const actionId = button.dataset.cardAction;
        close();
        if (actionId) this.performAction(actionId);
      });
    });
    if (this.sheetBackdrop) layer.removeEventListener('click', this.sheetBackdrop);
    this.sheetBackdrop = event => {
      if (event.target === layer) close();
    };
    layer.addEventListener('click', this.sheetBackdrop);
    this.sheetTimer = window.setTimeout(close, entry.reveal ? 7000 : 9000);
  }

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

  /**
   * Discovery moment: a map node the viewer had not seen before has appeared.
   *
   * The generic layer only knows that something new showed up here. What to say
   * about it — a room dossier, a station, a track space — comes from the game
   * presentation hints through the presenter, so no game vocabulary lives in this
   * file and a game that declares none simply gets no cutscene.
   */
  private maybeRevealNode(snapshot: GameSnapshot): void {
    const nodes = Object.values(snapshot.board.mapGraph.nodes);
    if (!this.knownNodes) {
      // First paint: register the opening layout without a cutscene.
      this.knownNodes = new Set(nodes.map(node => node.id));
      return;
    }
    const fresh = nodes.filter(node => !this.knownNodes!.has(node.id));
    for (const node of nodes) this.knownNodes.add(node.id);
    if (fresh.length === 0) return;

    const found = fresh
      .map(node => ({ node, detail: this.presenter.nodeDetail?.(node.id) ?? null }))
      .filter(entry => entry.detail)
      .pop();
    if (!found?.detail) return;

    this.pinnedNodeId = found.node.id;
    this.showCardSheet(found.detail.view, { reveal: found.detail.reveal, footer: found.detail.footer });
  }

  /**
   * Full-screen curtain for a game-declared moment (a reveal, a finale, a vote,
   * a settlement).
   *
   * The HUD keeps only the “already played” bookmark and paints neutral lines: what
   * counts as a new moment, and every word on the curtain, come from
   * GamePresentationHints.describeMoment. A game that declares no moment never
   * gets a curtain, and cannot inherit another game's.
   *
   * A moment may also carry a ledger (one row per seat: cards, made hand, net
   * chips) and buttons. The buttons are capabilities, not vocabulary: the HUD
   * reports which one was pressed to the presenter, and paints it disabled with
   * the presenter's own reason while it is unavailable.
   */
  private maybeShowMoment(): void {
    const moment = this.presenter.moment?.() ?? null;
    if (!moment) {
      // 游戏撤下了幕布（例如结算结束）：正在挂起的幕布要一起收起。
      this.teardownMoment();
      this.lastMomentKey = undefined;
      this.momentArmed = true;
      return;
    }
    if (!this.momentArmed) {
      // Loading a board mid-moment must not replay the curtain.
      this.momentArmed = true;
      this.lastMomentKey = moment.key;
      return;
    }
    // 同一个 key 也要重绘：账本里的「继续下一局」会随冷却从灰变亮，
    // 只在 key 变了才画会让按钮永远停在第一次渲染的样子。
    const signature = `${moment.key}:${(moment.actions ?? [])
      .map(action => `${action.id}${action.enabled ? '1' : '0'}`)
      .join(',')}`;
    if (this.lastMomentKey === signature) return;
    this.lastMomentKey = signature;

    const lockMs = Math.max(0, Number(moment.closeLockMs ?? 0) || 0);
    if (lockMs > 0 && this.momentLockKey !== moment.key) {
      this.momentLockKey = moment.key;
      this.momentLockUntil = Date.now() + lockMs;
    } else if (lockMs <= 0) {
      this.clearMomentLock();
    }
    const locked = this.momentLockUntil > Date.now();

    let layer = this.container.querySelector('#moment-cine') as HTMLElement | null;
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'moment-cine';
      layer.className = 'moment-cine';
      this.container.appendChild(layer);
    }
    if (this.momentClickHandler) layer.removeEventListener('click', this.momentClickHandler);
    const cast = (moment.cast ?? [])
      .map(entry => `<div class="mc-cast">${escHtml(entry.label)} · <b>${escHtml(entry.name)}</b></div>`)
      .join('');
    const ledger = moment.ledger?.length
      ? `<div class="mc-ledger">${moment.ledger
          .map(row => {
            const cards = (row.cards ?? [])
              .map(card => `<span class="mc-card">${escHtml(card)}</span>`)
              .join('');
            const backs = Array.from(
              { length: Math.max(0, row.hidden ?? 0) },
              () => '<span class="mc-card back">🂠</span>'
            ).join('');
            return `
              <div class="mc-row ${escHtml(row.tone ?? 'neutral')}${row.self ? ' self' : ''}">
                <span class="mc-who">
                  <b>${escHtml(row.name)}</b>
                  ${row.tag ? `<i class="mc-tag">${escHtml(row.tag)}</i>` : ''}
                </span>
                <span class="mc-cards">${cards}${backs}</span>
                <span class="mc-detail">${escHtml(row.detail ?? '')}</span>
                <span class="mc-value">${escHtml(row.value ?? '')}</span>
              </div>`;
          })
          .join('')}</div>`
      : '';
    const actionButtons = (moment.actions ?? [])
      .map(
        action => `
          <button type="button" class="mc-btn ${escHtml(action.tone ?? 'normal')}"
                  data-moment-action="${escapeAttr(action.id)}"
                  data-moment-enabled="${action.enabled ? '1' : '0'}"
                  ${action.enabled && !locked ? '' : 'disabled'}
                  title="${escapeAttr(action.hint ?? action.label)}">
            ${escHtml(action.label)}${action.enabled ? '' : `<small>${escHtml(action.hint ?? '')}</small>`}
          </button>`
      )
      .join('');
    const closeButton =
      lockMs > 0
        ? `<button type="button" class="mc-btn mc-close" id="mc-close" data-lock-until="${this.momentLockUntil}"${
            locked ? ' disabled' : ''
          }>${locked ? `${Math.ceil((this.momentLockUntil - Date.now()) / 1000)}s 后可关闭` : '关闭'}</button>`
        : '';
    const buttons =
      actionButtons || closeButton
        ? `<div class="mc-actions">${actionButtons}${closeButton}</div>`
        : '';
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'mc-title');
    setHtml(layer, html`
      <div class="mc-vignette"></div>
      <div class="mc-inner" tabindex="-1">
        <div class="mc-live" aria-live="assertive" aria-atomic="true">${moment.title}</div>
        ${raw(moment.kicker ? `<div class="mc-kicker">${escHtml(moment.kicker)}</div>` : '')}
        ${raw(moment.caption ? `<div class="mc-caption">${escHtml(moment.caption)}</div>` : '')}
        <h1 class="mc-title" id="mc-title">${moment.title}</h1>
        <div class="mc-rule"></div>
        ${raw(moment.story ? `<p class="mc-story">${escHtml(moment.story)}</p>` : '')}
        ${raw(cast)}
        ${raw(ledger)}
        ${raw(moment.objective ? `<p class="mc-objective">${escHtml(moment.objective)}</p>` : '')}
        ${raw(buttons || '<div class="mc-hint">点击任意处继续</div>')}
      </div>
    `);
    layer.classList.add('open');
    layer.classList.toggle('locked', locked);
    // a11y：把焦点移进幕布，并在幕布内循环 Tab；关闭时还原（issue #194）。
    this.momentReturnFocus = (document.activeElement as HTMLElement | null) ?? null;
    if (this.momentKeyHandler) layer.removeEventListener('keydown', this.momentKeyHandler);
    this.momentKeyHandler = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusables = Array.from(
        layer!.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      ).filter(node => node.getClientRects().length > 0);
      // 锁定期间按钮全 disabled，此时把焦点钉在幕布容器上，Tab 也不能跑出去。
      if (focusables.length === 0) {
        event.preventDefault();
        (layer!.querySelector('.mc-inner') as HTMLElement | null)?.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !layer!.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    layer.addEventListener('keydown', this.momentKeyHandler);
    const firstEnabled = layer.querySelector<HTMLElement>('[data-moment-action]:not([disabled])');
    (firstEnabled ?? layer.querySelector<HTMLElement>('.mc-inner'))?.focus();

    const onLayerClick = (event: Event) => {
      // 锁定期间连遮罩与按钮一起吞掉：关闭只能由倒计时结束或游戏撤销幕布
      // 触发，避免玩家在结果出来的一瞬间误触跳过。
      if (this.momentLockUntil > Date.now()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-moment-action]');
      if (button) {
        // 按钮自己派发能力；点空白处仍然只是收起幕布。
        event.stopPropagation();
        if (button.hasAttribute('disabled')) return;
        const result = this.presenter.performMomentAction?.(button.dataset.momentAction ?? '');
        if (result && !result.ok) {
          this.pushToast('⚠️', result.error ?? '该动作现在不可用');
          return;
        }
      }
      this.closeMoment();
    };
    this.momentClickHandler = onLayerClick;
    layer.addEventListener('click', onLayerClick);
    this.startMomentLockCountdown(layer, lockMs);

    if (this.momentTimer) window.clearTimeout(this.momentTimer);
    // hold 的幕布不自动消失：等游戏自己撤下，或玩家点一下。普通幕布若设了
    // 关闭锁，自动消失也不得早于锁的结束。
    if (!moment.hold) {
      const delay = Math.max(moment.durationMs ?? 9000, this.momentLockUntil - Date.now(), 0);
      this.momentTimer = window.setTimeout(() => this.closeMoment(), delay);
    }
  }

  /** Tear down the curtain even if a close-lock is still running (game state moved on). */
  private teardownMoment(): void {
    const layer = this.container.querySelector('#moment-cine') as HTMLElement | null;
    if (layer) {
      if (this.momentClickHandler) layer.removeEventListener('click', this.momentClickHandler);
      if (this.momentKeyHandler) layer.removeEventListener('keydown', this.momentKeyHandler);
      layer.classList.remove('open', 'locked');
      layer.replaceChildren();
      layer.removeAttribute('aria-modal');
      layer.removeAttribute('aria-labelledby');
    }
    this.momentKeyHandler = undefined;
    const back = this.momentReturnFocus;
    this.momentReturnFocus = null;
    if (back && document.contains(back)) back.focus();
    this.momentClickHandler = undefined;
    if (this.momentTimer) {
      window.clearTimeout(this.momentTimer);
      this.momentTimer = null;
    }
    this.clearMomentLock();
  }

  private clearMomentLock(): void {
    if (this.momentLockTimer !== null) {
      window.clearInterval(this.momentLockTimer);
      this.momentLockTimer = null;
    }
    this.momentLockKey = undefined;
    this.momentLockUntil = 0;
  }

  /** Close the curtain if it exists and is past its lock; false while locked. */
  private closeMoment(): boolean {
    const layer = this.container.querySelector('#moment-cine') as HTMLElement | null;
    if (!layer?.classList.contains('open')) return false;
    if (this.momentLockUntil > Date.now()) return false;
    this.teardownMoment();
    return true;
  }

  /**
   * The lock countdown is wall-clock, not a CSS animation: it must keep ticking
   * under `prefers-reduced-motion: reduce`. The close button and every moment
   * action stay disabled until the last second has elapsed.
   */
  private startMomentLockCountdown(layer: HTMLElement, lockMs: number): void {
    if (lockMs <= 0) return;
    if (this.momentLockTimer !== null) window.clearInterval(this.momentLockTimer);
    const tick = () => {
      const left = Math.max(0, this.momentLockUntil - Date.now());
      const locked = left > 0;
      const close = layer.querySelector<HTMLButtonElement>('#mc-close');
      if (close) {
        close.disabled = locked;
        close.textContent = locked ? `${Math.ceil(left / 1000)}s 后可关闭` : '关闭';
      }
      layer.classList.toggle('locked', locked);
      layer.querySelectorAll<HTMLButtonElement>('[data-moment-action]').forEach(button => {
        const enabled = button.dataset.momentEnabled === '1';
        button.disabled = locked || !enabled;
        button.classList.toggle('is-locked', locked && enabled);
      });
      if (!locked) {
        if (this.momentLockTimer !== null) window.clearInterval(this.momentLockTimer);
        this.momentLockTimer = null;
      }
    };
    tick();
    if (this.momentLockUntil > Date.now()) {
      this.momentLockTimer = window.setInterval(tick, 250);
    }
  }

  private syncSoundButton(): void {
    const button = this.container.querySelector('#btn-audio') as HTMLElement | null;
    if (!button) return;
    const on = this.ports.isSoundOn();
    button.classList.toggle('active', on);
    const glyph = button.querySelector<HTMLElement>('.ico-glyph');
    if (glyph) glyph.textContent = on ? '♪' : '✕';
    else button.textContent = on ? '♪' : '✕';
    button.setAttribute('aria-label', on ? '关闭音效' : '开启音效');
  }

  /** 阶段二：设置在线玩家并刷新玩家卡在线点（未知 playerId 视为离线）。 */
  public setOnlinePlayers(playerIds: string[]): void {
    this.onlinePlayerIds = new Set(playerIds);
    if (this.latest) this.renderPlayers(this.latest);
  }

  private renderSkeleton(): void {
    this.container.classList.add('app-shell');
    // Shadow unified hand is opt-in until P7 swaps the legacy dock out.
    this.actionHandEnabled = new URLSearchParams(window.location.search).has('unified-hand');
    this.container.dataset.hand = this.actionHandEnabled ? 'unified' : 'legacy';
    this.ports.setOwnHandVisible?.(!this.actionHandEnabled);
    setHtml(this.container, html`
      <header class="topbar">
        <button class="shell-toggle menu-btn" data-toggle="menu" aria-label="主菜单" aria-haspopup="dialog" aria-controls="menu-dialog" aria-expanded="false"><span class="menu-bars" aria-hidden="true"><span></span><span></span><span></span></span></button>

        <nav class="game-switch" id="game-switch">
          ${raw(GAME_TABS.map(
            tab => `
            <button class="game-pill" data-game="${tab.id}">
              <span class="gp-ico">${tab.icon}</span><span>${tab.name}</span>
            </button>
          `
          ).join(''))}
        </nav>

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
          <button class="icon-btn" id="btn-audio" aria-label="音效"><span class="ico-glyph">♪</span><span class="tip">音效开关</span></button>
          <button class="icon-btn" id="btn-inspector" aria-label="数学模型">𝒢<span class="tip">内核检查器 · I</span></button>
          <button class="icon-btn" id="btn-diagnostics" aria-label="导出诊断日志">⤓<span class="tip">导出诊断日志（问题反馈用）</span></button>
          <button class="icon-btn" id="btn-shortcuts" aria-label="快捷键清单" aria-keyshortcuts="?" aria-haspopup="dialog" aria-controls="shortcut-layer">⌨<span class="tip">快捷键清单 · ?</span></button>
          <button class="icon-btn" id="btn-about" aria-label="关于">ⓘ<span class="tip">关于 · 版本信息</span></button>
          <button class="shell-toggle panel-toggle" data-toggle="rail" aria-label="展开角色栏">⤢ 展开角色栏</button>
          <button class="shell-toggle panel-toggle" data-toggle="side" aria-label="展开信息栏">▤ 展开信息栏</button>
        </div>
      </header>

      <aside class="player-rail" id="player-rail" aria-label="角色栏">
        <div class="drawer-head" data-drawer-head="rail">
          <span class="drawer-title" id="drawer-rail-title">角色栏</span>
          <button class="drawer-close" type="button" data-drawer-close="rail" aria-label="关闭角色栏">✕</button>
        </div>
      </aside>
      <!-- Right-hand panels share one column so they stack instead of
           overlapping; each used to be absolutely positioned with a
           hand-computed top offset. -->
      <div class="side-column" id="side-column" aria-label="信息栏">
        <div class="drawer-head" data-drawer-head="side">
          <span class="drawer-title" id="drawer-side-title">信息栏</span>
          <button class="drawer-close" type="button" data-drawer-close="side" aria-label="关闭信息栏">✕</button>
        </div>
        <div class="side-panel-extras" id="side-panel-extras"></div>
        <!-- Edition picker: only shown when the game ships several rule sets,
             so a single-variant fixture keeps the column unchanged. -->
        <aside class="room-card" id="room-card" style="display:none"></aside>
        <aside class="mansion-minimap" id="mansion-minimap" style="display:none"></aside>
        <!-- Ranking and recent activity share one card with two tabs, at every
             width. The observer rail stays an independent panel. -->
        <div class="side-tabs" id="side-tabs" data-side-tab="ranking">
          <div class="side-tablist" role="tablist" aria-label="排行榜与近期动态">
            <button class="side-tab" type="button" role="tab" id="side-tab-ranking" aria-controls="chip-ranking" aria-selected="true" data-side-tab-target="ranking">排行榜</button>
            <button class="side-tab" type="button" role="tab" id="side-tab-feed" aria-controls="activity-feed" aria-selected="false" data-side-tab-target="feed">近期动态</button>
          </div>
          <aside class="chip-ranking" id="chip-ranking" role="tabpanel" aria-labelledby="side-tab-ranking" style="display:none"></aside>
          <aside class="activity-feed" id="activity-feed" role="tabpanel" aria-labelledby="side-tab-feed"></aside>
        </div>
        <!-- 观察席：输光但仍在房间里的牌手，等低保 / 等轮末回桌 -->
        <aside class="observer-rail" id="observer-rail" aria-label="观察席" style="display:none"></aside>
      </div>
      <div class="action-dock" id="action-dock"></div>
      <aside class="hand-slot" id="hand-slot" role="button" tabindex="0" aria-label="手持出牌区">
        <svg class="hs-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="hs-ring-track" cx="50" cy="50" r="47"></circle>
          <circle class="hs-ring-fill" cx="50" cy="50" r="47" pathLength="100"></circle>
        </svg>
        <div class="hs-stage"></div>
      </aside>
      <!-- Unified action hand: shadow render, off unless ?unified-hand. -->
      <aside class="action-hand" id="action-hand" data-enabled="0" aria-hidden="true" aria-label="动作手牌"></aside>
      <!-- 翻页器：>1 页才出现。手牌不横向滚动，翻页与拖拽不抢同一个手势轴。 -->
      <div class="hand-pager" id="hand-pager" role="group" aria-label="手牌翻页" hidden>
        <button class="hp-btn" type="button" data-page-step="-1" aria-label="上一页">‹</button>
        <span class="hp-label" id="hand-pager-label" aria-live="polite">1 / 1</span>
        <button class="hp-btn" type="button" data-page-step="1" aria-label="下一页">›</button>
      </div>
      <div class="announcement-banner" id="announce" style="display:none"></div>
      <div class="payload-layer" id="payload-layer" style="display:none"></div>
      <div class="shell-scrim" data-shell-scrim aria-hidden="true"></div>
    `);

    // Tablet/phone slide-overs. Only one panel is open at a time so the board
    // is never covered by two overlays.
    this.applyShellLayout();
    this.syncShellAria();
    this.syncShellInert();
    this.notifyViewportInsets();
    window.addEventListener('resize', () => this.applyShellLayout());
    this.shellMedia = window.matchMedia('(max-width: 767px)');
    this.shellMedia.addEventListener('change', () => this.applyShellLayout());

    this.container.addEventListener('click', event => {
      const target = event.target as HTMLElement | null;
      const close = target?.closest<HTMLElement>('[data-drawer-close]');
      if (!close) return;
      const which = close.dataset.drawerClose === 'rail' ? 'rail' : 'side';
      this.closeDrawer(which, true);
    });
    this.container.querySelector('[data-shell-scrim]')?.addEventListener('click', () => {
      const which = this.openDrawerWhich();
      if (which) this.closeDrawer(which, true);
    });
    // Probes and URL/debug tooling can remove [data-rail] directly. Re-sync so
    // a stale `inert` cannot leave the topbar unclickable.
    this.shellObserver = new MutationObserver(() => {
      this.syncShellAria();
      this.syncShellInert();
      this.notifyViewportInsets();
    });
    this.shellObserver.observe(this.container, {
      attributes: true,
      attributeFilter: ['data-rail', 'data-side']
    });

    // Escape closes the centered menu first, then any slide-over. Tab stays
    // inside the active modal surface, and focus returns to its opener.
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const moment = this.container.querySelector('#moment-cine.open');
        if (moment) {
          // A locked settlement curtain swallows Esc just like it swallows
          // backdrop and button clicks; once unlocked Esc closes it normally.
          event.preventDefault();
          event.stopPropagation();
          this.closeMoment();
          return;
        }
        if (this.container.querySelector('#shortcut-layer')) {
          event.preventDefault();
          this.closeShortcutHelp();
          return;
        }
        if (this.menuOpen) {
          event.preventDefault();
          this.closeMenu(true);
          return;
        }
        const which = this.openDrawerWhich();
        if (which) {
          this.closeDrawer(which, true);
          event.preventDefault();
        }
        return;
      }
      if (event.key === 'Tab') {
        if (this.menuOpen) this.trapMenuFocus(event);
        else this.trapDrawerFocus(event);
      }
    });

    // The ☰ button is the only topbar control. Its dialog reuses the existing
    // payload modal layer and temporarily moves the real controls inside, so
    // listeners and current state survive the trip.
    const menuButton = this.container.querySelector('[data-toggle="menu"]') as HTMLElement | null;
    menuButton?.addEventListener('click', event => {
      event.stopPropagation();
      if (this.menuOpen) this.closeMenu(true);
      else this.openMenu(menuButton);
    });

    this.container.querySelectorAll<HTMLElement>('[data-toggle="rail"], [data-toggle="side"]').forEach(button => {
      button.addEventListener('click', () => {
        const which = button.dataset.toggle === 'rail' ? 'rail' : 'side';
        if (!this.isOverlayShell()) {
          // Desktop keeps its persistent panels: the same menu entry expands
          // them in place instead of opening a drawer.
          const panel = this.drawerFor(which);
          if (!panel) return;
          const expanded = panel.getAttribute('data-expanded') === '1';
          if (expanded) panel.removeAttribute('data-expanded');
          else panel.setAttribute('data-expanded', '1');
          this.syncShellAria();
          requestAnimationFrame(() => {
            this.syncRailExpandedGeometry();
            const rail = this.container.querySelector('#player-rail') as HTMLElement | null;
            if (rail) this.layoutPlayerRail(rail);
          });
          return;
        }
        const isOpen = this.container.getAttribute(which === 'rail' ? 'data-rail' : 'data-side') === 'open';
        if (isOpen) this.closeDrawer(which, true);
        else this.openDrawer(which, this.menuOpen ? this.menuOpener : button);
      });
    });

    this.container.querySelectorAll<HTMLElement>('[data-side-tab-target]').forEach(button => {
      button.addEventListener('click', () => {
        const tab = button.dataset.sideTabTarget;
        if (tab !== 'ranking' && tab !== 'feed') return;
        this.sideTab = tab;
        this.sideTabTouched = true;
        this.applySideTab();
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

    // 观察席「重新上桌」：面板每次重绘都会换掉行，所以在容器上做事件委托。
    this.container.querySelector('#observer-rail')?.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest('.ob-join') as HTMLElement | null;
      if (!button) return;
      const playerId = button.dataset.ob;
      if (!playerId) return;
      const result = this.presenter.rejoinTable?.(playerId);
      if (!result) return;
      if (!result.ok) {
        this.pushToast('⚠️', result.error ?? '暂时还不能上桌');
        return;
      }
      this.pushToast('🪑', '已申请重新上桌 · 本轮结束后落座');
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

    this.container.querySelector('#hand-pager')?.addEventListener('click', event => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-page-step]');
      if (!button) return;
      this.actionHand?.stepPage(Number(button.dataset.pageStep) || 0);
    });

    this.container.querySelector('#btn-shortcuts')?.addEventListener('click', () => {
      this.toggleShortcutHelp();
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

    const handSlot = this.container.querySelector('#hand-slot') as HTMLElement | null;
    if (handSlot) this.bindHandSlot(handSlot);
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
    this.maybeHintShortcuts();
    this.container.dataset.theme = snapshot.gameId === 'betrayal' ? 'gothic' : '';
    // Placement is a board mode, not an action list: the legacy dock owns its
    // rotate/confirm panel, so unified mode must leave that panel visible.
    this.container.dataset.placement = snapshot.placement ? '1' : '0';
    this.container.querySelectorAll<HTMLElement>('.game-pill').forEach(button => {
      button.classList.toggle('active', button.dataset.game === snapshot.gameId);
    });

    this.renderViewerSelect(snapshot);
    this.renderScenarioSelect(snapshot);
    this.renderPlayers(snapshot);
    this.renderRoomCard(snapshot);
    this.renderMinimap(snapshot);
    this.renderChipRanking(snapshot);
    // 首次进入扑克桌面时先拉一次全服数据：页签要能立刻切，不用等点击。
    if (snapshot.chipRanking?.length && !this.accountRanking) this.refreshAccountRanking();
    this.renderObservers(snapshot);
    this.renderHistory(snapshot);
    this.reconcileHeldAction(snapshot.actions);
    this.renderDock(snapshot);
    this.renderHandSlot(snapshot);
    this.renderActionHand(snapshot);
    this.maybeRevealNode(snapshot);
    this.maybeShowMoment();
  }

  /**
   * Architectural vector minimap for Betrayal: shows all three floors
   * (2F Upper, 1F Ground, B Basement) as a vertical cutaway slice with real room
   * layout, player position dots, and viewport isolation indicator.
   */
  private renderMinimap(snapshot: GameSnapshot): void {
    const el = this.container.querySelector('#mansion-minimap') as HTMLElement | null;
    if (!el) return;
    // The overview exists for any game that declares map floors; which floors
    // there are, their names and tab tags are all game declarations.
    const spatial = snapshot.spatial;
    if (!spatial || spatial.floors.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.classList.toggle('collapsed', this.minimapCollapsed);

    // Ordered top-down like an elevation drawing; the level tag is the game's
    // short label, falling back to the full floor name.
    const floors = [...spatial.floors]
      .sort((a, b) => b.index - a.index)
      .map(f => ({ id: f.id, level: f.tag ?? f.name, name: f.name }));

    const isAll = this.selectedFloor === 'ALL';
    const actorRoomId = spatial.activeNodeId ?? '';
    const actorRoom = snapshot.board.mapGraph.nodes[actorRoomId];
    const actorFloor = String(actorRoom?.layer ?? actorRoom?.props?.floor ?? '');

    const floorItems = floors.map(floor => {
      const rooms = Object.values(snapshot.board.mapGraph.nodes).filter(
        n => n.type === 'ROOM' && String(n.layer ?? n.props?.floor ?? '') === floor.id
      );

      // Players on this floor: the game says which node each one stands on.
      const playersOnFloor = Object.values(snapshot.board.players).filter(p => {
        if (!p.alive) return false;
        const r = snapshot.board.mapGraph.nodes[this.presenter.playerNodeId?.(p.id) ?? ''];
        return String(r?.layer ?? r?.props?.floor ?? '') === floor.id;
      });

      // Non-player cast members (monsters) on this floor, game-declared.
      const monstersOnFloor = (this.presenter.castMembers?.() ?? []).filter(cast => {
        const r = snapshot.board.mapGraph.nodes[cast.nodeId];
        return String(r?.layer ?? r?.props?.floor ?? '') === floor.id;
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
          const isPinned = this.pinnedNodeId === r.id;

          const herePlayers = playersOnFloor.filter(p => (this.presenter.playerNodeId?.(p.id) ?? '') === r.id);
          const hereMonsters = monstersOnFloor.filter(cast => cast.nodeId === r.id);

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
          <span class="mm-label">${escHtml(spatial.title ?? '地图总览')}</span>
        </div>
        <div class="mm-controls">
          <button class="mm-btn-all ${isAll ? 'active' : ''}" data-floor="ALL" type="button" title="查看全部楼层">全部</button>
          <button class="mm-btn-toggle" id="mm-toggle" type="button" title="折叠/展开小地图">${this.minimapCollapsed ? '▸' : '▾'}</button>
        </div>
      </div>
      <div class="mm-body">
        ${floorItems}
      </div>
    `;

    const minimapSig = hash(minimapHtml);
    if (el.dataset.sig !== minimapSig) {
      setHtml(el, raw(minimapHtml));
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
   * glance separates damage from movement, cards and story beats.
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

  /** Floor display name from the game-declared topology layers. */
  private floorNameOf(floorId: string, snapshot: GameSnapshot): string {
    const floors = snapshot.spatial?.floors ?? [];
    return floors.find(f => f.id === floorId)?.name ?? floorId;
  }

  /** Badge text for a game token (room symbol); unknown tokens print as-is. */
  private tokenBadgeOf(token: unknown): string {
    const key = String(token ?? '');
    if (!key) return '';
    const badge = this.presenter.tokenBadge?.(key);
    return badge ? (badge.glyph ? badge.glyph + ' ' : '') + badge.label : key;
  }

  private rollLabel(roll: NonNullable<GameSnapshot['lastRoll']>): string {
    const trait = roll.trait ? this.presenter.traitLabel?.(roll.trait) ?? roll.trait : '';
    const source = roll.label?.trim();
    if (source && trait) return `${source} · ${trait}检定`;
    if (source) return source;
    return trait ? `${trait}检定` : '检定';
  }

  /**
   * 筹码排行面板（德州扑克）。
   *
   * 两个页签回答两个不同的问题，所以不合成一张表：
   *  - **本桌**：这一桌谁筹码多（引擎投影，逐手刷新）；
   *  - **全服**：每个账号一共还有多少筹码、打得怎么样（服务端账本）。
   *
   * 全服数据不在快照里逐帧推送：打开面板、或点页签时才向 presenter 拉一次，
   * 结果缓存在 `accountRanking`。单机模式拿不到（presenter 返回 undefined），
   * 于是只剩本桌页签——不出现一个永远空着的「全服」。
   */
  private renderChipRanking(snapshot: GameSnapshot): void {
    const panel = this.container.querySelector('#chip-ranking') as HTMLElement | null;
    if (!panel) return;
    const rows = snapshot.chipRanking;
    if (!rows || rows.length === 0) {
      panel.style.display = '';
      if (panel.dataset.signature !== 'empty') {
        panel.dataset.signature = 'empty';
        setHtml(panel, html`
          <div class="cr-head">
            <span class="cr-title">排行榜</span>
            <span class="cr-total">—</span>
          </div>
          <div class="cr-empty">本局暂无排行榜数据</div>
        `);
      }
      if (!this.sideTabTouched && this.sideTab === 'ranking') {
        this.sideTab = 'feed';
        this.applySideTab();
      }
      return;
    }
    panel.style.display = '';

    // 页签存在与否只看「这个会话有没有全服数据源」，不看这一次拉取成没成功：
    // 断线时拉取会失败，但玩家仍应能切到「全服」看到说明并重试。
    const hasGlobal = this.accountRanking !== undefined || this.hasAccountRanking;
    const accounts = this.accountRanking?.accounts ?? [];
    const tab = hasGlobal ? this.rankingTab : 'table';
    const signature = `${tab}|${hasGlobal ? 1 : 0}|${rows
      .map(row => `${row.playerId}:${row.chips}`)
      .join('|')}|${this.accountRanking?.updatedAt ?? ''}`;
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;

    const total = rows.reduce((sum, row) => sum + row.chips, 0);
    const tableBody = rows
      .map((row, index) => {
        const percent = (row.share * 100).toFixed(1);
        const isSelf = row.playerId === snapshot.viewer;
        const tag = row.isAi
          ? `<span class="cr-tag ai">${escHtml(row.tierLabel ?? 'AI')}</span>`
          : `<span class="cr-tag human">真人</span>`;
        return `
          <div class="cr-row${isSelf ? ' self' : ''}" title="${escHtml(row.name)} · ${row.chips} 筹码">
            <span class="cr-rank">${index + 1}</span>
            <span class="cr-name">${escHtml(row.name)}${tag}</span>
            <span class="cr-chips">${row.chips}</span>
            <span class="cr-pct">${percent}%</span>
            <span class="cr-bar"><i style="width:${Math.max(2, row.share * 100).toFixed(1)}%"></i></span>
          </div>`;
      })
      .join('');

    const accountBody = accounts
      .map((row, index) => {
        const percent = (row.share * 100).toFixed(1);
        const tag = row.isAi
          ? `<span class="cr-tag ai">AI 名将</span>`
          : `<span class="cr-tag human">真人</span>`;
        const playing = row.roomId
          ? `<span class="cr-tag human" title="正在 ${escHtml(row.roomId)} 的 ${escHtml(row.seat ?? '')} 座位">在桌</span>`
          : '';
        const parts = row.avatarUrl
          ? `<img class="ar-avatar" src="${escapeAttr(row.avatarUrl)}" alt="" loading="lazy" />`
          : `<span class="ar-avatar ${row.isAi ? 'ar-avatar-ai' : 'ar-avatar-fallback'}">${escHtml(row.name.slice(0, 1).toUpperCase())}</span>`;
        return `
          <button type="button" class="cr-row ar-row" data-rank-user="${escapeAttr(row.userId)}" title="${escHtml(row.name)} · 点开生涯战绩">
            <span class="cr-rank">${index + 1}</span>
            <span class="cr-name">${parts}${escHtml(row.name)}${tag}${playing}</span>
            <span class="cr-chips">${row.chips}</span>
            <span class="cr-pct">${percent}%</span>
            <span class="cr-bar"><i style="width:${Math.max(2, row.share * 100).toFixed(1)}%"></i></span>
          </button>`;
      })
      .join('');

    const tabs = hasGlobal
        ? `<div class="cr-tabs" role="tablist">
             <button type="button" class="cr-tab${tab === 'table' ? ' on' : ''}" data-rank-tab="table" role="tab" aria-selected="${tab === 'table'}">本桌</button>
             <button type="button" class="cr-tab${tab === 'global' ? ' on' : ''}" data-rank-tab="global" role="tab" aria-selected="${tab === 'global'}">全服</button>
           </div>`
        : '';

    setHtml(panel, html`
      <div class="cr-head">
        <span class="cr-title">筹码排行</span>
        <span class="cr-total">${raw(tab === 'table' ? total : this.accountRanking?.rooms ?? 0)} ${raw(tab === 'table' ? '' : '桌')}</span>
      </div>
      ${raw(tabs)}
      <div class="cr-body">${raw(tab === 'table'
          ? tableBody
          : accountBody ||
            `<div class="cr-empty">${this.accountRanking ? '还没有账号战绩' : '读取全服排行失败 · 点「全服」重试'}</div>`)}</div>
      <div class="cr-foot">${raw(tab === 'table'
          ? '占比 = 该玩家筹码 / 全桌总筹码'
          : '占比 = 该账号筹码 / 全服总筹码 · 点击查看生涯战绩')}</div>
    `);
  }

  /** 打开全服页签时拉一次数据；失败就沉默保留本桌视图。 */
  private refreshAccountRanking(): void {
    const fetchRanking = this.presenter.fetchAccountRanking;
    this.hasAccountRanking = !!fetchRanking;
    if (!fetchRanking) return;
    if (this.accountRankingPending) return;
    this.accountRankingPending = true;
    void fetchRanking
      .call(this.presenter)
      .then(ranking => {
        this.accountRanking = ranking;
        // 数据到货后强制重画：签名里带着 updatedAt，无需手动清空。
        if (this.latest) this.renderChipRanking(this.latest);
      })
      .catch(() => {
        this.accountRanking = undefined;
      })
      .finally(() => {
        this.accountRankingPending = false;
      });
  }

  /**
   * 观察席卡片：谁输光了、还剩多少筹码、下一笔低保什么时候到、有没有在排队
   * 等回桌。卡片只画数据，能不能回桌由 `canRejoin`（引擎的合法动作）决定。
   */
  private renderObservers(snapshot: GameSnapshot): void {
    const panel = this.container.querySelector('#observer-rail') as HTMLElement | null;
    if (!panel) return;
    const rows = snapshot.observers ?? [];
    if (rows.length === 0) {
      panel.style.display = 'none';
      panel.dataset.signature = '';
      this.observerRows = [];
      return;
    }
    panel.style.display = '';
    const signature = rows
      .map(row => `${row.playerId}:${row.chips}:${row.pendingLabel ?? ''}:${row.canRejoin}:${row.stipendInSeconds}:${row.stipendAmount}`)
      .join('|');
    if (panel.dataset.signature === signature) return;
    panel.dataset.signature = signature;

    const body = rows
      .map(row => {
        const self = row.playerId === snapshot.viewer ? ' self' : '';
        const meta = row.pendingLabel
          ? `<span class="ob-wait">等本轮结束 · ${escHtml(row.pendingLabel)}</span>`
          : `<span class="ob-low" data-ob-low="${escHtml(row.playerId)}">下笔低保 ${row.stipendInSeconds}s · 每次 +${row.stipendAmount}</span>`;
        const join =
          row.canRejoin && !row.pendingLabel
            ? `<button class="ob-join" data-ob="${escHtml(row.playerId)}">重新上桌</button>`
            : '';
        return `
          <div class="ob-row${self}">
            <span class="ob-name">${escHtml(row.name)}</span>
            <span class="ob-chips">${row.chips}</span>
            ${meta}
            ${join}
          </div>`;
      })
      .join('');

    setHtml(panel, html`
      <div class="ob-head">
        <span class="ob-title">观察席</span>
        <span class="ob-count">${raw(rows.length)}</span>
      </div>
      <div class="ob-body">${raw(body)}</div>
      <div class="ob-foot">输光不散场：座位由 AI 接手，攒够买入即可申请回桌（轮末生效）</div>
    `);
    this.startObserverTicker(rows);
  }

  /**
   * 低保倒计时按本地秒数走：快照只在心跳（20 秒一拍）时更新，直接显示快照里的
   * 秒数会一跳 20 秒，看着像坏了。这里只做减法，真正发筹码仍在引擎里。
   */
  private startObserverTicker(rows: UiObserver[]): void {
    this.observerRows = rows;
    this.observerAnchor = Date.now();
    if (this.observerTimer !== null) return;
    this.observerTimer = window.setInterval(() => {
      if (this.observerRows.length === 0) return;
      const elapsed = Math.floor((Date.now() - this.observerAnchor) / 1000);
      const panel = this.container.querySelector('#observer-rail');
      if (!panel) return;
      for (const row of this.observerRows) {
        const node = panel.querySelector(`[data-ob-low="${row.playerId}"]`);
        if (!node) continue;
        const left = Math.max(0, row.stipendInSeconds - elapsed);
        node.textContent = `下笔低保 ${left}s · 每次 +${row.stipendAmount}`;
      }
    }, 1000);
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
      setHtml(feed, html`
        <button class="af-head" id="af-toggle" type="button" title="展开 / 收起近期记录">
          <span class="af-title">近期动态</span>
          <span class="af-count"></span>
          <span class="af-caret"></span>
        </button>
        <div class="af-body"></div>
      `);
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
      setHtml(body, raw('<div class="af-empty">尚无记录，行动后会在这里留下痕迹</div>'));
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
      const floorLabel = this.floorNameOf(String(placement.floor ?? ''), snapshot);
      const symbolBadge = this.tokenBadgeOf(placement.symbol) || '· 无符号';

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
      setHtml(card, html`
        <div class="rc-head">
          <span class="rc-floor">[待定放置] ${raw(floorLabel)}</span>
          <span class="rc-angle">${raw(placement.rotation * 90)}°</span>
        </div>
        <div class="rc-title">${raw(placement.name)}</div>
        ${raw(placement.en ? `<div class="rc-en">${placement.en}</div>` : '')}
        <div class="rc-meta">
          <div class="rc-compass">${raw(compass)}</div>
          <div class="rc-symbol">${raw(symbolBadge)}</div>
        </div>
        <p class="rc-text">${raw(placement.text ?? '探索发现的新房间，请选择朝向确认放置。')}</p>
        <div class="rc-occupants">${raw(connChips)}</div>
      `);
      return;
    }

    const focusId = snapshot.focus[0] ?? snapshot.viewer;
    const actorRoomId = this.presenter.playerNodeId?.(focusId) ?? '';

    // Following the active actor is the default; a explicit room click pins the
    // dossier until the actor moves somewhere else.
    if (actorRoomId !== this.lastActorRoomId) {
      this.lastActorRoomId = actorRoomId;
      this.pinnedNodeId = undefined;
    }
    const pinnedNode = this.pinnedNodeId ? board.mapGraph.nodes[this.pinnedNodeId] : undefined;
    const roomId = pinnedNode && pinnedNode.type === 'ROOM' ? this.pinnedNodeId! : actorRoomId;
    const node = roomId ? board.mapGraph.nodes[roomId] : undefined;

    if (!node || node.type !== 'ROOM') {
      card.style.display = 'none';
      card.dataset.signature = '';
      return;
    }

    const props = (node.props ?? {}) as Record<string, unknown>;
    const doors = Array.isArray(props.doors) ? (props.doors as string[]) : [];
    const floorLabel = this.floorNameOf(String(node.layer ?? props.floor ?? ''), snapshot);
    const occupants = Object.values(board.players).filter(
      p => p.alive && (this.presenter.playerNodeId?.(p.id) ?? '') === roomId
    );
    const monsters = (this.presenter.castMembers?.() ?? []).filter(cast => cast.nodeId === roomId);
    const loot = this.presenter.roomLoot?.(roomId) ?? null;

    const signature = `${roomId}|${doors.join('')}|${occupants.map(p => p.id).join(',')}|${monsters.length}|${loot?.count ?? 0}`;
    if (card.dataset.signature === signature) return;
    card.dataset.signature = signature;

    const compass = ['N', 'E', 'S', 'W']
      .map(dir => `<span class="rc-door ${doors.includes(dir) ? 'on' : ''}">${dir}</span>`)
      .join('');

    const ppl = occupants
      .map(p => {
        const role = this.presenter.roleLabel?.(String(p.role ?? '')) ?? '';
        const tag = role ? ` · ${escHtml(role)}` : '';
        return `<span class="rc-chip" style="--chip:${escHtml(p.color)}"><i></i>${escHtml(p.name)}${tag}</span>`;
      })
      .join('');
    const mobs = monsters
      .map(m => `<span class="rc-chip monster"><i></i>${escHtml(m.label)}</span>`)
      .join('');
    const items = loot ? `<span class="rc-chip loot"><i></i>${escHtml(loot.label)} ×${loot.count}</span>` : '';

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
        <div class="rc-symbol">${escHtml(this.tokenBadgeOf(props.symbol) || '· 无事')}</div>
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
      setHtml(card, raw(dossierHtml));
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

    const floorLabel = this.floorNameOf(String(node.layer ?? props.floor ?? ''), snapshot);
    const compass = ['N', 'E', 'S', 'W']
      .map(dir => `<span class="rc-door ${doors.includes(dir) ? 'on' : ''}">${dir}</span>`)
      .join('');

    const occupants = Object.values(snapshot.board.players).filter(
      p => p.alive && (this.presenter.playerNodeId?.(p.id) ?? '') === roomId
    );
    const monsters = (this.presenter.castMembers?.() ?? []).filter(cast => cast.nodeId === roomId);
    const loot = this.presenter.roomLoot?.(roomId) ?? null;

    const chips =
      occupants.map(p => `<span class="rc-chip" style="--chip:${escHtml(p.color)}"><i></i>${escHtml(p.name)}</span>`).join('') +
      monsters
        .map(m => `<span class="rc-chip monster"><i></i>${escHtml(m.label)}</span>`)
        .join('') +
      (loot ? `<span class="rc-chip loot"><i></i>${escHtml(loot.label)} ×${loot.count}</span>` : '');

    setHtml(layer, html`
      <div class="payload-backdrop"></div>
      <div class="payload-card room-card-window">
        <header class="rc-head">
          <span class="rc-floor">${raw(floorLabel)}</span>
          <button type="button" class="pf-btn" id="rcw-close">关闭</button>
        </header>
        <div class="rc-title">${raw(String(props.name ?? '房间'))}</div>
        <div class="rc-en">${raw(String(props.en ?? ''))}</div>
        <div class="rc-meta">
          <div class="rc-compass">${raw(compass)}</div>
          <div class="rc-symbol">${this.tokenBadgeOf(props.symbol) || '· 无符号'}</div>
        </div>
        <p class="rc-text">${raw(String(props.text ?? ''))}</p>
        <div class="rc-occupants">${raw(chips || '<span class="rc-empty">空无一人</span>')}</div>
      </div>
    `);
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.replaceChildren();
    };
    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#rcw-close')?.addEventListener('click', close);
  }

  private renderViewerSelect(snapshot: GameSnapshot): void {
    const select = this.container.querySelector('#viewer-select') as HTMLSelectElement | null;
    if (!select) return;

    const signature = snapshot.viewers.map(v => `${v.id}:${v.name}`).join('|');
    if (select.dataset.signature !== signature) {
      setHtml(select, raw(snapshot.viewers
        .map(viewer => `<option value="${viewer.id}">${viewer.name}</option>`)
        .join('')));
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
      setHtml(select, raw(options
        .map(option => `<option value="${option.id}">${option.description}</option>`)
        .join('')));
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
                return `<div class="trait-row ${player.alive ? '' : 'dead'}" style="--trait-color:${pip.color}" title="${pip.label}" data-trait-key="${escapeAttr(pip.key ?? '')}">
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
    // New keyed cards are inserted before the current first child; put the
    // drawer header (close button + title) back at the top afterwards.
    const head = rail.querySelector(':scope > .drawer-head') as HTMLElement | null;
    if (head && rail.firstElementChild !== head) rail.prepend(head);
    this.layoutPlayerRail(rail);
  }

  /**
   * Player rail: a plain content-sized stack in drawers, an optional fisheye on
   * desktop.
   *
   * Drawers never use the fisheye: the cards are normal flow items with
   * `height:auto`, so a long trait ladder cannot be sliced by a fixed 104px
   * height. Desktop keeps the compressed hand-of-cards layout only when the
   * roster is too big to stack (more than four players), and it measures each
   * card's natural height first so the fisheye never clips one either.
   */
  private layoutPlayerRail(rail: HTMLElement): void {
    const cards = Array.from(rail.querySelectorAll<HTMLElement>('.pc'));
    const count = cards.length;
    if (count === 0) return;

    const desktop = window.matchMedia('(min-width: 1200px)').matches;
    if (!desktop || count <= 4) {
      rail.dataset.layout = 'list';
      for (const card of cards) {
        card.style.removeProperty('height');
        card.style.removeProperty('transform');
        card.style.removeProperty('z-index');
      }
      return;
    }

    const height = rail.clientHeight;
    if (height <= 0) return;

    // Natural content height: clear the fisheye height before measuring.
    for (const card of cards) card.style.removeProperty('height');
    const naturalHeight = Math.max(...cards.map(card => card.scrollHeight));
    const cardHeight = Math.max(PLAYER_CARD_HEIGHT, naturalHeight);
    const activeIndex = Math.max(
      0,
      cards.findIndex(card => card.classList.contains('active'))
    );
    const focusIndex =
      this.railFocusY === null
        ? activeIndex
        : Math.min(count - 1, Math.max(0, Math.round(this.railFocusY * (count - 1))));
    const layout = handLayout({
      count,
      containerWidth: height,
      cardWidth: cardHeight,
      focusX: count > 1 ? focusIndex / (count - 1) : 0.5,
      // Only rosters above four reach this branch, so the compression earns its
      // keep; a plain stack would overflow the rail.
      focusStrength: 1,
      hoverIndex: focusIndex,
      lockCardWidth: true,
      maxPitchRatio: 1
    });

    rail.dataset.layout = 'fisheye';
    for (const entry of layout.cards) {
      const card = cards[entry.index];
      if (!card) continue;
      card.style.height = `${cardHeight}px`;
      card.style.transform = `translateY(${(entry.x - cardHeight / 2).toFixed(2)}px)`;
      card.style.zIndex = String(10 + Math.round(entry.z));
    }
  }

  /**
   * Expanded desktop rail: start at the topbar and stop 16px above the dock.
   * Height is measured from the live dock rect because the dock grows and
   * shrinks with the action set.
   */
  private syncRailExpandedGeometry(): void {
    if (!window.matchMedia('(min-width: 1200px)').matches) {
      this.container.style.removeProperty('--rail-expanded-h');
      return;
    }
    const rail = this.container.querySelector('#player-rail') as HTMLElement | null;
    const dock = this.container.querySelector('#action-dock') as HTMLElement | null;
    if (!rail || !dock || rail.getAttribute('data-expanded') !== '1') {
      this.container.style.removeProperty('--rail-expanded-h');
      return;
    }
    const top = rail.getBoundingClientRect().top;
    const dockTop = dock.getBoundingClientRect().top;
    const height = Math.max(0, Math.floor(dockTop - top - 16));
    if (height > 0) this.container.style.setProperty('--rail-expanded-h', `${height}px`);
  }

  /** Desktop hand plaque: exactly as tall as the dock, slightly slimmer than 3:4. */
  private syncHandSlotGeometry(): void {
    const desktop = window.matchMedia('(min-width: 1200px) and (min-height: 481px)').matches;
    const dock = this.container.querySelector('#action-dock') as HTMLElement | null;
    if (!desktop || !dock) {
      this.container.style.removeProperty('--dock-h');
      return;
    }
    const height = dock.offsetHeight;
    if (height > 0) this.container.style.setProperty('--dock-h', `${height}px`);
  }

  /** 记一条操作栏事件（环形缓冲，最多 240 条）。 */
  private traceDock(entry: Omit<DockTraceEntry, 't'>): void {
    this.dockTrace.push({ t: Math.round(performance.now()), ...entry });
    if (this.dockTrace.length > 240) this.dockTrace.splice(0, this.dockTrace.length - 240);
    if (entry.ev === 'layout' || entry.ev === 'shape' || entry.ev === 'cards') {
      this.dockTraceCounters[entry.ev] += 1;
    }
  }

  /**
   * 操作栏抖动的现场记录。诊断导出会带上它，排查时也可以直接
   * `__dockTrace()` 在控制台里取。
   */
  public getDockTrace(): Record<string, unknown> {
    return {
      entries: this.dockTrace.slice(-160),
      counters: { ...this.dockTraceCounters },
      lastLayout: { ...this.dockTraceLastLayout },
      fan: { focusX: Number(this.fanFocusX.toFixed(3)), strength: this.fanFocusStrength },
      dockOpen: this.dockOpen,
      actions: this.latest?.actions.length ?? 0,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches
      }
    };
  }

  /**
   * `?docktrace=1`：左下角常驻一个每秒计数的小面板。抖的时候看一眼就知道是
   * 「每秒几十次重建」（DOM 问题）还是「重建 0 次但画面在闪」（合成层问题）。
   */
  private mountDockTrace(): void {
    if (new URLSearchParams(window.location.search).get('docktrace') !== '1') return;
    if (this.dockTraceOverlay) return;
    const el = document.createElement('div');
    el.id = 'dock-trace';
    el.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:9999;font:11px/1.45 ui-monospace,monospace;' +
      'color:#cfe3ff;background:rgba(8,10,14,.84);border:1px solid rgba(120,160,210,.35);' +
      'border-radius:8px;padding:6px 9px;pointer-events:none;white-space:pre';
    document.body.appendChild(el);
    this.dockTraceOverlay = el;
    let prev = { ...this.dockTraceCounters };
    this.dockTraceTimer = window.setInterval(() => {
      const cur = this.dockTraceCounters;
      const perSec = (key: keyof typeof cur) => ((cur[key] - prev[key]) / 0.5).toFixed(1);
      el.textContent =
        `dock trace  render ${perSec('render')}/s  layout ${perSec('layout')}/s\n` +
        `            shape ${perSec('shape')}/s  cards ${perSec('cards')}/s  move ${perSec('move')}/s\n` +
        `            cw ${this.dockTraceLastLayout.cw}  span ${this.dockTraceLastLayout.span}`;
      prev = { ...cur };
    }, 500);
  }

  /* ------------------------------------------------------------------ */
  /* Hand slot (手持出牌区)                                                */
  /* ------------------------------------------------------------------ */

  /** Follow the held action by id; if it disappeared, clamp the old position. */
  private reconcileHeldAction(actions: UiAction[]): void {
    if (actions.length === 0) {
      this.heldIndex = 0;
      this.heldActionId = null;
      return;
    }
    const byId = this.heldActionId ? actions.findIndex(action => action.id === this.heldActionId) : -1;
    if (byId >= 0) {
      this.heldIndex = byId;
      return;
    }
    if (this.heldIndex < 0 || this.heldIndex >= actions.length) this.heldIndex = 0;
    this.heldActionId = actions[this.heldIndex]?.id ?? null;
  }

  /** A new presenter/game starts with a clean hand stage. */
  private resetHandSlot(): void {
    const slot = this.container.querySelector('#hand-slot') as HTMLElement | null;
    if (slot) this.cancelHandPress(slot);
    const dockHeld = this.container.querySelector('[data-dock-held]') as HTMLElement | null;
    if (dockHeld) this.cancelHandPress(dockHeld);
    this.heldActionId = null;
    this.heldIndex = 0;
    this.handWheelDelta = 0;
    this.handSuppressClick = false;
    this.container.querySelectorAll<HTMLElement>('.hs-stage').forEach(stage => {
      stage.replaceChildren();
      delete stage.dataset.handKey;
    });
    slot?.classList.remove('pressing');
    dockHeld?.classList.remove('pressing');
  }

  private currentHeldAction(): UiAction | null {
    return this.latest?.actions[this.heldIndex] ?? null;
  }

  private isSimpleAction(action: UiAction): boolean {
    return isSimpleCard(deriveActionCard(action));
  }

  private renderHandSlot(snapshot: GameSnapshot, direction: -1 | 0 | 1 = 0): void {
    const slot = this.container.querySelector('#hand-slot') as HTMLElement | null;
    const dockHeld = this.container.querySelector('[data-dock-held]') as HTMLElement | null;
    const slotStage = slot?.querySelector('.hs-stage') as HTMLElement | null;
    const dockStage = dockHeld?.querySelector('.hs-stage') as HTMLElement | null;
    if (!slotStage && !dockStage) return;

    const action = snapshot.actions[this.heldIndex] ?? null;
    const total = snapshot.actions.length;
    this.heldActionId = action?.id ?? null;

    // A snapshot may replace the list mid-press; never dispatch the stale card.
    if (this.handPress && action?.id !== this.handPress.actionId) {
      this.cancelHandPress(this.handPress.slot);
      this.suppressHandClick();
    }

    if (slot && slotStage) this.paintHandCard(slot, slotStage, action, total, direction, false);
    if (dockHeld && dockStage) this.paintHandCard(dockHeld, dockStage, action, total, direction, true);
    this.syncHeldHighlight();

    const live = this.container.querySelector('[data-held-live]') as HTMLElement | null;
    if (live) {
      const text = action
        ? `当前动作：${action.label}，第 ${this.heldIndex + 1} / ${total} 个`
        : '当前无可执行动作';
      if (live.textContent !== text) live.textContent = text;
    }
  }

  /**
   * Paint one held-action surface. The desktop/tablet plaque and the phone
   * dock's first card share the same data and gesture handling; only their CSS
   * layouts differ.
   */
  private paintHandCard(
    target: HTMLElement,
    stage: HTMLElement,
    action: UiAction | null,
    total: number,
    direction: -1 | 0 | 1,
    dock: boolean
  ): void {
    target.dataset.empty = action ? '0' : '1';
    target.dataset.tone = action?.tone ?? 'neutral';
    const where = dock ? '当前选中动作' : '手持出牌区';
    target.setAttribute(
      'aria-label',
      action
        ? `${where}：${action.label}，第 ${this.heldIndex + 1} / ${total} 个。点击查看，长按执行，左右方向键切换。`
        : `${where}：无可执行动作`
    );

    const key = action?.id ?? '';
    const content = this.handCardHtml(action, this.heldIndex, total, dock);
    const current = stage.querySelector<HTMLElement>('.hs-card:not(.hs-leaving)');
    if (current && key === stage.dataset.handKey) {
      current.dataset.tone = target.dataset.tone;
      setHtml(current, raw(content));
      return;
    }

    stage.querySelectorAll('.hs-leaving').forEach(node => {
      node.remove();
    });
    const next = document.createElement('div');
    next.className = 'hs-card';
    next.dataset.tone = target.dataset.tone;
    setHtml(next, raw(content));

    if (current && direction !== 0 && action) {
      const suffix = direction > 0 ? 'next' : 'prev';
      current.classList.add('hs-leaving', `hs-leave-${suffix}`);
      next.classList.add('hs-entering', `hs-enter-${suffix}`);
      stage.append(next);
      window.setTimeout(() => {
        if (current.parentElement === stage) current.remove();
      }, 280);
    } else {
      current?.remove();
      stage.append(next);
    }
    stage.dataset.handKey = key;
  }

  private handCardHtml(action: UiAction | null, index: number, total: number, dock = false): string {
    if (!action) {
      return `
        <span class="hs-empty-ico" aria-hidden="true">◌</span>
        <span class="hs-empty-label">无可执行动作</span>
        <span class="hs-empty-hint">等待其他玩家或结算</span>
      `;
    }
    return `
      <div class="hs-top">
        <span class="hs-kicker">${dock ? '当前动作' : '手持出牌'}</span>
        <span class="hs-count">${index + 1} / ${total}</span>
      </div>
      <span class="hs-icon" aria-hidden="true">${action.icon}</span>
      <div class="hs-label">${escHtml(action.label)}</div>
      <div class="hs-hint">${escHtml(action.hint)}</div>
      <div class="hs-foot"><span>点击查看</span><span>长按 1.5s</span></div>
    `;
  }

  /** Keep the fan card and the held plaque in sync without rebuilding the fan. */
  private syncHeldHighlight(): void {
    const id = this.heldActionId;
    this.container.querySelectorAll<HTMLElement>('#action-dock .dock-fan .act').forEach(card => {
      if (id && card.dataset.actionId === id) card.dataset.held = '1';
      else delete card.dataset.held;
    });
  }

  private cycleHeld(step: number, count = 1): void {
    const snapshot = this.latest;
    const total = snapshot?.actions.length ?? 0;
    if (!snapshot || total < 2) return;
    const direction = step >= 0 ? 1 : -1;
    const next = (((this.heldIndex + direction * count) % total) + total) % total;
    if (next === this.heldIndex) return;
    this.heldIndex = next;
    this.heldActionId = snapshot.actions[next]?.id ?? null;
    this.renderHandSlot(snapshot, direction);
  }

  /** Click and Enter share this: simple actions execute, parameterised ones confirm. */
  private activateHeldAction(): void {
    const action = this.currentHeldAction();
    if (!action) return;
    if (this.isSimpleAction(action)) this.runAction(action);
    else this.openActionDetail(action);
  }

  private bindHandSlot(slot: HTMLElement): void {
    slot.addEventListener('pointerdown', event => this.startHandPress(slot, event));
    slot.addEventListener('pointermove', event => this.moveHandPress(slot, event));
    slot.addEventListener('pointerup', event => this.endHandPress(slot, event, false));
    slot.addEventListener('pointercancel', event => this.endHandPress(slot, event, true));
    slot.addEventListener(
      'wheel',
      event => this.handleHandWheel(event),
      { passive: false }
    );
    slot.addEventListener('contextmenu', event => {
      if (this.handPress) event.preventDefault();
    });
    slot.addEventListener('click', event => {
      if (this.handSuppressClick) {
        this.handSuppressClick = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const action = this.currentHeldAction();
      if (action) this.openActionDetail(action);
    });
    slot.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this.cycleHeld(event.key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.activateHeldAction();
    });
  }

  private handleHandWheel(event: WheelEvent): void {
    const total = this.latest?.actions.length ?? 0;
    if (total < 2) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const dx = event.deltaX * scale;
    const dy = event.deltaY * scale;
    const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
    if (delta === 0) return;
    this.handWheelDelta += delta;
    if (Math.abs(this.handWheelDelta) < HAND_WHEEL_STEP_PX) return;
    const step = this.handWheelDelta > 0 ? 1 : -1;
    this.handWheelDelta = 0;
    this.cycleHeld(step);
  }

  private startHandPress(slot: HTMLElement, event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A new gesture starts clean; the previous long-press may not have emitted a click.
    this.handSuppressClick = false;
    const action = this.currentHeldAction();
    if (!action) return;
    slot.focus({ preventScroll: true });
    this.cancelHandPress(slot);

    const press: HandPressState = {
      pointerId: event.pointerId,
      actionId: action.id,
      slot,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      stepCount: 0,
      moved: false,
      frame: 0,
      timer: null
    };
    this.handPress = press;
    slot.classList.add('pressing');
    const fill = slot.querySelector<SVGCircleElement>('.hs-ring-fill');
    if (fill) fill.style.strokeDashoffset = '100';
    try {
      slot.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointers have no active capture; the DOM listeners still work.
    }

    const started = performance.now();
    const tick = (now: number): void => {
      if (this.handPress !== press) return;
      const progress = Math.min(1, (now - started) / HAND_LONG_PRESS_MS);
      if (fill) fill.style.strokeDashoffset = String(100 - progress * 100);
      press.frame = progress < 1 ? requestAnimationFrame(tick) : 0;
    };
    press.frame = requestAnimationFrame(tick);
    press.timer = window.setTimeout(() => this.completeHandPress(slot, press), HAND_LONG_PRESS_MS);
  }

  private moveHandPress(slot: HTMLElement, event: PointerEvent): void {
    const press = this.handPress;
    if (!press || press.pointerId !== event.pointerId) return;
    const dx = event.clientX - press.startX;
    const dy = event.clientY - press.startY;
    const distance = Math.hypot(dx, dy);
    if (!press.axis && distance >= 6) press.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    if (!press.moved && distance > HAND_PRESS_CANCEL_PX) {
      press.moved = true;
      this.clearHandRing(slot, press);
    }
    if (!press.axis) return;
    // Mouse drags cycle horizontally; touch/pen swipes use either dominant axis.
    if (event.pointerType === 'mouse' && press.axis !== 'x') return;
    const travel = press.axis === 'y' ? -dy : dx;
    const steps = Math.trunc(travel / HAND_DRAG_STEP_PX);
    if (steps === press.stepCount) return;
    const delta = steps - press.stepCount;
    press.stepCount = steps;
    if (delta !== 0) this.cycleHeld(Math.sign(delta), Math.abs(delta));
  }

  private endHandPress(slot: HTMLElement, event: PointerEvent, cancelled: boolean): void {
    const press = this.handPress;
    if (!press || press.pointerId !== event.pointerId) return;
    const moved = press.moved || press.stepCount !== 0;
    this.cancelHandPress(slot);
    if (!cancelled && moved) this.suppressHandClick();
  }

  private clearHandRing(slot: HTMLElement, press: HandPressState): void {
    if (press.timer !== null) {
      window.clearTimeout(press.timer);
      press.timer = null;
    }
    if (press.frame) {
      cancelAnimationFrame(press.frame);
      press.frame = 0;
    }
    slot.classList.remove('pressing');
    const fill = slot.querySelector<SVGCircleElement>('.hs-ring-fill');
    if (fill) fill.style.strokeDashoffset = '100';
  }

  private cancelHandPress(slot: HTMLElement): void {
    const press = this.handPress;
    if (!press) {
      slot.classList.remove('pressing');
      return;
    }
    this.clearHandRing(slot, press);
    this.handPress = null;
    try {
      if (slot.hasPointerCapture(press.pointerId)) slot.releasePointerCapture(press.pointerId);
    } catch {
      // Already released by the browser.
    }
  }

  private completeHandPress(slot: HTMLElement, press: HandPressState): void {
    if (this.handPress !== press) return;
    this.handPress = null;
    this.clearHandRing(slot, press);
    this.suppressHandClick();
    const action = this.latest?.actions[this.heldIndex] ?? null;
    if (!action || action.id !== press.actionId) return;
    if (this.isSimpleAction(action)) this.runAction(action);
    else this.openActionDetail(action);
  }

  private suppressHandClick(): void {
    this.handSuppressClick = true;
  }

  /* ------------------------------------------------------- 统一手牌（物理） */

  /**
   * 单击 / 回车一张动作卡（`CardHand.onActivate`）。
   *
   * 语义与旧版点击完全一致，只是把"谁被点了"从事件委托换成了物理层回调：
   * 需要目标的开径向选择器、可直接执行的立即派发、数值卡先甩后填、其余看详情。
   */
  private activateHandCard(id: string): void {
    const display = this.displayEntity(id);
    if (display) {
      // 持有牌没有动作可执行：点击=看档案（inspect-first，不改状态）。
      this.presenter.pickTarget({ kind: 'entity', id: display.entityId, metadata: { intent: 'inspect' } });
      return;
    }
    const action = this.latest?.actions.find(candidate => candidate.id === id);
    if (!action) return;
    if (action.cooldownMs && action.cooldownMs > 0) {
      this.pushToast('⏳', `${action.label} · 还要 ${Math.ceil(action.cooldownMs / 1000)} 秒`);
      return;
    }
    const card = deriveActionCard(action);
    if (card.targetMode === 'selection' && action.selection) {
      // 多目标仍留在 payload 表单里（径向选择器还没有多选环）。
      if ((action.selection.spec.max ?? 1) > 1) {
        this.openPayloadForm(action);
        return;
      }
      const el = this.handCardElement(id);
      const rect = el?.getBoundingClientRect();
      this.openRadialPicker(action, {
        x: (rect?.left ?? window.innerWidth / 2) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? window.innerHeight / 2) + (rect?.height ?? 0) / 2
      });
      return;
    }
    if (card.targetMode === 'none' || card.targetMode === 'highlight') {
      this.runAction(action);
      return;
    }
    if (card.kind === 'numeric' && card.targetMode === 'fields') {
      // P6：先把牌甩出去，再问数量；确认之前不 dispatch，取消就是干净的回弹。
      const el = this.handCardElement(id);
      el?.classList.add('is-playing');
      window.setTimeout(() => {
        el?.classList.remove('is-playing');
        this.runAction(action);
      }, 220);
      return;
    }
    this.openActionDetail(action);
  }

  /**
   * 拖出即浮现的目标轮盘（大号、磨砂、每区一张头像牌）。
   *
   * 半径取屏幕短边的 0.41 倍（直径约 0.82 屏，占画面一大半），圆心跟着落点但夹紧
   * 在视口内。候选只来自 `action.selection.candidates`——那就是引擎认可的合法目标，
   * 所以"选错人"在 UI 层根本选不出来，真送进去也会被引擎驳回。
   */
  private beginTargetWheel(id: string, at: Point): void {
    const action = this.latest?.actions.find(candidate => candidate.id === id);
    if (!action) return;
    if (deriveActionCard(action).targetMode !== 'selection') return;
    const candidates = action.selection?.candidates ?? [];
    if (candidates.length === 0) return;

    const players = this.latest?.players ?? [];
    // 轮盘**固定在视图正中**（不跟手）：位置与形状每次一致，方便盲操作。
    // 上留桌面、下不越手牌条（松手回到手牌＝放回并关闭轮盘）。
    void at;
    const hand = this.container.querySelector('#action-hand') as HTMLElement | null;
    const handTop = hand?.getBoundingClientRect().top ?? window.innerHeight;
    const boardTop = 12;
    const boardBottom = Math.max(boardTop + 240, handTop - 10);
    const availableHeight = boardBottom - boardTop;
    const availableWidth = window.innerWidth - 24;
    const radius = Math.max(
      150,
      Math.min(560, availableHeight / 2, availableWidth / 2, Math.min(window.innerWidth, window.innerHeight) * 0.41)
    );
    const anchor = { x: window.innerWidth / 2, y: boardTop + availableHeight / 2 };

    this.radialPicker ??= new RadialPickerOverlay();
    this.radialPicker.open({
      mode: 'drag',
      candidates: candidates.map(candidate => {
        const player = players.find(entry => entry.id === candidate.id);
        return {
          id: candidate.id,
          label: candidate.label,
          color: player?.color,
          avatar: player?.avatar,
          icon: candidate.icon
        };
      }),
      anchor,
      radius,
      seed: `${action.id}:${candidates.map(candidate => candidate.id).join(',')}`,
      title: action.label,
      onPick: () => {},
      onCenter: () => {},
      onCancel: () => {}
    });
  }

  /**
   * 拖出牌条并松手在桌面区域（`CardHand.onDrop`）。
   *
   * 返回 true 才让卡片飞出去——即"这张牌现在真的生效了"。需要目标/参数的动作用
   * 回弹代替飞场：卡片复位，紧接着把选择器或表单弹出来，玩家不会以为动作丢了。
   */
  private playHandCard(id: string, at: Point): boolean {
    const action = this.latest?.actions.find(candidate => candidate.id === id);
    if (!action) return false;
    if (action.cooldownMs && action.cooldownMs > 0) {
      this.pushToast('⏳', `${action.label} · 还要 ${Math.ceil(action.cooldownMs / 1000)} 秒`);
      return false;
    }
    const card = deriveActionCard(action);
    if (card.targetMode === 'selection') {
      // 拖拽路径：轮盘已经在 onDragStart 弹出，这里只结算落点。
      // 分区 → 对那个人打出；中心圆 → 二级菜单；轮盘外 → null（回弹，什么都不发生）。
      const intent = this.radialPicker?.resolveAt(at.x, at.y) ?? null;
      if (!intent) return false;
      if (intent.type === 'center') {
        this.openPayloadForm(action);
        return false;
      }
      if (intent.type !== 'pick') return false;
      const result = this.performAction(action.id, undefined, [intent.candidate.id]);
      if (!result.ok) {
        this.pushToast('⚠️', result.error ?? '动作被拒绝');
        return false;
      }
      this.showTableEcho(action.label, '你', action.entityId);
      return true;
    }
    if (card.targetMode === 'fields' || card.targetMode === 'placement') {
      this.runAction(action);
      return false;
    }
    this.runAction(action);
    this.showTableEcho(action.label, '你', action.entityId);
    return true;
  }

  /**
   * 出牌回响：一张牌"落到桌上"的可见结果。
   *
   * 为什么要它：动作卡（过牌/跟注/结束回合）在 3D 桌面上没有实体，只靠手牌消失来
   * 表示"打出去了"，远端的玩家完全看不出发生了什么。回响把"谁打了什么"画在桌面
   * 中央并停留一会儿；同一个渲染函数既服务本地出牌，也服务远端历史（见
   * `renderTableEcho`），所以两边看到的是同一件事。
   */
  private showTableEcho(title: string, actor: string, entityId?: string): void {
    const host = this.container;
    const echo = document.createElement('div');
    echo.className = 'hand-play-echo';
    const anchor = this.tableAnchor();
    echo.style.setProperty('--echo-x', `${Math.round(anchor.x)}px`);
    echo.style.setProperty('--echo-y', `${Math.round(anchor.y)}px`);
    // 有实体就画真实卡面：别人打出的动作卡也落一张"看得见的牌"，而不是只有文字。
    const art = entityId ? this.ports.entityCardArt?.(entityId) : undefined;
    if (art) {
      echo.classList.add('with-art');
      setHtml(
        echo,
        html`<img class="hpe-face" src="${art}" alt="" draggable="false" /><span class="hpe-actor">${actor}</span><span class="hpe-title">${title}</span>`
      );
    } else {
      setHtml(echo, html`<span class="hpe-actor">${actor}</span><span class="hpe-title">${title}</span>`);
    }
    host.appendChild(echo);
    window.setTimeout(() => echo.remove(), 2100);
  }

  /** 远端 / 引擎产生的出牌与掷骰：历史变了就回响一次（幂等按 id）。 */
  private renderTableEcho(snapshot: GameSnapshot): void {
    const entry = snapshot.history?.[0];
    if (!entry || entry.id === this.lastEchoId) return;
    this.lastEchoId = entry.id;
    if (entry.kind !== 'card') return;
    this.showTableEcho(entry.title, entry.actorName ?? '', entry.entityId);
  }

  /** 桌面上"打出去"的落点（视口坐标）：手牌条上方、屏幕横向居中。 */
  private tableAnchor(): Point {
    const hand = this.container.querySelector('#action-hand') as HTMLElement | null;
    const rect = hand?.getBoundingClientRect();
    const bottom = rect && rect.top > 0 ? rect.top : window.innerHeight * 0.78;
    return { x: window.innerWidth / 2, y: Math.max(120, bottom - window.innerHeight * 0.26) };
  }

  /** 手牌条的物理层（懒创建，只在 `?unified-hand` 下存在）。 */
  private ensureActionHand(el: HTMLElement): CardHand {
    this.actionHand ??= new CardHand(el, {
      createCard: id => this.buildHandCard(id),
      playZone: () => this.handPlayZone(el),
      onActivate: id => this.activateHandCard(id),
      onDrop: (id, at) => this.playHandCard(id, at),
      flyTarget: () => this.tableAnchor(),
      onPageChange: (page, pageCount) => this.syncHandPager(page, pageCount),
      // 拖出来就弹目标轮盘（只有"需要选目标"的卡才弹）。
      onDragStart: (id, at) => this.beginTargetWheel(id, at),
      onDragMove: at => this.radialPicker?.setPointer(at.x, at.y),
      onDragEnd: () => this.radialPicker?.close(),
      // 悬在轮盘分区上就缩小，好让玩家看清分区头像与提示；中心/轮盘外恢复大牌。
      dragScaleAt: at => (this.radialPicker?.zoneAt(at.x, at.y) === 'sector' ? 0.4 : 1)
    });
    return this.actionHand;
  }

  /**
   * 出牌区 = 手牌条上方的桌面矩形（视口坐标）。
   *
   * 真正的 3D 落点仍由 raycast 决定；这里给的是"拖到桌面上"这一层的视觉承诺：
   * 进区高亮、区外回弹。几何按 250ms 缓存，指针移动过程中不读布局。
   */
  private handPlayZone(el: HTMLElement): readonly Point[] | null {
    const now = performance.now();
    if (this.handZone.points && now - this.handZone.at < 250) return this.handZone.points;
    const rect = el.getBoundingClientRect();
    const bottom = rect.top - 8;
    if (bottom <= 8) return null;
    const points = rectPolygon({ left: 8, top: 8, right: window.innerWidth - 8, bottom });
    this.handZone = { at: now, points };
    return points;
  }

  /** 翻页器：只有一页时整体隐藏，标签保持「2 / 3」。 */
  private syncHandPager(page: number, pageCount: number): void {
    const pager = this.container.querySelector('#hand-pager') as HTMLElement | null;
    const label = this.container.querySelector('#hand-pager-label') as HTMLElement | null;
    if (!pager) return;
    pager.hidden = pageCount <= 1;
    if (label) label.textContent = `${page + 1} / ${pageCount}`;
    pager.querySelectorAll<HTMLButtonElement>('[data-page-step]').forEach(button => {
      const step = Number(button.dataset.pageStep) || 0;
      button.disabled = step < 0 ? page <= 0 : page >= pageCount - 1;
    });
  }

  private handCardElement(id: string): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(
      `#action-hand [data-action-id="${CSS.escape(id)}"]`
    );
  }

  /**
   * 一张动作卡的 DOM。结构只在"签名变了"时重建（见 `handCardSignature`），
   * 之后位置全部由 `CardHand` 的 rAF 写 transform，这里不再参与布局。
   */
  /** `display:` 前缀 = 只展示、不出牌的持有牌（底牌/道具）。 */
  private displayEntity(id: string): { entityId: string; title: string } | null {
    if (!id.startsWith('display:')) return null;
    const entityId = id.slice('display:'.length);
    const entity = this.latest?.board.entities[entityId];
    const title = String(entity?.components?.cardFace?.title ?? '');
    return { entityId, title };
  }

  private buildHandCard(id: string): HTMLElement | null {
    const display = this.displayEntity(id);
    if (display) {
      const art = this.handArt.get(id) ?? '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ah-card ah-held';
      button.dataset.actionId = id;
      button.dataset.kind = 'held';
      button.dataset.group = 'card';
      button.dataset.targetMode = 'none';
      button.setAttribute('aria-label', `${display.title || '手牌'} · 仅展示`);
      button.title = `${display.title} · 点击查看`;
      const face = document.createElement('span');
      face.className = 'ah-face ah-held';
      if (art) {
        const img = document.createElement('img');
        img.className = 'ah-art';
        img.alt = '';
        img.src = art;
        img.draggable = false;
        face.appendChild(img);
      }
      const badge = document.createElement('span');
      badge.className = 'ah-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = '✋';
      face.appendChild(badge);
      button.appendChild(face);
      return button;
    }
    const action = this.latest?.actions.find(candidate => candidate.id === id);
    if (!action) return null;
    const card = deriveActionCard(action);
    const art = this.handArt.get(id);
    const aria = action.hint ? `${action.label} · ${action.hint}` : action.label;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ah-card${art ? ' ah-with-art' : ''}`;
    button.dataset.actionId = card.id;
    button.dataset.kind = card.kind;
    button.dataset.group = card.group;
    button.dataset.targetMode = card.targetMode;
    button.setAttribute('aria-label', aria);
    button.title = aria;

    const face = document.createElement('span');
    face.className = `ah-face ah-${card.kind}`;
    if (art) {
      const img = document.createElement('img');
      img.className = 'ah-art';
      img.alt = '';
      img.src = art;
      img.draggable = false;
      const label = document.createElement('span');
      label.className = 'ah-action-label';
      label.textContent = card.label;
      face.append(img, label);
    } else {
      const icon = document.createElement('span');
      icon.className = 'ah-ico';
      icon.setAttribute('aria-hidden', 'true');
      setHtml(icon, raw(iconHtml(card.icon)));
      const label = document.createElement('span');
      label.className = 'ah-label';
      label.textContent = card.label;
      face.append(icon, label);
    }
    const badge = badgeFor(card);
    if (badge) {
      const el = document.createElement('span');
      el.className = 'ah-badge';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = badge;
      face.appendChild(el);
    }
    if (card.cooldownMs && card.cooldownMs > 0) {
      const el = document.createElement('span');
      el.className = 'ah-cool';
      el.textContent = `${Math.ceil(card.cooldownMs / 1000)}s`;
      face.appendChild(el);
    }
    button.appendChild(face);
    return button;
  }

  /** 外观签名：变了才重建节点，否则每帧快照都会把动画打断。 */
  private handCardSignature(id: string, action: UiAction): string {
    const card = deriveActionCard(action);
    const art = this.handArt.get(id) ?? '';
    return [
      card.kind,
      card.targetMode,
      card.label,
      card.hint ?? '',
      action.icon ?? '',
      String(card.cooldownMs ?? 0),
      art ? String(art.length) : '',
      art ? fnv1a(art) : ''
    ].join('|');
  }

  /**
   * Open the radial target chooser anchored at a screen point.
   *
   * 锚点用点而不是元素：手牌的卡片会被物理层移动，点开详情/拖出松手都应该以
   * "当时那一点"为圆心，而不是事后去量一个正在回弹的节点。
   */
  private openRadialPicker(action: UiAction, anchor: Point): void {
    const candidates = (action.selection?.candidates ?? []).map(candidate => ({
      id: candidate.id,
      label: candidate.label
    }));
    if (candidates.length === 0) {
      this.openPayloadForm(action);
      return;
    }
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    this.radialPicker ??= new RadialPickerOverlay();
    this.radialPicker.open({
      candidates,
      anchor: {
        x: anchor.x,
        y: anchor.y - (coarse ? 80 : 0)
      },
      radius: Math.max(
        140,
        Math.min(260, 90 + candidates.length * 10, window.innerWidth * 0.42, window.innerHeight * 0.42)
      ),
      seed: `${action.id}:${candidates.map(candidate => candidate.id).join(',')}`,
      title: action.label,
      onPick: candidate => {
        const result = this.performAction(action.id, undefined, [candidate.id]);
        if (!result.ok) this.pushToast('⚠️', result.error ?? '动作被拒绝');
      },
      onCenter: () => this.openPayloadForm(action),
      onCancel: () => {}
    });
  }

  /**
   * 统一动作手牌：`snapshot.actions` 是唯一数据源，位置与手感交给 `CardHand`
   * （弧形排布 + hover 让位 + 跟手拖拽 + 弹簧回弹）。
   *
   * 这里是"每次快照都会跑"的路径，所以只做三件便宜的事：取卡面、算签名、同步清单。
   * DOM 复用与动画状态都在 `CardHand.sync()` 里按 id 处理，不会因为一次重绘把
   * 正在拖的牌打断。
   */
  private renderActionHand(snapshot: GameSnapshot): void {
    const el = this.container.querySelector('#action-hand') as HTMLElement | null;
    if (!el) return;
    if (!this.actionHandEnabled) {
      if (el.getAttribute('data-enabled') !== '0') {
        el.setAttribute('data-enabled', '0');
        el.setAttribute('aria-hidden', 'true');
        el.replaceChildren();
      }
      this.actionHand?.destroy();
      this.actionHand = undefined;
      return;
    }
    // 先启用再量：`data-enabled="0"` 时整条是 display:none，clientWidth 为 0，
    // 用兜底宽度会把牌摆到比实际更宽的一行里。
    el.setAttribute('data-enabled', '1');
    el.setAttribute('aria-hidden', 'false');

    this.handArt.clear();
    // 手牌分区：牌 → 装备 → 技能 → 命令。同一分区内保持引擎给的顺序（稳定排序）。
    const GROUP_ORDER: Record<string, number> = { card: 0, equip: 1, skill: 2, command: 3 };
    const ordered = [...snapshot.actions].sort(
      (a, b) => (GROUP_ORDER[a.group ?? 'command'] ?? 3) - (GROUP_ORDER[b.group ?? 'command'] ?? 3)
    );
    const items: HandCardItem[] = ordered.map(action => {
      const card = deriveActionCard(action);
      const art = card.entityId ? this.ports.entityCardArt?.(card.entityId) : undefined;
      if (art) this.handArt.set(card.id, art);
      return { id: card.id, signature: this.handCardSignature(card.id, action) };
    });

    // 手里还有"不是动作"的牌：德州的两张底牌、山屋的道具卡……
    // 它们没有对应 action，但玩家必须看得见，所以排在动作卡右侧一起持有。
    const claimed = new Set(
      snapshot.actions
        .map(action => deriveActionCard(action).entityId)
        .filter((entityId): entityId is string => Boolean(entityId))
    );
    // 上帝视角没有"自己的手牌"：改看当前行动者的手牌（否则会把所有玩家的手牌铺开）。
    const handOwner = snapshot.viewer === 'GOD' ? (snapshot.focus[0] ?? '') : snapshot.viewer;
    const handZone = handOwner ? snapshot.board.zones?.[`zone_hand_${handOwner}`] : undefined;
    const handIds = (handZone?.orderedEntities ?? []).slice(0, 12);
    for (const entityId of handIds) {
      if (claimed.has(entityId)) continue;
      const entity = snapshot.board.entities[entityId];
      if (!entity || entity.isMasked) continue;
      const id = `display:${entityId}`;
      const art = this.ports.entityCardArt?.(entityId) ?? '';
      this.handArt.set(id, art);
      const title = String(entity.components?.cardFace?.title ?? '');
      items.push({ id, signature: `display|${title}|${art ? fnv1a(art) : ''}` });
    }

    this.ensureActionHand(el).sync(items);
    this.renderTableEcho(snapshot);
  }

  private renderDock(snapshot: GameSnapshot): void {
    const dock = this.container.querySelector('#action-dock') as HTMLElement | null;
    if (!dock) return;
    this.dockTraceCounters.render += 1;

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
        // 冷却中的动作（例如一手结束后 20 秒才允许开下一手）画成倒计时角标：
        // 秒数由 `tickCooldowns` 每 250ms 刷新，到点自动恢复可点。
        const cooling = action.cooldownMs && action.cooldownMs > 0;
        const coolAttr = cooling ? ` data-cool-until="${Date.now() + action.cooldownMs!}"` : '';
        return `
        <button class="act ${tone}${cooling ? ' cooling' : ''}"
                data-action-id="${action.id}"
                data-fan-label="${action.label}"
                data-fan-hint="${action.hint}"${coolAttr}
                aria-label="${escapeAttr(action.label)}${action.hint ? ` · ${escapeAttr(action.hint)}` : ''}"
                aria-keyshortcuts="${index + 1}"
                style="--i:${index};--off:${offset.toFixed(2)};--abs:${Math.abs(offset).toFixed(2)}"
                title="${action.label}">
          <span class="act-ico">${action.icon}</span>
          <span class="act-key">${index + 1}</span>
          ${cooling ? `<span class="act-cool">${Math.ceil(action.cooldownMs! / 1000)}s</span>` : ''}
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

          const symBadge = placement.symbol ? this.presenter.tokenBadge?.(String(placement.symbol)) : null;
          const symbolBadge = symBadge
            ? `<span class="pp-sym ${escHtml(String(placement.symbol).toLowerCase())}">${symBadge.glyph ? symBadge.glyph + ' ' : ''}${escHtml(symBadge.label)}</span>`
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
      setHtml(dock, html`
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
          <div class="dock-held" data-dock-held role="button" tabindex="0" aria-label="当前选中动作">
            <div class="hs-stage"></div>
            <div class="dock-held-ring" aria-hidden="true">
              <svg class="hs-ring" viewBox="0 0 100 100">
                <circle class="hs-ring-track" cx="50" cy="50" r="47"></circle>
                <circle class="hs-ring-fill" cx="50" cy="50" r="47" pathLength="100"></circle>
              </svg>
              <span class="dhr-label">长按执行</span>
            </div>
          </div>
          <div class="dock-actions" data-slot="actions"></div>
        </div>
        <span class="sr-only" data-held-live aria-live="polite"></span>
      `);
      this.bindDockEvents(dock);
      this.bindPlayerRail();
      // The seat peek window is placed beside the pointer, so its position has to
      // be tracked globally: the board hover callback carries no coordinates.
      window.addEventListener(
        'pointermove',
        event => {
          this.pointerAt = { x: event.clientX, y: event.clientY };
        },
        { passive: true }
      );
    }

    const slot = (name: string) => dock.querySelector(`[data-slot="${name}"]`) as HTMLElement | null;
    const setText = (selector: string, text: string) => {
      const el = dock.querySelector(selector) as HTMLElement | null;
      if (el && el.textContent !== text) el.textContent = text;
    };
    // Signature-guarded paint: these slots have no persistent state, so a full
    // innerHTML is fine as long as it only happens when the content changed.
    const paintSlot = (el: HTMLElement | null, html: string) => {
      if (!el) return;
      const sig = hash(html);
      if (el.dataset.sig === sig) return;
      setHtml(el, raw(html));
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

    paintSlot(slot('alert'), alert);
    paintSlot(
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
    paintSlot(slot('floors'), floorTabs);

    setText('[data-bar="phase"]', snapshot.phaseLabel);
    setText('[data-bar="actor"]', snapshot.actorName);
    setText('[data-bar="round"]', `R${snapshot.round}·T${snapshot.turn}`);
    setText('[data-bar="stack"]', `Σ ${snapshot.stackDepth}`);
    setText('[data-bar="decisions"]', `Δ ${snapshot.openDecisions}`);
    setText('[data-bar="legal"]', `|ℒ| ${snapshot.legalCount}`);

    // ---- actions slot -------------------------------------------------
    const actionsSlot = slot('actions');
    let dockMode = 'none';
    if (actionsSlot) {
      const mode = placement
        ? 'placement'
        : snapshot.actions.length > 0
        ? 'fan'
        : snapshot.gameOver
        ? 'over'
        : 'idle';

      const onlyEndTurn =
        snapshot.actions.length === 1 && (snapshot.actions[0]?.actionType ?? '') === 'END_TURN';
      const blockedReason = onlyEndTurn ? (snapshot.blockedReason ?? '') : '';
      const dockShape = onlyEndTurn ? `${mode}:only-end:${blockedReason}` : mode;
      dockMode = mode;

      // Rebuilding is only correct when the dock changes shape. The hint text
      // differs between "actions available" and "only end turn", so that state is
      // part of the shape key.
      if (actionsSlot.dataset.shape !== dockShape) {
        this.traceDock({ ev: 'shape', mode: dockShape, n: snapshot.actions.length });
        actionsSlot.dataset.shape = dockShape;
        actionsSlot.dataset.mode = mode;
        actionsSlot.removeAttribute('data-sig');
        setHtml(actionsSlot, raw(mode === 'fan'
            ? onlyEndTurn
              ? `<div class="fan-hint" data-fan-hint><span class="fh-label">${blockedReason || '本回合已无可用动作'}</span><span class="fh-detail">点「结束回合」交给下一位</span></div><div class="dock-fan" data-fan></div>`
              : `<div class="fan-hint" data-fan-hint><span class="fh-label">悬停查看动作</span><span class="fh-detail">点击牌面执行该动作 · 数字键直接执行</span></div><div class="dock-fan" data-fan></div>`
            : ''));
      }

      if (mode === 'placement') {
        paintSlot(actionsSlot, placementPanel);
      } else if (mode === 'over') {
        paintSlot(
          actionsSlot,
          `<div class="empty-hint"><span class="e-ico">🏁</span><span>对局已结束${
            snapshot.winnerLabel ? ` — 胜者：${snapshot.winnerLabel}` : ''
          }${snapshot.winnerReason ? ` · ${snapshot.winnerReason}` : ''}</span></div>`
        );
      } else if (mode === 'idle') {
        paintSlot(
          actionsSlot,
          '<div class="empty-hint"><span class="e-ico">◌</span><span>暂无可执行的合法动作 — 等待其他玩家，或正在结算响应栈。</span></div>'
        );
      } else {
        // Fan mode: reconcile the cards by action id so hover survives a repaint.
        const fan = actionsSlot.querySelector('[data-fan]') as HTMLElement | null;
        if (fan) {
          const total = snapshot.actions.length;
          const mid = (total - 1) / 2;
          const changedCards = reconcileKeyed(
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
                  aria-label="${escapeAttr(action.label)}${action.hint ? ` · ${escapeAttr(action.hint)}` : ''}"
                  aria-keyshortcuts="${index + 1}"
                  ${index === this.heldIndex ? 'data-held="1"' : ''}
                  style="--i:${index};--off:${offset.toFixed(2)};--abs:${Math.abs(offset).toFixed(2)}"
                  title="${action.label}">
                  <span class="act-ico">${action.icon}</span>
                  <span class="act-key">${index + 1}</span>
                </button>`
              };
            })
          );
          if (changedCards > 0) {
            this.traceDock({ ev: 'cards', n: total, changed: true });
          }
          this.layoutActionFan(fan);
        }
      }
    }

    // 只在「形状」真的变了的时候记一条，避免每次快照都把环形缓冲刷满。
    const sig = `${dockMode}|${snapshot.actions.length}|${this.dockOpen}|${actionsSlot?.clientWidth ?? 0}`;
    if (sig !== this.dockTraceLastSig) {
      this.dockTraceLastSig = sig;
      this.traceDock({
        ev: 'render',
        n: snapshot.actions.length,
        mode: dockMode,
        open: this.dockOpen,
        cw: actionsSlot?.clientWidth ?? 0
      });
    }
    if (!this.dockTraceOverlay) this.mountDockTrace();
    this.syncHandSlotGeometry();
    this.syncRailExpandedGeometry();
  }

  /**
   * Coalesce every dock geometry change into one layout pass on the next frame.
   * Called from the toggle, ResizeObserver, transitionend and shell resize.
   */
  private relayoutDock(): void {
    if (this.dockRelayoutFrame) return;
    this.dockRelayoutFrame = requestAnimationFrame(() => {
      this.dockRelayoutFrame = 0;
      this.syncHandSlotGeometry();
      this.syncRailExpandedGeometry();
      const fan = this.container.querySelector('#action-dock [data-fan]') as HTMLElement | null;
      if (fan) this.layoutActionFan(fan);
    });
  }

  /**
   * Re-position the action cards as a fisheye row.
   *
   * The cards keep their size and the gaps carry the fisheye: `lockCardWidth`
   * plus a low context ratio stacks the far end almost on top of itself, which is
   * what lets an unbounded number of actions stay inside one row. Tablet and
   * phone dock rows are flow layouts (horizontal scroll), so this pass clears any
   * desktop inline geometry before returning.
   */
  private layoutActionFan(fan: HTMLElement): void {
    const cards = [...fan.querySelectorAll<HTMLElement>('.act')];
    if (cards.length === 0) return;

    if (!window.matchMedia('(min-width: 1200px) and (min-height: 481px)').matches) {
      for (const card of cards) {
        card.style.removeProperty('--fan-x');
        card.style.removeProperty('--fan-scale');
        card.style.removeProperty('--fan-lift');
        card.style.zIndex = '';
        delete card.dataset.fanLayout;
      }
      return;
    }

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

    // Focus comes from the pointer's position along the row, never from
    // `card.matches(':hover')`. The layout scales and lifts the focused card, so
    // asking the DOM which card is under the pointer feeds the result back into
    // the input: the row oscillates left/right at pointer-move frequency, which
    // reads as flicker (worst on fractional display scaling, e.g. 175%).
    const focusIndex =
      this.fanFocusStrength > 0
        ? Math.min(cards.length - 1, Math.max(0, Math.round(this.fanFocusX * (cards.length - 1))))
        : null;

    const layout = handLayout({
      count: cards.length,
      containerWidth,
      cardWidth,
      focusX: this.fanFocusX,
      focusStrength: this.fanFocusStrength,
      hoverIndex: focusIndex,
      lockCardWidth: true,
      focusPitchRatio: 1.15,
      contextPitchRatio: 0.1
    });

    // Gaps are capped at one card width, so a short row can be narrower than the
    // container; centre it rather than leaving a lopsided tail of empty space.
    const span = layout.span || containerWidth;
    const centreOffset = padLeft + hoverInset + Math.max(0, (containerWidth - span) / 2);

    let wrote = 0;
    layout.cards.forEach((card, index) => {
      const el = cards[index];
      if (!el) return;
      // The card is left-anchored at 0, so shift by centre minus half a card.
      // Snap to half pixels: at 175% display scaling a sub-pixel x is re-rounded
      // by the compositor every layout, which is visible as the row shimmering.
      const x = Number((card.x - card.width / 2 + centreOffset).toFixed(1));
      const sig = `${x}|${card.scale.toFixed(3)}|${card.lift.toFixed(2)}|${card.z}`;
      if (el.dataset.fanLayout === sig) return;
      el.dataset.fanLayout = sig;
      el.style.setProperty('--fan-x', `${x}px`);
      el.style.setProperty('--fan-scale', card.scale.toFixed(3));
      el.style.setProperty('--fan-lift', card.lift.toFixed(2));
      el.style.zIndex = String(card.z);
      wrote += 1;
    });

    this.dockTraceLastLayout = { cw: Math.round(containerWidth), span: Math.round(span) };
    if (wrote > 0) {
      this.traceDock({
        ev: 'layout',
        n: cards.length,
        cw: Math.round(containerWidth),
        span: Math.round(span),
        fx: Number(this.fanFocusX.toFixed(2)),
        fs: this.fanFocusStrength,
        changed: true
      });
    }
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
  /**
   * 冷却角标：每 250ms 把剩余秒数写回按钮，到点自动恢复可点。
   *
   * 冷却只存在于驱动层（见 `presentation.actionCooldownMs`），所以这里不需要一次
   * 新的状态同步来「解冻」按钮——时钟走完，按钮自己就活了。
   */
  private startCooldownTicker(dock: HTMLElement): void {
    if (this.cooldownTimer !== null) return;
    this.cooldownTimer = window.setInterval(() => {
      for (const card of dock.querySelectorAll<HTMLElement>('[data-cool-until]')) {
        const until = Number(card.dataset.coolUntil ?? 0);
        const left = until - Date.now();
        if (left <= 0) {
          delete card.dataset.coolUntil;
          card.classList.remove('cooling');
          card.querySelector('.act-cool')?.remove();
          continue;
        }
        const label = card.querySelector('.act-cool');
        if (label) label.textContent = `${Math.ceil(left / 1000)}s`;
      }
    }, 250);
  }

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

    // Fisheye focus follows the pointer: whichever card it is over opens up and
    // the rest compress into slivers (the dock behaves the same way).
    rail.addEventListener('mousemove', event => {
      const rect = rail.getBoundingClientRect();
      if (rect.height <= 0) return;
      const next = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      if (next === this.railFocusY) return;
      this.railFocusY = next;
      if (this.railFrame) return;
      this.railFrame = requestAnimationFrame(() => {
        this.railFrame = 0;
        this.layoutPlayerRail(rail);
      });
    });
    rail.addEventListener('mouseleave', () => {
      if (this.railFocusY === null) return;
      this.railFocusY = null;
      this.layoutPlayerRail(rail);
    });
  }

  /**
   * Player dossier, opened by clicking a seat nameplate on the board (or a card
   * in the rail when it carries effects). Shows everything the rail card shows
   * plus the full stat/track list, so a seat is never a dead click target.
   */
  public openPlayerSheet(player: UiPlayer): void {
    const layer = this.container.querySelector('#payload-layer') as HTMLElement | null;
    if (!layer) return;

    const avatar = player.avatarUrl
      ? `<img class="ps-avatar" src="${escHtml(player.avatarUrl)}" alt="" />`
      : `<span class="ps-avatar ps-emoji">${escHtml(player.avatar || '👤')}</span>`;

    const row = (label: string, value: string, dot?: string): string =>
      `<div class="ps-row"><span class="ps-k">${
        dot ? `<i class="ps-dot" style="--dot:${dot}"></i>` : ''
      }${escHtml(label)}</span><span class="ps-v">${value}</span></div>`;

    const stats = (player.stats ?? []).map(entry => row(entry.label, escHtml(entry.value))).join('');
    const pips = (player.pips ?? [])
      .map(pip =>
        row(
          pip.label,
          `${escHtml(String(pip.value))}${
            pip.modifier ? ` <em class="ps-mod">${pip.modifier > 0 ? '+' : ''}${pip.modifier}</em>` : ''
          }`,
          pip.color
        )
      )
      .join('');
    const effects = (player.effects ?? [])
      .map(
        effect => `<li class="fx-row ${effect.tone ?? 'neutral'}">
          <span class="fx-name">${escHtml(effect.label)}</span>
          <span class="fx-detail">${escHtml(effect.detail ?? '')}</span>
        </li>`
      )
      .join('');

    setHtml(layer, html`
      <div class="payload-backdrop"></div>
      <div class="payload-card player-sheet" style="--pc-color:${raw(player.color)}">
        <header class="ps-head">
          ${raw(avatar)}
          <div class="ps-id">
            <div class="ps-name">${player.name}</div>
            <div class="ps-sub">
              ${raw(player.roleLabel ? `${escHtml(player.roleLabel)} · ` : '')}${player.scoreLabel} ${raw(player.score)}${raw(player.alive ? '' : ' · 已出局')}
            </div>
          </div>
          <button type="button" class="pf-btn" id="ps-close">关闭</button>
        </header>
        <div class="ps-body">
          ${raw(stats)}${raw(pips)}
          ${raw(effects ? `<ul class="ps-fx">${effects}</ul>` : '')}
        </div>
      </div>
    `);
    layer.style.display = 'flex';

    const close = (): void => {
      layer.style.display = 'none';
      layer.replaceChildren();
    };
    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#ps-close')?.addEventListener('click', close);
  }

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

    setHtml(layer, html`
      <div class="payload-backdrop"></div>
      <div class="payload-card effects-window">
        <header class="rc-head">
          <span class="rc-floor">当前状态</span>
          <button type="button" class="pf-btn" id="fx-close">关闭</button>
        </header>
        <div class="rc-title">${player.name}</div>
        <ul class="fx-list">${raw(rows || '<li class="fx-row neutral"><span class="fx-name">无</span></li>')}</ul>
      </div>
    `);
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.replaceChildren();
    };
    layer.querySelector('.payload-backdrop')?.addEventListener('click', close);
    layer.querySelector('#fx-close')?.addEventListener('click', close);
  }

  private bindDockEvents(dock: HTMLElement): void {
    this.startCooldownTicker(dock);
    // Wheel over the dock cycles the held hand card, same as wheel over the slot.
    dock.addEventListener('wheel', event => this.handleHandWheel(event), { passive: false });
    const REST_HINT =
      '<span class="fh-label">悬停查看动作</span><span class="fh-detail">点击牌面执行该动作 · 数字键直接执行</span>';

    // The action row is a fisheye: the pointer position decides which gaps open
    // up. Delegated on the dock so it survives every reconcile.
    // Coalesce to one layout per animation frame: pointer events can arrive at
    // the display's refresh rate, and re-running the fisheye on each one restarts
    // every CSS transition mid-flight (visible as shimmer on 120Hz panels).
    let fanFrame = 0;
    const fanPointerBound = (event: PointerEvent) => {
      const fan = dock.querySelector('[data-fan]') as HTMLElement | null;
      if (!fan) return;
      const rect = fan.getBoundingClientRect();
      if (rect.width <= 0) return;
      this.fanFocusX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      this.fanFocusStrength = 1;
      this.dockTraceCounters.move += 1;
      if (fanFrame) return;
      fanFrame = requestAnimationFrame(() => {
        fanFrame = 0;
        const live = dock.querySelector('[data-fan]') as HTMLElement | null;
        if (live) this.layoutActionFan(live);
      });
    };
    dock.addEventListener('pointermove', fanPointerBound);
    dock.addEventListener('pointerleave', () => {
      const fan = dock.querySelector('[data-fan]') as HTMLElement | null;
      if (!fan) return;
      this.fanFocusStrength = 0;
      this.layoutActionFan(fan);
    });
    window.addEventListener('resize', () => this.relayoutDock());
    // The drawer animates its max-height; a resize observer catches every
    // intermediate width, and transitionend catches the settled state. Both
    // funnel into the same coalesced rAF so the fan is never measured while a
    // drawer is half-open (the measured reason all four cards sat at x=1).
    let lastDockSize = `${Math.round(dock.clientWidth)}x${Math.round(dock.clientHeight)}`;
    this.dockResizeObserver?.disconnect();
    this.dockResizeObserver = new ResizeObserver(() => {
      const size = `${Math.round(dock.clientWidth)}x${Math.round(dock.clientHeight)}`;
      if (size === lastDockSize) return;
      lastDockSize = size;
      this.relayoutDock();
    });
    this.dockResizeObserver.observe(dock);
    dock.addEventListener('transitionend', event => {
      if (event.target !== dock) return;
      if (event.propertyName !== 'max-height' && event.propertyName !== 'height') return;
      this.relayoutDock();
      this.notifyViewportInsets();
    });
    const dockHeld = dock.querySelector('[data-dock-held]') as HTMLElement | null;
    if (dockHeld) this.bindHandSlot(dockHeld);
    dock.addEventListener('click', event => {
      // 冷却角标每 250ms 刷一次：到点自动摘掉 disabled，不需要一次状态同步。
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
        // The drawer's max-height transition means the row has no usable width
        // in this frame; lay the cards out once the new box exists.
        requestAnimationFrame(() => this.relayoutDock());
        this.notifyViewportInsetsSoon();
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
        // 冷却未走完：不派发，只把剩余秒数说清楚（结算画面还在等着被读完）。
        const until = Number(card?.dataset.coolUntil ?? 0);
        if (until > Date.now()) {
          this.pushToast('⏳', `还需 ${Math.ceil((until - Date.now()) / 1000)} 秒才能开下一手`);
          event.stopPropagation();
          return;
        }
        const action = this.latest?.actions.find(candidate => candidate.id === id);
        if (action) this.openActionDetail(action);
      }
    });

    const bar = () => dock.querySelector('[data-fan-hint]') as HTMLElement | null;
    const showHint = (card: HTMLElement) => {
      const el = bar();
      if (!el) return;
      setHtml(
        el,
        html`<span class="fh-label">${card.dataset.fanLabel ?? ''}</span><span class="fh-detail">${card.dataset.fanHint ?? ''}</span>`
      );
      el.classList.add('active');
    };
    const hideHint = () => {
      const el = bar();
      if (!el) return;
      setHtml(el, raw(REST_HINT));
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

    setHtml(layer, html`
      <div class="payload-backdrop"></div>
      <div class="payload-card action-detail ${raw(toneClass)}">
        <header class="pf-head">
          <span class="pf-ico">${raw(action.icon)}</span>
          <div>
            <div class="pf-title">${raw(action.label)}</div>
            <div class="pf-hint">${raw(action.hint)}</div>
          </div>
        </header>
        <div class="pf-body">
          <div class="ad-row"><span class="ad-k">动作</span><span class="ad-v">${raw(action.actionType ?? action.id)}</span></div>
          ${raw(action.highlightIds?.length
              ? `<div class="ad-row"><span class="ad-k">可选目标</span><span class="ad-v">${action.highlightIds.length} 处</span></div>`
              : '')}
          ${raw(needsInput
              ? `<div class="ad-note">该动作需要补充参数，执行时会打开选择面板。</div>`
              : `<div class="ad-note">该动作无需额外参数，点击执行立即生效。</div>`)}
        </div>
        <footer class="pf-foot">
          <button type="button" class="pf-btn" id="ad-close">关闭</button>
          <button type="button" class="pf-btn primary" id="ad-run">执行</button>
        </footer>
      </div>
    `);
    layer.style.display = 'flex';

    const close = () => {
      layer.style.display = 'none';
      layer.replaceChildren();
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
    switch (executionRoute(deriveActionCard(action))) {
      case 'payload':
        this.openPayloadForm(action);
        return;
      case 'placement':
        if (action.highlightIds) this.ports.highlightBoard(action.highlightIds);
        else this.ports.highlightBoard(null);
        this.armPlacement(action);
        return;
      default:
        if (action.highlightIds) this.ports.highlightBoard(action.highlightIds);
        else this.ports.highlightBoard(null);
        this.performAction(action.id);
    }
  }

  private armPlacement(action: UiAction): void {
    const result = this.presenter.armPlacement(action.id);
    if (!result.ok) this.pushToast('⚠️', result.error ?? '无法进入放置模式');
  }
}
