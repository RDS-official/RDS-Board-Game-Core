import type { UiDetailView } from '@rds/app/contracts';

/**
 * One arbitrating stack for every overlay that describes a subject.
 *
 * The HUD used to run two independent channels — a hover chip and a framed card
 * sheet — that killed each other on arrival. Whichever came last won, so the same
 * card could be previewed with one picture and detailed with another, and a stray
 * pointer move could reopen the wrong overlay. Both now go through here, which
 * enforces three invariants:
 *
 *  1. **One view per subject.** At most one entry exists for a given detail key,
 *     so a preview can never sit beside a sheet for the same card.
 *  2. **Strength ordering.** `peek` < `pinned` < `modal`. A pointer drifting over
 *     the board can never displace something the player deliberately opened, and
 *     nothing displaces a modal.
 *  3. **Explicit closes.** Entries disappear because someone closed them or
 *     because a stronger entry took over — never because a weaker one appeared.
 *
 * The arbiter holds no DOM: it is a pure state machine, so its rules are unit
 * testable without a browser.
 */
export type OverlayMode = 'peek' | 'pinned' | 'modal';

export interface OverlayRequest {
  /** Which component opened this; a host may close its own overlays wholesale. */
  owner: string;
  mode: OverlayMode;
  view: UiDetailView;
  /** Sheet footer line. */
  footer?: string;
  /** Reveal sheets announce themselves and auto-dismiss sooner. */
  reveal?: boolean;
}

export interface OverlayEntry extends OverlayRequest {
  /** Monotonic stamp, so a repaint can tell a fresh entry from a stale one. */
  stamp: number;
}

export interface OverlayState {
  peek?: OverlayEntry;
  pinned?: OverlayEntry;
  modal?: OverlayEntry;
}

export interface OverlayResult {
  accepted: boolean;
  /** Why the request was refused: a stronger entry owns the screen. */
  reason?: 'busy-modal' | 'busy-pinned';
}

const MODES: OverlayMode[] = ['peek', 'pinned', 'modal'];

export class OverlayArbiter {
  private state: OverlayState = {};
  private stamp = 0;
  private readonly listeners = new Set<(state: OverlayState) => void>();

  /** Subscribe to state changes; the current state is not pushed on subscribe. */
  public subscribe(listener: (state: OverlayState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public current(): OverlayState {
    return this.state;
  }

  /** The entry that owns the sheet area (a modal wins over a pinned sheet). */
  public sheet(): OverlayEntry | undefined {
    return this.state.modal ?? this.state.pinned;
  }

  /**
   * Ask to show `request`. The result says whether it was accepted, so a caller
   * can fall back (keep the toast, skip the sheet) instead of assuming it showed.
   */
  public open(request: OverlayRequest): OverlayResult {
    if (request.mode === 'peek') {
      if (this.state.modal) return { accepted: false, reason: 'busy-modal' };
      if (this.state.pinned) return { accepted: false, reason: 'busy-pinned' };
      this.set('peek', request);
      return { accepted: true };
    }
    if (request.mode === 'pinned') {
      if (this.state.modal) return { accepted: false, reason: 'busy-modal' };
      // A deliberate open supersedes any preview, same subject or not: the sheet
      // already says everything the chip did, and two pictures read as two cards.
      this.state = { pinned: this.entry(request) };
      this.publish();
      return { accepted: true };
    }
    // modal: takes the whole overlay area, clearing everything weaker.
    this.state = { modal: this.entry(request) };
    this.publish();
    return { accepted: true };
  }

  /** Close the entry in one slot, or every slot when no mode is given. */
  public close(mode?: OverlayMode): void {
    if (!mode) {
      this.closeAll();
      return;
    }
    if (!this.state[mode]) return;
    const next: OverlayState = { ...this.state };
    delete next[mode];
    this.state = next;
    this.publish();
  }

  /** Close whatever describes `key`, whichever slot holds it. */
  public closeKey(key: string): void {
    const next: OverlayState = { ...this.state };
    let changed = false;
    for (const mode of MODES) {
      if (next[mode]?.view.key === key) {
        delete next[mode];
        changed = true;
      }
    }
    if (!changed) return;
    this.state = next;
    this.publish();
  }

  /** Close everything owned by `owner`, or everything at all. */
  public closeAll(owner?: string): void {
    const empty = !this.state.peek && !this.state.pinned && !this.state.modal;
    if (empty) return;
    if (!owner) {
      this.state = {};
      this.publish();
      return;
    }
    const next: OverlayState = { ...this.state };
    for (const mode of MODES) {
      if (next[mode]?.owner === owner) delete next[mode];
    }
    this.state = next;
    this.publish();
  }

  private set(mode: 'peek', request: OverlayRequest): void {
    this.state = { ...this.state, [mode]: this.entry(request) };
    this.publish();
  }

  private entry(request: OverlayRequest): OverlayEntry {
    this.stamp += 1;
    return { ...request, stamp: this.stamp };
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}
