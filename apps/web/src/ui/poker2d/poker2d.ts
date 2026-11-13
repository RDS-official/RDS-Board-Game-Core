import type { GamePresenter, GameSnapshot, UiPlayer } from '@rds/app/contracts';
import { raw, setHtml } from '../dom/html';
import { parseCard, type PokerCard, SUIT_SYMBOL, rankLabel, evaluateBestHand } from './cards';
import './poker2d.css';

export interface Poker2DViewOptions {
  onSwitchMode: (mode: '2d' | '3d') => void;
  onLeaveTable: () => void;
  /** HUD 顶栏高度：极简 2D 保留菜单栏，牌桌必须从它下面开始。 */
  getChromeTop?: () => number;
}

interface SeatLayoutInfo {
  seatIndex: number;
  player: UiPlayer;
  xPercent: number;
  yPercent: number;
  isHero: boolean;
  isDealer: boolean;
  isSb: boolean;
  isBb: boolean;
  isTurn: boolean;
  isFolded: boolean;
  isWinner: boolean;
  betChips: number;
  lastAction?: string;
  cards: string[]; // card IDs
}

export class Poker2DView {
  private readonly container: HTMLElement;
  private readonly rootEl: HTMLElement;
  private readonly session: GamePresenter;
  private readonly options: Poker2DViewOptions;

  private latestSnapshot: GameSnapshot | null = null;
  private currentRaiseAmount = 20;
  private raiseSliderTouched = false;

  private timerInterval: number | null = null;
  private turnStartAt = 0;
  private currentActivePlayerId: string | null = null;
  private showSettlementModal = true;
  private lastSettledHandNo = -1;

  constructor(container: HTMLElement, session: GamePresenter, options: Poker2DViewOptions) {
    this.container = container;
    this.session = session;
    this.options = options;

    this.rootEl = document.createElement('div');
    this.rootEl.id = 'poker-2d-root';
    this.container.appendChild(this.rootEl);

    this.bindEvents();
    window.addEventListener('resize', this.onWindowResize, { passive: true });
  }

  /** 顶栏换行/缩放会改高度，2D 视图每次窗口变化重新让位。 */
  private readonly onWindowResize = (): void => {
    if (this.rootEl.style.display !== 'none') this.applyChromeTop();
  };

  private applyChromeTop(): void {
    const top = Math.max(0, Math.round(this.options.getChromeTop?.() ?? 0));
    this.rootEl.style.setProperty('--p2d-top-inset', `${top}px`);
  }

  public show(): void {
    this.rootEl.style.display = 'flex';
    this.applyChromeTop();
  }

  public hide(): void {
    this.rootEl.style.display = 'none';
  }

  public destroy(): void {
    window.removeEventListener('resize', this.onWindowResize);
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    this.rootEl.remove();
  }

  public update(snapshot: GameSnapshot): void {
    const prevActor = this.currentActivePlayerId;
    this.latestSnapshot = snapshot;
    this.currentActivePlayerId = snapshot.board.activePlayerId ?? null;

    // 行动者变化时重置读秒起点
    if (this.currentActivePlayerId !== prevActor) {
      this.turnStartAt = Date.now();
      this.raiseSliderTouched = false;
      this.startTurnTimer();
    }

    // 默认加注额对齐当前合法加注的最小值
    const raiseAct = snapshot.actions.find(a => a.actionType === 'RAISE');
    if (raiseAct && !this.raiseSliderTouched) {
      const field = raiseAct.fields?.[0];
      const minVal = Number(field?.min ?? 20);
      const defVal = Number(field?.default ?? minVal);
      this.currentRaiseAmount = defVal;
    }

    // 自动展示新一手结算
    const hand = snapshot.board.globalVars.hand as { handNo?: number; street?: string } | undefined;
    if (hand?.street === 'COMPLETE' && hand.handNo && hand.handNo !== this.lastSettledHandNo) {
      this.lastSettledHandNo = hand.handNo;
      this.showSettlementModal = true;
    } else if (hand?.street !== 'COMPLETE') {
      this.showSettlementModal = false;
    }

    this.render();
  }

  private startTurnTimer(): void {
    if (this.timerInterval !== null) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
    if (!this.currentActivePlayerId) return;

    this.timerInterval = window.setInterval(() => {
      const timerEl = this.rootEl.querySelector('.p2d-seat-box.active-turn .p2d-seat-timer') as HTMLElement | null;
      if (!timerEl) return;
      const totalMs = this.latestSnapshot?.turnDeadlineMs ?? 30000;
      const elapsed = Date.now() - this.turnStartAt;
      const remainingPct = Math.max(0, Math.min(100, (1 - elapsed / totalMs) * 100));
      timerEl.style.width = `${remainingPct}%`;
    }, 100);
  }

  private bindEvents(): void {
    this.rootEl.addEventListener('click', (ev: MouseEvent) => {
      const target = ev.target as HTMLElement;

      // 切换到 3D 视图
      if (target.closest('[data-p2d-switch-3d]')) {
        this.options.onSwitchMode('3d');
        return;
      }

      // 退出牌桌
      if (target.closest('[data-p2d-leave]')) {
        this.options.onLeaveTable();
        return;
      }

      // 关闭结算弹窗
      if (target.closest('[data-p2d-close-settle]')) {
        this.showSettlementModal = false;
        this.render();
        return;
      }

      // 快速加注预设
      const presetBtn = target.closest<HTMLElement>('[data-p2d-preset]');
      if (presetBtn && presetBtn.dataset.amount) {
        this.currentRaiseAmount = Number(presetBtn.dataset.amount);
        this.raiseSliderTouched = true;
        this.updateRaiseControlsDom();
        return;
      }

      // 步进按钮
      const stepBtn = target.closest<HTMLElement>('[data-p2d-step]');
      if (stepBtn && stepBtn.dataset.delta) {
        const delta = Number(stepBtn.dataset.delta);
        const raiseAct = this.latestSnapshot?.actions.find(a => a.actionType === 'RAISE');
        const field = raiseAct?.fields?.[0];
        const minVal = Number(field?.min ?? 20);
        const maxVal = Number(field?.max ?? 1000);
        this.currentRaiseAmount = Math.max(minVal, Math.min(maxVal, this.currentRaiseAmount + delta));
        this.raiseSliderTouched = true;
        this.updateRaiseControlsDom();
        return;
      }

      // 动作派发按钮
      const actBtn = target.closest<HTMLElement>('[data-action-id]');
      if (actBtn && actBtn.dataset.actionId) {
        const actId = actBtn.dataset.actionId;
        const actType = actBtn.dataset.actionType;
        if (actType === 'RAISE') {
          this.session.perform(actId, { amount: this.currentRaiseAmount });
        } else {
          this.session.perform(actId);
        }
      }
    });

    this.rootEl.addEventListener('input', (ev: Event) => {
      const target = ev.target as HTMLInputElement;
      if (target.classList.contains('p2d-raise-slider')) {
        this.currentRaiseAmount = Number(target.value);
        this.raiseSliderTouched = true;
        this.updateRaiseControlsDom();
      }
    });
  }

  private updateRaiseControlsDom(): void {
    const slider = this.rootEl.querySelector('.p2d-raise-slider') as HTMLInputElement | null;
    if (slider) slider.value = String(this.currentRaiseAmount);
    const valText = this.rootEl.querySelector('.p2d-raise-val') as HTMLElement | null;
    if (valText) valText.textContent = `$${this.currentRaiseAmount}`;
    const raiseActBtn = this.rootEl.querySelector('.p2d-act-btn.raise') as HTMLElement | null;
    if (raiseActBtn) {
      const sub = raiseActBtn.querySelector('.p2d-act-sub');
      if (sub) sub.textContent = `到 $${this.currentRaiseAmount}`;
    }
  }

  private render(): void {
    if (!this.latestSnapshot) return;
    const snap = this.latestSnapshot;
    const hand = (snap.board.globalVars.hand ?? {}) as {
      handNo?: number;
      street?: string;
      pot?: number;
      community?: string[];
      currentBet?: number;
      streetBets?: Record<string, number>;
      lastActions?: Record<string, string>;
      folded?: string[];
      allIn?: string[];
      buttonSeat?: number;
      sbSeat?: number;
      bbSeat?: number;
    };

    const seats = (snap.board.globalVars.seats ?? []) as { playerId: string; isAi: boolean }[];
    const lastHand = snap.board.globalVars.lastHand as {
      handNo?: number;
      endedBy?: string;
      pots?: { amount: number; winners: string[]; label: string }[];
      showdown?: { playerId: string; label: string; cards: string[] }[];
      players?: { playerId: string; wonAmount: number; invested: number; won: boolean }[];
    } | undefined;

    // 计算当前全桌总底池（已入池 + 本街未收进来的下注）
    const streetBetsTotal = Object.values(hand.streetBets ?? {}).reduce((s, b) => s + (Number(b) || 0), 0);
    const totalPot = (Number(hand.pot) || 0) + streetBetsTotal;

    // 解析座位几何排布
    const seatLayouts = this.computeSeatLayouts(snap, hand, seats, lastHand);

    // 计算 Hero 的当前牌型
    const heroHandEval = this.computeHeroHandEval(snap, hand);

    // 渲染整体界面
    const htmlString = `
      ${this.renderTopBar(hand)}
      <div class="p2d-stage">
        <div class="p2d-table-rail">
          <div class="p2d-felt">
            <div class="p2d-felt-watermark">TEXAS HOLD'EM</div>
            ${this.renderCenterArea(hand, totalPot, lastHand)}
          </div>
          <div class="p2d-seats-layer">
            ${seatLayouts.map(seat => this.renderSeatHtml(seat)).join('')}
          </div>
        </div>
        ${heroHandEval ? `<div class="p2d-hero-hand-eval">👑 当前牌型：<b>${heroHandEval}</b></div>` : ''}
        ${this.showSettlementModal && lastHand ? this.renderSettlementModalHtml(lastHand) : ''}
      </div>
      ${this.renderActionBar(snap, hand, totalPot)}
    `;

    setHtml(this.rootEl, raw(htmlString));
  }

  /** 计算 2~10 人的椭圆几何坐标，使 Hero 永远位于正下方底部 */
  private computeSeatLayouts(
    snap: GameSnapshot,
    hand: {
      buttonSeat?: number;
      sbSeat?: number;
      bbSeat?: number;
      streetBets?: Record<string, number>;
      lastActions?: Record<string, string>;
      folded?: string[];
      allIn?: string[];
    },
    seats: { playerId: string; isAi: boolean }[],
    lastHand?: { pots?: { winners: string[] }[]; showdown?: { playerId: string; cards: string[] }[] }
  ): SeatLayoutInfo[] {
    const players = snap.players;
    const count = players.length;
    if (count === 0) return [];

    // 找到 Hero 的索引
    const heroIndex = players.findIndex(p => p.id === snap.viewer);
    const baseHeroIdx = heroIndex >= 0 ? heroIndex : 0;

    // 椭圆半径参数（以 rail 尺寸为基准，百分比）
    const rx = 44;
    const ry = 38;

    const winnersSet = new Set(lastHand?.pots?.flatMap(p => p.winners) ?? []);
    const foldedSet = new Set(hand.folded ?? []);

    return players.map((player, origIdx) => {
      // 旋转使得 Hero 对应 displayIndex = 0 (正下方)
      const displayIdx = (origIdx - baseHeroIdx + count) % count;
      // 90度（PI/2）为正下方底部
      const angle = Math.PI / 2 + (displayIdx * 2 * Math.PI) / count;
      const xPercent = 50 + rx * Math.cos(angle);
      const yPercent = 50 + ry * Math.sin(angle);

      // 座位号与盲注/庄家标识匹配
      const seatPlanIdx = seats.findIndex(s => s.playerId === player.id);
      const isDealer = (seatPlanIdx >= 0 ? seatPlanIdx : origIdx) === hand.buttonSeat;
      const isSb = (seatPlanIdx >= 0 ? seatPlanIdx : origIdx) === hand.sbSeat;
      const isBb = (seatPlanIdx >= 0 ? seatPlanIdx : origIdx) === hand.bbSeat;
      const isTurn = snap.board.activePlayerId === player.id;
      const isHero = player.id === snap.viewer;
      const isFolded = foldedSet.has(player.id);
      const isWinner = winnersSet.has(player.id);
      const betChips = Number(hand.streetBets?.[player.id] ?? 0);
      const lastAction = hand.lastActions?.[player.id];

      // 底牌获取
      let cards: string[] = [];
      if (isHero) {
        cards = (snap.hand ?? []).map(c => c.entityId);
      } else {
        // 摊牌阶段若在 showdown 列表中有牌则亮出
        const sdItem = lastHand?.showdown?.find(s => s.playerId === player.id);
        if (sdItem && sdItem.cards && sdItem.cards.length > 0) {
          // showdown 牌是 'A♠' 格式，转为 entityId 或直接携带
          cards = sdItem.cards;
        } else {
          // 普通阶段在玩玩家两张暗牌
          const zone = snap.board.zones[`zone_hand_${player.id}`];
          const len = zone?.orderedEntities?.length ?? 2;
          cards = new Array(len).fill('BACK');
        }
      }

      return {
        seatIndex: origIdx,
        player,
        xPercent,
        yPercent,
        isHero,
        isDealer,
        isSb,
        isBb,
        isTurn,
        isFolded,
        isWinner,
        betChips,
        lastAction,
        cards
      };
    });
  }

  /** 计算 Hero 的当前最佳牌力文本 */
  private computeHeroHandEval(
    snap: GameSnapshot,
    hand: { community?: string[] }
  ): string | null {
    const heroHole = (snap.hand ?? []).map(c => parseCard(c.entityId)).filter((c): c is PokerCard => !!c);
    if (heroHole.length < 2) return null;

    const commCards = (hand.community ?? []).map(id => parseCard(id)).filter((c): c is PokerCard => !!c);
    const label = evaluateBestHand([...heroHole, ...commCards]);
    return label || null;
  }

  private renderTopBar(hand: { handNo?: number; street?: string }): string {
    const handNo = hand.handNo ?? 1;

    return `
      <div class="p2d-topbar">
        <div class="p2d-topbar-left">
          <span class="p2d-2d-badge">2D 极简</span>
          <div class="p2d-table-meta">第 ${handNo} 手 · 盲注 5/10</div>
        </div>
        <div class="p2d-topbar-right">
          <button class="p2d-btn p2d-btn-switch" data-p2d-switch-3d title="切换为 3D 拟真桌面">
            🔄 切换 3D
          </button>
          <button class="p2d-btn p2d-btn-danger" data-p2d-leave title="退出本场牌桌">
            ✕ 退出
          </button>
        </div>
      </div>
    `;
  }

  private renderCenterArea(
    hand: { community?: string[]; street?: string },
    totalPot: number,
    _lastHand?: { pots?: { amount: number; winners: string[]; label: string }[] }
  ): string {
    const commCards = hand.community ?? [];
    const streetLabel = this.streetText(hand.street);

    return `
      <div class="p2d-center-area">
        <div class="p2d-pot-wrap">
          <div class="p2d-pot-badge">
            <span>🪙</span>
            <span>总底池: $${totalPot}</span>
          </div>
          <div class="p2d-street-badge">${streetLabel}</div>
        </div>
        <div class="p2d-community-cards">
          ${[0, 1, 2, 3, 4].map(idx => {
            const cardIdStr = commCards[idx];
            if (cardIdStr) {
              return this.renderCardHtml(cardIdStr);
            }
            return '<div class="p2d-card-slot"></div>';
          }).join('')}
        </div>
      </div>
    `;
  }

  private renderSeatHtml(seat: SeatLayoutInfo): string {
    const boxClasses = [
      'p2d-seat-box',
      seat.isHero ? 'is-hero' : '',
      seat.isTurn ? 'active-turn' : '',
      seat.isFolded ? 'folded' : '',
      seat.isWinner ? 'winner' : ''
    ].filter(Boolean).join(' ');

    // 桌面下注筹码位置：从座位往桌面中心 (50, 50) 靠近 35%
    const betX = 50 + (seat.xPercent - 50) * 0.65;
    const betY = 50 + (seat.yPercent - 50) * 0.65;

    const actionBubbleClass = this.actionBubbleClass(seat.lastAction);

    return `
      <div class="p2d-seat" style="left: ${seat.xPercent}%; top: ${seat.yPercent}%;">
        ${seat.lastAction && !seat.isFolded ? `
          <div class="p2d-action-bubble ${actionBubbleClass}">${seat.lastAction}</div>
        ` : ''}

        <div class="${boxClasses}">
          ${seat.isDealer ? '<div class="p2d-dealer-btn" title="庄家位 (Button)">D</div>' : ''}
          ${seat.isSb ? '<div class="p2d-blind-tag sb" title="小盲注">SB</div>' : ''}
          ${seat.isBb ? '<div class="p2d-blind-tag bb" title="大盲注">BB</div>' : ''}

          <div class="p2d-seat-head">
            <span class="p2d-seat-avatar" style="background-color: ${seat.player.color || '#e0604e'};">
              ${seat.player.avatar || '♠'}
            </span>
            <span class="p2d-seat-name" title="${seat.player.name}">${seat.player.name}</span>
          </div>
          <div class="p2d-seat-chips">
            <span>🪙</span>
            <span>${seat.player.score}</span>
          </div>
          ${seat.isTurn ? '<div class="p2d-seat-timer"></div>' : ''}
        </div>

        <div class="p2d-seat-cards">
          ${seat.cards.map(cId => {
            if (cId === 'BACK') {
              return this.renderCardBackHtml(!seat.isHero);
            }
            return this.renderCardHtml(cId, !seat.isHero);
          }).join('')}
        </div>
      </div>

      ${seat.betChips > 0 ? `
        <div class="p2d-seat-bet" style="left: ${betX}%; top: ${betY}%; transform: translate(-50%, -50%);">
          <span>🪙</span>
          <span>${seat.betChips}</span>
        </div>
      ` : ''}
    `;
  }

  private renderActionBar(
    snap: GameSnapshot,
    hand: { street?: string; currentBet?: number; streetBets?: Record<string, number> },
    totalPot: number
  ): string {
    const isHeroTurn = snap.board.activePlayerId === snap.viewer;
    const actions = snap.actions;

    // 当手局结束或尚未开始
    if (hand.street === 'COMPLETE' || actions.some(a => a.actionType === 'START_HAND' || a.actionType === 'READY')) {
      const readyAct = actions.find(a => a.actionType === 'READY' || a.actionType === 'READY_UP');
      const startAct = actions.find(a => a.actionType === 'START_HAND' || a.actionType === 'FORCE_START');
      const showAct = actions.find(a => a.actionType === 'SHOW');
      const muckAct = actions.find(a => a.actionType === 'MUCK');
      const seatAct = actions.find(a => a.actionType === 'TAKE_SEAT');

      return `
        <div class="p2d-action-bar">
          <div class="p2d-main-actions">
            ${seatAct ? `
              <button class="p2d-act-btn start" data-action-id="${seatAct.id}" data-action-type="TAKE_SEAT">
                <span>入座</span>
              </button>
            ` : ''}
            ${readyAct ? `
              <button class="p2d-act-btn ready" data-action-id="${readyAct.id}" data-action-type="READY">
                <span>准备就绪</span>
                <span class="p2d-act-sub">等待下一手</span>
              </button>
            ` : ''}
            ${startAct ? `
              <button class="p2d-act-btn start" data-action-id="${startAct.id}" data-action-type="START_HAND">
                <span>发下一手</span>
                <span class="p2d-act-sub">开启牌局</span>
              </button>
            ` : ''}
            ${showAct ? `
              <button class="p2d-act-btn check" data-action-id="${showAct.id}" data-action-type="SHOW">
                <span>亮牌</span>
              </button>
            ` : ''}
            ${muckAct ? `
              <button class="p2d-act-btn fold" data-action-id="${muckAct.id}" data-action-type="MUCK">
                <span>埋牌</span>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }

    // 轮到 Hero 行动
    if (isHeroTurn && actions.length > 0) {
      const foldAct = actions.find(a => a.actionType === 'FOLD');
      const checkAct = actions.find(a => a.actionType === 'CHECK');
      const callAct = actions.find(a => a.actionType === 'CALL');
      const raiseAct = actions.find(a => a.actionType === 'RAISE');
      const allInAct = actions.find(a => a.actionType === 'ALL_IN');

      const raiseField = raiseAct?.fields?.[0];
      const minRaise = Number(raiseField?.min ?? 20);
      const maxRaise = Number(raiseField?.max ?? 1000);
      const step = Number(raiseField?.step ?? 10);

      // 计算快捷加注倍率预设值
      const halfPot = Math.min(maxRaise, Math.max(minRaise, Math.round(totalPot / 2)));
      const fullPot = Math.min(maxRaise, Math.max(minRaise, Math.round(totalPot)));
      const doubleBet = Math.min(maxRaise, Math.max(minRaise, minRaise * 2));
      const tripleBet = Math.min(maxRaise, Math.max(minRaise, minRaise * 3));

      return `
        <div class="p2d-action-bar">
          ${raiseAct ? `
            <div class="p2d-raise-controls">
              <div class="p2d-raise-presets">
                <button class="p2d-preset-btn" data-p2d-preset data-amount="${minRaise}">最小 ($${minRaise})</button>
                <button class="p2d-preset-btn" data-p2d-preset data-amount="${doubleBet}">2x ($${doubleBet})</button>
                <button class="p2d-preset-btn" data-p2d-preset data-amount="${tripleBet}">3x ($${tripleBet})</button>
                <button class="p2d-preset-btn" data-p2d-preset data-amount="${halfPot}">½池 ($${halfPot})</button>
                <button class="p2d-preset-btn" data-p2d-preset data-amount="${fullPot}">满池 ($${fullPot})</button>
                <button class="p2d-preset-btn" data-p2d-preset data-amount="${maxRaise}">全押 ($${maxRaise})</button>
              </div>
              <div class="p2d-raise-slider-row">
                <button class="p2d-step-btn" data-p2d-step data-delta="${-step}">-</button>
                <input type="range" class="p2d-raise-slider" min="${minRaise}" max="${maxRaise}" step="${step}" value="${this.currentRaiseAmount}" />
                <button class="p2d-step-btn" data-p2d-step data-delta="${step}">+</button>
                <div class="p2d-raise-val">$${this.currentRaiseAmount}</div>
              </div>
            </div>
          ` : ''}

          <div class="p2d-main-actions">
            ${foldAct ? `
              <button class="p2d-act-btn fold" data-action-id="${foldAct.id}" data-action-type="FOLD">
                <span>弃牌</span>
                <span class="p2d-act-sub">FOLD</span>
              </button>
            ` : ''}
            ${checkAct ? `
              <button class="p2d-act-btn check" data-action-id="${checkAct.id}" data-action-type="CHECK">
                <span>过牌</span>
                <span class="p2d-act-sub">CHECK</span>
              </button>
            ` : ''}
            ${callAct ? `
              <button class="p2d-act-btn call" data-action-id="${callAct.id}" data-action-type="CALL">
                <span>${callAct.label || '跟注'}</span>
                <span class="p2d-act-sub">CALL</span>
              </button>
            ` : ''}
            ${raiseAct ? `
              <button class="p2d-act-btn raise" data-action-id="${raiseAct.id}" data-action-type="RAISE">
                <span>加注</span>
                <span class="p2d-act-sub">到 $${this.currentRaiseAmount}</span>
              </button>
            ` : ''}
            ${allInAct ? `
              <button class="p2d-act-btn allin" data-action-id="${allInAct.id}" data-action-type="ALL_IN">
                <span>全押</span>
                <span class="p2d-act-sub">ALL-IN</span>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }

    // 非本人行动或观望状态
    const activePlayer = snap.players.find(p => p.id === snap.board.activePlayerId);
    const activeName = activePlayer ? activePlayer.name : '其他玩家';

    return `
      <div class="p2d-action-bar">
        <div class="p2d-waiting-banner">
          <span>⏳</span>
          <span>等待 <b>${activeName}</b> 行动中…</span>
        </div>
      </div>
    `;
  }

  private renderSettlementModalHtml(
    lastHand: {
      handNo?: number;
      endedBy?: string;
      pots?: { amount: number; winners: string[]; label: string }[];
      showdown?: { playerId: string; label: string; cards: string[] }[];
      players?: { playerId: string; wonAmount: number; invested: number; won: boolean }[];
    }
  ): string {
    const pots = lastHand.pots ?? [];
    const mainPot = pots[0];
    const winnerNames = (mainPot?.winners ?? []).map(pid => {
      const p = this.latestSnapshot?.players.find(pl => pl.id === pid);
      return p ? p.name : pid;
    }).join('、');

    const titleText = lastHand.endedBy === 'FOLD'
      ? `${winnerNames} 获胜（其他玩家弃牌）`
      : `${winnerNames} 以【${mainPot?.label || '高牌'}】赢得底池 $${mainPot?.amount ?? 0}`;

    const showdown = new Map((lastHand.showdown ?? []).map(line => [line.playerId, line]));
    const snap = this.latestSnapshot;

    return `
      <div class="p2d-settlement-modal">
        <div class="p2d-settlement-title">🏆 ${titleText}</div>
        <div class="p2d-settlement-list">
          ${(lastHand.players ?? []).map(pItem => {
            const player = snap?.players.find(pl => pl.id === pItem.playerId);
            const name = player?.name ?? pItem.playerId;
            const net = pItem.wonAmount - pItem.invested;
            const netStr = net > 0 ? `+${net}` : String(net);
            const netClass = net > 0 ? 'p2d-settlement-gain' : net < 0 ? 'p2d-settlement-loss' : 'p2d-settlement-neutral';
            // 只有摊牌真亮出的牌才展示牌面与牌型；弃牌结束、或对手没亮牌时一律背面朝上——
            // 结算不能替别人翻开手牌，牌局结束瞬间本人底牌也已从状态里清掉。
            const line = showdown.get(pItem.playerId);
            const holeCards = (line?.cards ?? []).map(id => parseCard(id)).filter((card): card is PokerCard => !!card);
            const bestLabel = line?.label ?? '';
            const faces = holeCards.length > 0
              ? holeCards.map(card => this.renderCardHtml(`card_${card.suit}${card.rank}`, true)).join('')
              : this.renderCardBackHtml(true) + this.renderCardBackHtml(true);
            return `
              <div class="p2d-settlement-row">
                <div class="p2d-settlement-id">
                  <span class="p2d-settlement-name">${name}</span>
                  ${bestLabel ? `<span class="p2d-settlement-hand" title="本手最大牌型">${bestLabel}</span>` : ''}
                </div>
                <div class="p2d-settlement-cards">${faces}</div>
                <span class="${netClass}">${netStr} 筹码</span>
              </div>
            `;
          }).join('')}
        </div>
        <div style="display:flex; justify-content:center; gap:10px; margin-top:8px;">
          <button class="p2d-btn p2d-btn-ghost" data-p2d-close-settle>收起复盘</button>
        </div>
      </div>
    `;
  }

  private renderCardHtml(cardStr: string, isMini = false): string {
    const cardObj = parseCard(cardStr);
    const suit = cardObj ? cardObj.suit : 's';
    const rank = cardObj ? cardObj.rank : 14;

    const isRed = suit === 'h' || suit === 'd';
    const suitSym = SUIT_SYMBOL[suit as keyof typeof SUIT_SYMBOL] ?? '♠';
    const rankStr = rankLabel(rank);
    const colorClass = isRed ? 'red' : 'black';
    const sizeClass = isMini ? 'p2d-card-mini' : '';

    return `
      <div class="p2d-card ${colorClass} ${sizeClass}">
        <span class="p2d-card-rank">${rankStr}</span>
        <span class="p2d-card-center-suit">${suitSym}</span>
      </div>
    `;
  }

  private renderCardBackHtml(isMini = false): string {
    const sizeClass = isMini ? 'p2d-card-mini' : '';
    return `
      <div class="p2d-card back ${sizeClass}">
        <div class="p2d-card-back-pattern"></div>
      </div>
    `;
  }

  private streetText(street?: string): string {
    switch (street) {
      case 'PREFLOP': return '翻牌前 PREFLOP';
      case 'FLOP': return '翻牌圈 FLOP';
      case 'TURN': return '转牌圈 TURN';
      case 'RIVER': return '河牌圈 RIVER';
      case 'COMPLETE': return '摊牌结算 SHOWDOWN';
      default: return '准备阶段';
    }
  }

  private actionBubbleClass(action?: string): string {
    if (!action) return '';
    if (action.includes('弃牌') || action.includes('FOLD')) return 'fold';
    if (action.includes('过牌') || action.includes('CHECK')) return 'check';
    if (action.includes('跟注') || action.includes('CALL')) return 'call';
    if (action.includes('加注') || action.includes('RAISE')) return 'raise';
    if (action.includes('全押') || action.includes('ALL')) return 'allin';
    return '';
  }
}
