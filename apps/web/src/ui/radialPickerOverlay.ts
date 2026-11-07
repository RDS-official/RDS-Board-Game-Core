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

export interface RadialPickerOpenOptions {
  candidates: readonly RadialCandidate[];
  anchor: RadialPickerAnchor;
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
      this.resolve('cancel');
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
        this.resolve('cancel');
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
    const root = document.createElement('div');
    root.className = 'rp-layer';
    setHtml(
      root,
      raw(
        `<div class="rp-backdrop" data-rp-cancel></div>` +
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

    this.root = root;
    this.dialog = dialog;
    root.addEventListener('pointermove', this.onPointerMove);
    root.addEventListener('pointerup', this.onPointerUp);
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
    this.resolve('cancel');
  }

  private resolve(kind: 'cancel'): void {
    const callback = this.options?.onCancel;
    this.close();
    callback?.();
  }
}
