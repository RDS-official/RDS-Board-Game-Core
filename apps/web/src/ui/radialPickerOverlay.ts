import { escapeHtml } from '../htmlEscape';
import { raw, setHtml } from './dom/html';
import { buildWheel, type RadialCandidate, type RadialWheel } from './radialPicker';
import { radialPickerListHtml, radialPickerSvg } from './radialPickerHtml';
import {
  activeSegmentIndex,
  confirmFocus,
  createPickerState,
  moveFocus,
  optionId,
  type PickerIntent,
  type PickerState,
  pointAt,
} from './radialPickerModel';

/**
 * DOM overlay for the radial target picker (docs/INTERACTION-REDESIGN.md §4).
 *
 * The SVG and the accessible list come from `radialPickerHtml.ts`, and every
 * decision (which segment is focused, what Enter means) comes from the pure
 * `radialPickerModel.ts`. This class only translates real pointer/keyboard
 * events into those calls and paints the result — it holds no rules of its own.
 *
 * Placement is viewport-fixed at the anchor (the dragged card's centre). On a
 * coarse pointer the caller should lift the anchor so the wheel is not under the
 * finger; that offset is a caller concern, not a geometry one.
 */

export interface RadialPickerAnchor {
  x: number;
  y: number;
}

export type RadialPickerMode = 'click' | 'drag';

export interface RadialPickerOpenOptions {
  candidates: readonly RadialCandidate[];
  anchor: RadialPickerAnchor;
  /**
   * `click`：点击卡片后弹小轮盘，自己接指针（触屏/键盘回退路径）。
   * `drag`：拖拽途中浮现的大轮盘，指针事件仍由手牌条持有，调用方用
   * `setPointer()` / `resolveAt()` 驱动——两边不会抢同一个 pointer capture。
   */
  mode?: RadialPickerMode;
  /** Outer radius in CSS px. Defaults to 150. */
  radius?: number;
  /** Deterministic jitter seed. */
  seed?: number | string;
  /** Accessible/dialog title. */
  title?: string;
  onPick: (candidate: RadialCandidate, index: number) => void;
  onCenter: () => void;
  onCancel: () => void;
}

/** Ignore the tail of the gesture that opened the overlay. */
const INPUT_GRACE_MS = 120;

export class RadialPickerOverlay {
  private root: HTMLElement | null = null;
  private dialog: HTMLElement | null = null;
  private wheel: RadialWheel | null = null;
  private state: PickerState | null = null;
  private options: RadialPickerOpenOptions | null = null;
  private openedAt = 0;
  private mode: RadialPickerMode = 'click';

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.state || !this.dialog) return;
    const rect = this.dialog.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    this.state = pointAt(this.state, dx, dy);
    this.paint();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.state || performance.now() - this.openedAt < INPUT_GRACE_MS) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-rp-cancel]')) {
      this.resolve();
      return;
    }
    this.onPointerMove(event);
    this.resolveIntent(confirmFocus(this.state));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.state) return;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.resolve();
        return;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        this.state = moveFocus(this.state, 1);
        this.paint();
        return;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        this.state = moveFocus(this.state, -1);
        this.paint();
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.resolveIntent(confirmFocus(this.state));
        return;
      default:
        return;
    }
  };

  public isOpen(): boolean {
    return this.root !== null;
  }

  public open(options: RadialPickerOpenOptions): void {
    this.close();
    if (options.candidates.length === 0) return;
    const wheel = buildWheel(options.candidates, {
      radius: options.radius ?? 150,
      seed: options.seed ?? options.candidates.map((c) => c.id).join('|'),
    });
    this.options = options;
    this.wheel = wheel;
    this.state = createPickerState(wheel);
    this.openedAt = performance.now();

    const title = options.title ?? '选择目标';
    const mode: RadialPickerMode = options.mode ?? 'click';
    this.mode = mode;
    const root = document.createElement('div');
    root.className = 'rp-layer';
    root.dataset.mode = mode;
    setHtml(
      root,
      raw(
        (mode === 'drag'
          ? '<div class="rp-frost" data-rp-frost></div>'
          : '<div class="rp-backdrop" data-rp-cancel></div>') +
          `<div class="rp-dialog" role="dialog" aria-modal="true" tabindex="-1"` +
          ` aria-label="${escapeHtml(title)}">` +
          radialPickerSvg(wheel, { label: title }) +
          radialPickerListHtml(wheel, null, false, { label: title }) +
          `</div>`,
      ),
    );
    const dialog = root.querySelector('.rp-dialog') as HTMLElement | null;
    if (!dialog) return;
    dialog.style.left = `${options.anchor.x}px`;
    dialog.style.top = `${options.anchor.y}px`;
    // 1 geometry unit === 1 CSS px, so the hit-test math needs no rescaling.
    dialog.style.width = `${wheel.radius * 2}px`;
    dialog.style.height = `${wheel.radius * 2}px`;
    document.body.appendChild(root);

    // 磨砂只覆盖轮盘本体（按外轮廓 clip-path 裁切），手牌区与桌面其余部分保持原样。
    // 这样"拖回手牌 = 放回并关闭轮盘"在视觉上也是成立的。
    const frost = root.querySelector('.rp-frost') as HTMLElement | null;
    if (frost && mode === 'drag' && wheel.outline.length > 0) {
      const d =
        wheel.outline
          .map(([vx, vy], index) =>
            `${index === 0 ? 'M' : 'L'} ${(options.anchor.x + vx).toFixed(1)} ${(options.anchor.y + vy).toFixed(1)}`
          )
          .join(' ') + ' Z';
      frost.style.clipPath = `path("${d}")`;
      frost.style.setProperty('-webkit-clip-path', `path("${d}")`);
    }

    this.root = root;
    this.dialog = dialog;
    // 拖拽模式：指针归手牌条（它持有 capture），这里只被动更新高亮。
    if (mode === 'click') {
      root.addEventListener('pointermove', this.onPointerMove);
      root.addEventListener('pointerup', this.onPointerUp);
    }
    window.addEventListener('keydown', this.onKeyDown, true);
    // Accessible list is also clickable for mouse/assistive tech.
    root.addEventListener('click', this.onListClick);
    dialog.focus({ preventScroll: true });
    this.paint();
  }

  private readonly onListClick = (event: MouseEvent): void => {
    if (!this.state) return;
    const option = (event.target as HTMLElement | null)?.closest(
      '[data-seg-index],[data-zone="center"]',
    ) as HTMLElement | null;
    if (!option) return;
    if (option.dataset.zone === 'center') {
      const options = this.options;
      this.close();
      options?.onCenter();
      return;
    }
    const index = Number(option.dataset.segIndex);
    if (!Number.isInteger(index)) return;
    this.pickIndex(index);
  };

  /** 这个轮盘当前是什么模式（拖拽途中 vs 点击弹出）。 */
  public getMode(): RadialPickerMode {
    return this.mode;
  }

  /**
   * 指针在轮盘上的落点分类，供拖拽层决定"卡片放多大"：
   * 分区上要缩小（露出头像与提示），中心/轮盘外放大（看清自己打出去的牌）。
   */
  public zoneAt(x: number, y: number): 'center' | 'sector' | 'outside' {
    const local = this.localPoint(x, y);
    if (!local) return 'outside';
    const { wheel } = this;
    if (!wheel) return 'outside';
    const r = Math.hypot(local.dx, local.dy);
    if (r > wheel.radius * 1.12) return 'outside';
    if (r < wheel.innerRadius) return 'center';
    return 'sector';
  }

  /** 拖拽途中更新高亮（由手牌条转发指针坐标）。 */
  public setPointer(x: number, y: number): void {
    const local = this.localPoint(x, y);
    if (!local || !this.state) return;
    this.state = pointAt(this.state, local.dx, local.dy);
    this.paint();
  }

  /**
   * 松手结算：命中分区 → `{ type:'pick' }`；中心圆 → `{ type:'center' }`；
   * 轮盘外/无焦点 → `null`（调用方据此回弹卡片）。
   */
  public resolveAt(x: number, y: number): PickerIntent | null {
    const local = this.localPoint(x, y);
    if (!local || !this.state) {
      this.close();
      return null;
    }
    if (!this.wheel || Math.hypot(local.dx, local.dy) > this.wheel.radius * 1.12) {
      this.close();
      return null;
    }
    const intent = confirmFocus(pointAt(this.state, local.dx, local.dy));
    this.close();
    return intent;
  }

  /** 视口坐标 → 轮盘中心相对坐标；轮盘未打开时返回 null。 */
  private localPoint(x: number, y: number): { dx: number; dy: number } | null {
    if (!this.dialog || !this.wheel) return null;
    const rect = this.dialog.getBoundingClientRect();
    return { dx: x - (rect.left + rect.width / 2), dy: y - (rect.top + rect.height / 2) };
  }

  public close(): void {
    if (!this.root) return;
    this.root.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerup', this.onPointerUp);
    this.root.removeEventListener('click', this.onListClick);
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.root.remove();
    this.root = null;
    this.dialog = null;
    this.wheel = null;
    this.state = null;
    this.options = null;
  }

  private paint(): void {
    if (!this.root || !this.state || !this.wheel || !this.dialog) return;
    const active = activeSegmentIndex(this.state);
    const centreActive = this.state.focus.kind === 'center';

    for (const path of this.root.querySelectorAll<SVGElement>('.rp-seg')) {
      const index = Number(path.dataset.segIndex);
      path.classList.toggle('is-active', active === index);
    }
    this.root.querySelector('.rp-center')?.classList.toggle('is-active', centreActive);
    // 分区上的头像组跟着高亮：描边加粗 + 名字加亮（颜色之外的第二重编码）。
    for (const pin of this.root.querySelectorAll<SVGElement>('.rp-pin')) {
      pin.classList.toggle('is-active', active === Number(pin.dataset.segIndex));
    }
    this.root
      .querySelector('.rp-wheel')
      ?.classList.toggle('has-active', active !== null || centreActive);
    for (const option of this.root.querySelectorAll<HTMLElement>('.rp-list [role="option"]')) {
      const isCentre = option.dataset.zone === 'center';
      option.setAttribute(
        'aria-selected',
        String(isCentre ? centreActive : Number(option.dataset.segIndex) === active),
      );
    }
    const id = optionId(this.state);
    if (id) this.dialog.setAttribute('aria-activedescendant', id);
    else this.dialog.removeAttribute('aria-activedescendant');
  }

  private pickIndex(index: number): void {
    const candidate = this.wheel?.segments[index]?.candidate;
    if (!candidate) return;
    const options = this.options;
    this.close();
    options?.onPick(candidate, index);
  }

  private resolveIntent(intent: PickerIntent | null): void {
    if (!intent) return;
    if (intent.type === 'pick') {
      const options = this.options;
      this.close();
      options?.onPick(intent.candidate, intent.index);
      return;
    }
    if (intent.type === 'center') {
      const options = this.options;
      this.close();
      options?.onCenter();
      return;
    }
    this.resolve();
  }

  private resolve(): void {
    const callback = this.options?.onCancel;
    this.close();
    callback?.();
  }
}
