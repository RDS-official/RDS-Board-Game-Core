import type { UiRoll } from '@rds/app/contracts';

/**
 * Dice roll overlay: a confirmation card, then a house silhouette in fog with
 * the dice settling inside it.
 *
 * Stage 1 (confirm): what is being checked, the explorer's value in that trait,
 * and what the roll will do. A progress rail counts down and auto-advances; a
 * click skips it. The roll has already happened in the kernel by the time this
 * renders — the card is a briefing, not an interactive confirmation.
 *
 * Stage 2 (dice): ~1s to appear, locked by ~2s, gone by ~3s. A click during the
 * tumble skips to the result; a click once the result is up dismisses it.
 *
 * Betrayal's dice are d6 printed 0/0/1/1/2/2, so a face is drawn as zero, one or
 * two pips rather than a normal d6 pattern.
 */

/** Stage 1 countdown before it advances on its own. */
const CONFIRM_MS = 10_000;
/** Stage 2 timings, from the brief. */
const APPEAR_MS = 1000;
const EXIT_MS = 3000;
/** How fast the faces cycle while spinning. */
const SPIN_TICK_MS = 70;
/** Input is ignored this long after mounting (see advance()). */
const INPUT_GRACE_MS = 260;
/** Minimum time the result stays readable after it locks. */
const READ_MS = 850;

const FACE_VALUES = [0, 1, 2];

const PIPS: Record<number, string> = {
  0: '<i class="pip ring"></i>',
  1: '<i class="pip mid"></i>',
  2: '<i class="pip tl"></i><i class="pip br"></i>'
};

const TRAIT_ZH: Record<string, string> = {
  speed: '速度',
  might: '力量',
  sanity: '神智',
  knowledge: '知识'
};

export interface DiceRollView {
  roll: UiRoll;
  /** Caption above the dice, e.g. "知识检定". */
  label?: string;
}

type Phase = 'confirm' | 'dice' | 'settled';

export class DiceRollOverlay {
  private root: HTMLElement | null = null;
  private timers: number[] = [];
  private spinTimer: number | null = null;
  private confirmTimer: number | null = null;
  private lastStamp: string | null = null;
  private phase: Phase = 'confirm';
  private shownAt = 0;
  private closed = true;
  private view: DiceRollView | null = null;
  private onKey: ((event: KeyboardEvent) => void) | null = null;

  constructor(private readonly host: HTMLElement) {}

  public get visible(): boolean {
    return !!this.root;
  }

  public get stamp(): string | null {
    return this.lastStamp;
  }

  /**
   * Show a roll. Re-showing the same stamp is a no-op, so a re-render of the
   * HUD cannot restart the animation.
   */
  public show(view: DiceRollView): void {
    if (view.roll.stamp === this.lastStamp) return;
    this.lastStamp = view.roll.stamp;
    this.close(true);
    this.view = view;
    this.build(view);

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (reduced) {
      // No spin, no float, no countdown: straight to the result.
      this.toDice();
      this.settle();
      this.timers.push(window.setTimeout(() => this.close(), 1600));
      return;
    }

    this.startConfirmCountdown();
  }

  public close(silent = false): void {
    if (this.closed && !this.root) return;
    this.stopSpin();
    this.stopConfirm();
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
    if (this.onKey) {
      window.removeEventListener('keydown', this.onKey);
      this.onKey = null;
    }

    const root = this.root;
    this.root = null;
    this.phase = 'confirm';
    this.closed = true;
    if (!root) return;

    if (silent) {
      root.remove();
      return;
    }
    root.classList.add('is-out');
    window.setTimeout(() => root.remove(), 420);
  }

  /* ------------------------------------------------------------------ */

  private build(view: DiceRollView): void {
    const roll = view.roll;
    const traitName = roll.trait ? TRAIT_ZH[roll.trait] ?? roll.trait : '';
    const root = document.createElement('div');
    root.className = 'dice-overlay is-confirm';
    root.setAttribute('role', 'button');
    root.tabIndex = 0;
    root.setAttribute(
      'aria-label',
      `${view.label ?? '检定'}${
        roll.threshold === undefined ? '' : `，需达到 ${roll.threshold}`
      }，点击跳过`
    );

    const valueLine =
      roll.traitValue === undefined
        ? ''
        : `<div class="confirm-value"><span class="cv-label">你的${traitName || '能力'}</span><b>${
            roll.traitValue
          }</b></div>`;

    const needLine =
      roll.threshold === undefined
        ? ''
        : `<div class="confirm-need">需要 <b>${roll.threshold}</b> 及以上</div>`;

    const effectLine = roll.effect
      ? `<p class="confirm-effect">${roll.effect}</p>`
      : roll.threshold === undefined
      ? ''
      : `<p class="confirm-effect">达到 ${roll.threshold} 即成功，低于则失败。</p>`;

    // What the result costs or grants, in the module's own words. Falls back to a
    // plain restatement so the line is never empty.
    const consequence = roll.effect
      ? roll.effect
      : roll.threshold === undefined
        ? ''
        : roll.success
          ? `达到 ${roll.threshold}，本次检定通过`
          : `未达到 ${roll.threshold}，本次检定失败`;

    const verdict =
      roll.threshold === undefined
        ? ''
        : `<span class="dice-verdict ${roll.success ? 'ok' : 'fail'}">${
            roll.success ? '成功' : '失败'
          } · ${roll.total} / ${roll.threshold}</span>`;

    root.innerHTML = `
      <div class="dice-fog" aria-hidden="true"></div>
      <div class="dice-stage">
        <div class="house-wrap" aria-hidden="true">
          <svg class="dice-house" viewBox="0 0 260 200">
            <!-- trees flanking the house -->
            <g class="house-trees">
              <path d="M18 178l11-34 11 34z" />
              <path d="M31 178l9-25 9 25z" />
              <path d="M8 178l8-22 8 22z" />
              <path d="M226 178l12-38 12 38z" />
              <path d="M241 178l9-27 9 27z" />
            </g>
            <!-- main house -->
            <path d="M46 178V80h140v98z" />
            <path d="M38 82L116 20l78 62z" />
            <path d="M150 44h16v36h-16z" />
            <!-- tower -->
            <path d="M186 178V62h40v116z" />
            <path d="M180 64L206 26l26 38z" />
            <!-- openings -->
            <rect x="104" y="128" width="30" height="50" rx="4" class="dice-house-hole" />
            <rect x="62" y="104" width="18" height="24" rx="3" class="dice-house-hole" />
            <rect x="152" y="104" width="18" height="24" rx="3" class="dice-house-hole" />
            <rect x="196" y="120" width="18" height="26" rx="3" class="dice-house-hole" />
          </svg>
          <!-- the tower's dim red lamp, kept out of the house blur -->
          <span class="house-lamp"></span>
        </div>

        <div class="dice-caption">${view.label ?? '检定'}</div>

        <div class="confirm-panel">
          <div class="confirm-text">
            ${valueLine}
            ${needLine}
            ${effectLine}
          </div>
          <div class="confirm-rail" aria-hidden="true">
            <span class="cr-line"></span>
            <span class="cr-knob"></span>
          </div>
        </div>

        <div class="dice-panel">
          <div class="dice-row" data-dice></div>
          <div class="dice-total"><b data-total>?</b><span>点数</span></div>
          <div class="dice-verdict-slot">${verdict}<p class="dice-consequence">${consequence}</p></div>
        </div>

      </div>
      <div class="dice-hint" data-hint>点击跳过</div>
    `;

    root.addEventListener('click', event => {
      event.preventDefault();
      this.advance();
    });
    // Bound on window: the overlay is a click surface, not a focused control, so
    // a listener on the element itself would never see a key press.
    this.onKey = event => {
      if (event.key === 'Escape') {
        // Escape means "get out of the way", not "show me the result first".
        event.preventDefault();
        this.close();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.advance();
      }
    };
    window.addEventListener('keydown', this.onKey);

    this.host.append(root);
    this.root = root;
    this.phase = 'confirm';
    this.shownAt = performance.now();
    this.closed = false;
    requestAnimationFrame(() => root.classList.add('is-in'));

    this.renderDice(roll.dice.map(() => this.randomFace()));
  }

  /** Any input: skip the briefing, skip the tumble, then dismiss. */
  private advance(): void {
    if (!this.root) return;
    // The overlay mounts under the cursor of the click that triggered the roll,
    // so the tail of that same click can land on it.
    if (performance.now() - this.shownAt < INPUT_GRACE_MS) return;

    if (this.phase === 'confirm') {
      this.toDice();
      return;
    }
    if (this.phase === 'dice') {
      this.settle();
      return;
    }
    this.close();
  }

  /* ---- stage 1 ------------------------------------------------------- */

  private startConfirmCountdown(): void {
    const rail = this.root?.querySelector('.confirm-rail') as HTMLElement | null;
    if (rail) rail.style.setProperty('--confirm-ms', `${CONFIRM_MS}ms`);
    this.confirmTimer = window.setTimeout(() => this.toDice(), CONFIRM_MS);
  }

  private stopConfirm(): void {
    if (this.confirmTimer !== null) {
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  /** Leave the briefing and start the dice stage. */
  private toDice(): void {
    if (!this.root || this.phase !== 'confirm') return;
    this.stopConfirm();
    this.phase = 'dice';
    this.root.classList.remove('is-confirm');
    this.root.classList.add('is-dice');
    const hint = this.root.querySelector('[data-hint]');
    if (hint) hint.textContent = '点击继续';
    this.startSpin();
    this.timers.push(window.setTimeout(() => this.settle(), APPEAR_MS));
  }

  /* ---- stage 2 ------------------------------------------------------- */

  private startSpin(): void {
    this.stopSpin();
    this.spinTimer = window.setInterval(() => {
      const count = this.view?.roll.dice.length ?? 0;
      this.renderDice(Array.from({ length: count }, () => this.randomFace()));
    }, SPIN_TICK_MS);
  }

  private stopSpin(): void {
    if (this.spinTimer !== null) {
      window.clearInterval(this.spinTimer);
      this.spinTimer = null;
    }
  }

  /** Lock the dice onto the real faces and reveal the total. */
  private settle(): void {
    if (!this.root || !this.view) return;
    this.stopSpin();
    this.phase = 'settled';
    this.root.classList.add('is-settled');
    this.renderDice(this.view.roll.dice);
    const total = this.root.querySelector('[data-total]');
    if (total) total.textContent = String(this.view.roll.total);

    // Timers drift when the roll's own work blocks the main thread, so if locking
    // landed late the exit stretches to give the result a readable beat.
    const now = performance.now();
    const closeAt = Math.max(this.shownAt + EXIT_MS, now + READ_MS);
    this.timers.push(window.setTimeout(() => this.close(), closeAt - now));
  }

  private renderDice(faces: number[]): void {
    const row = this.root?.querySelector('[data-dice]');
    if (!row) return;
    row.innerHTML = faces
      .map(
        (value, index) =>
          `<div class="die" data-face="${value}" style="--i:${index}">${PIPS[value] ?? ''}</div>`
      )
      .join('');
  }

  private randomFace(): number {
    return FACE_VALUES[Math.floor(Math.random() * FACE_VALUES.length)];
  }
}
