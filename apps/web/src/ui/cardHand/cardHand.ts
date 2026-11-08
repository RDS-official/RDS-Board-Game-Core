import { FLY_EASE, HOVER_EASE } from './easing';
import { ArcLayoutOptions, ArcSlot, arcLayout } from './layout';
import { Point, pointInPolygonWithPadding, polygonCentroid } from './polygon';
import { SpringConfig, SpringState, spring, springStep } from './spring';

/**
 * 统一动作手牌的物理层（docs/INTERACTION-AUDIT.md G3/G5/G6 的落地）：
 * 弧形排布 + hover 上浮/回正 + 邻居让位 + 跟手拖拽 + 弹簧回弹 + 出牌区高亮。
 *
 * 四条不变量（缺一条就会"跳"或"卡"）：
 *  1. **单写者**：transform / opacity / z-index 只由本文件的 `frame()` 写，CSS 不参与
 *     transform 过渡——否则 CSS transition 与 rAF 抢同一属性，肉眼看到的就是跳变。
 *  2. **帧内零布局读取**：容器矩形只在 measure()（ResizeObserver / sync）里测，
 *     指针坐标直接用事件的 clientX/Y。
 *  3. **可中断**：任何状态下新的 pointerdown 都能立即接管，接管基线取"当前渲染位"。
 *  4. **可静止**：弹簧与缓动都收敛，收敛后 rAF 自动停机，空闲 0 开销。
 *
 * 语义（谁负责执行动作）不在这里：单击/回车走 `onActivate`，松手在出牌区走 `onDrop`，
 * 是否合法一律由调用方（HUD → session）决定，本类只负责"手感"。
 */

export type CardHandState = 'idle' | 'hover' | 'armed' | 'dragging' | 'returning' | 'committing' | 'flying';

/** 一张牌的稳定身份 + 外观签名（签名变了才重建节点，否则只换文字）。 */
export interface HandCardItem {
  id: string;
  signature: string;
}

export interface CardHandConfig {
  /** 结构变化时构建一张卡的 DOM；返回 null 表示这张牌这次不该出现。 */
  createCard: (id: string) => HTMLElement | null;
  /** 出牌区多边形（视口坐标）。返回 null = 当前没有出牌区。 */
  playZone?: () => readonly Point[] | null;
  /** 出牌区元素：命中时挂 data-drop="valid|invalid"。 */
  playZoneElement?: () => HTMLElement | null;
  /** 单击 / 回车：查看或执行（由 HUD 决定）。 */
  onActivate?: (id: string) => void;
  /** 拖到出牌区松手：true = 已出牌（飞场并移除），false = 回弹。 */
  onDrop?: (id: string, at: Point) => boolean | Promise<boolean>;
  layout?: Partial<ArcLayoutOptions>;
  spring?: Partial<SpringConfig>;
  /** 回弹专用弹簧：比跟随稍软 + 松手速度灌入速度，才有"甩回去"的手感。 */
  returnSpring?: Partial<SpringConfig>;
  /** hover 过渡时长（ms）。150–200。 */
  hoverMs?: number;
  /** hover 上浮（px）。12–20。 */
  hoverLift?: number;
  /** hover 放大倍数。1.08–1.15。 */
  hoverScale?: number;
  /** 邻居让位位移（px）。 */
  neighbourPush?: number;
  /** 起拖阈值（px）。鼠标 4–6，触屏建议 8–10。 */
  slopPx?: number;
  /** 每 px/ms 速度对应的倾斜角（deg）。 */
  tiltPerPx?: number;
  /** 倾斜角上限（deg）。 */
  tiltMaxDeg?: number;
  /** 拖拽时整体放大倍数；`dragScaleFromViewport` 为真时按视口高度重算（默认开）。 */
  dragScale?: number;
  /** 拖起来的牌缩到"屏幕高度的 1/3"，保证看得清（默认开）。 */
  dragScaleFromViewport?: boolean;
  /** 视口缩放的封顶：避免 4K 屏上一张牌占满屏。 */
  dragMaxScale?: number;
  /**
   * 拖拽期间的相对缩放倍率：1 = "屏幕 1/3" 的大牌。
   * 返回 <1 时缩小——用来在指针悬到目标轮盘的分区上时让出位置，露出头像与提示。
   */
  dragScaleAt?: (at: Point) => number;
  /** 越过起拖阈值后触发一次（调用方在这里弹目标轮盘）。 */
  onDragStart?: (id: string, at: Point) => void;
  /** 拖拽过程中每次指针移动（驱动轮盘高亮）。 */
  onDragMove?: (at: Point) => void;
  /** 松手前的收尾（关闭轮盘、清掉高亮）。 */
  onDragEnd?: (at: Point) => void;
  /** 飞场落点（视口坐标）；未提供时退化为出牌区质心。 */
  flyTarget?: () => Point | null;
  /** 飞场时长（ms）。 */
  flyMs?: number;
  /** 飞场终点缩放。 */
  flyScale?: number;
  /** 区内判定外扩（px）。 */
  zonePadding?: number;
  /** 区外判定外扩（px，须小于 zonePadding → 滞回，边界不闪）。 */
  zoneExitPadding?: number;
  /** 单帧 dt 上限（s）。 */
  maxDt?: number;
  /** 每页张数；不传则按手牌条宽度自适应（4–9）。0 = 不分页。 */
  pageSize?: number;
  /** 页码变化（含首挂载）时回调，供 HUD 画「‹ 2/3 ›」。 */
  onPageChange?: (page: number, pageCount: number) => void;
}

interface CardView {
  id: string;
  signature: string;
  el: HTMLElement;
  slot: ArcSlot;
  x: SpringState;
  y: SpringState;
  rot: SpringState;
  scale: SpringState;
  /** 邻居让位目标（加在 slot.x 上）。 */
  pushTarget: number;
  /** hover 进度 0..1（按 HOVER_EASE 求值）。 */
  hover: number;
  hoverTarget: number;
  /** 出场 / 退场透明度。 */
  appear: number;
  appearTarget: number;
  tilt: number;
  lastZ: number;
  /** 上一帧的拖拽缩放：用来判断"正在变大"，据此强制重新栅格。 */
  lastDragScale: number;
  gone: boolean;
  fly?: { start: number; fromX: number; fromY: number; fromScale: number; toX: number; toY: number };
}

const DEFAULTS = {
  spring: { stiffness: 240, damping: 26, mass: 1 } as SpringConfig,
  returnSpring: { stiffness: 210, damping: 23, mass: 1 } as SpringConfig,
  hoverMs: 170,
  hoverLift: 16,
  hoverScale: 1.1,
  neighbourPush: 12,
  slopPx: 6,
  tiltPerPx: 0.35,
  tiltMaxDeg: 9,
  dragScale: 1.06,
  dragMaxScale: 2.8,
  flyMs: 260,
  flyScale: 0.8,
  zonePadding: 14,
  zoneExitPadding: 4,
  maxDt: 0.032
};

export class CardHand {
  private readonly root: HTMLElement;
  private readonly config: CardHandConfig;
  private readonly springs: { follow: SpringConfig; back: SpringConfig };
  private readonly views = new Map<string, CardView>();
  /** 全量卡片（含未挂载的页），按展示顺序。 */
  private readonly order: string[] = [];
  private readonly items = new Map<string, HandCardItem>();
  private page = 0;
  private pageSize = 0;
  private readonly rootRect = { left: 0, top: 0, width: 0, height: 0 };
  private readonly resizeObserver?: ResizeObserver;

  private state: CardHandState = 'idle';
  private drag: {
    view: CardView;
    pointerId: number;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    lastX: number;
    lastTime: number;
    velX: number;
    moved: boolean;
    /** "屏幕 1/3 高度"那档放大（起拖时测一次）。 */
    bigScale: number;
    /** 相对倍率：1 = 上面那档；悬在轮盘分区上时会收到 ~0.4。 */
    scaleMul: number;
    scaleMulTarget: number;
  } | null = null;
  private hovered: CardView | null = null;
  /** 拖拽期间被抬高的外壳（卡片所在的 .app-shell）：Wheel 浮层在 body 上，只抬手牌条没意义。 */
  private raisedShell: HTMLElement | null = null;
  private inZone = false;
  private suppressClick = false;
  private rafId = 0;
  private lastNow = 0;
  private reduced = false;
  private destroyed = false;

  public constructor(root: HTMLElement, config: CardHandConfig) {
    this.root = root;
    this.config = config;
    this.springs = {
      follow: { ...DEFAULTS.spring, ...(config.spring ?? {}) },
      back: { ...DEFAULTS.returnSpring, ...(config.returnSpring ?? {}) }
    };
    this.root.dataset.physics = '1';
    this.reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.root.addEventListener('pointerdown', this.onPointerDown);
    this.root.addEventListener('pointermove', this.onPointerMove);
    this.root.addEventListener('pointerup', this.onPointerUp);
    this.root.addEventListener('pointercancel', this.onPointerCancel);
    this.root.addEventListener('pointerleave', this.onPointerLeave);
    this.root.addEventListener('click', this.onClick);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.measure());
      this.resizeObserver.observe(this.root);
    }
    this.measure();
  }

  /* -------------------------------------------------------------- 同步 DOM */

  /**
   * 把 HUD 的卡片清单同步进来：按 id 复用节点，签名变化才重建。
   * 正在飞场的卡不会被同步打断（否则"打出"会被下一帧快照吞掉）。
   */
  public sync(items: readonly HandCardItem[]): void {
    if (this.destroyed) return;
    this.items.clear();
    this.order.length = 0;
    for (const item of items) {
      this.items.set(item.id, item);
      this.order.push(item.id);
    }
    // 翻页后总数可能变少：先把页码夹回合法区间，再挂载本页。
    const pageCount = this.pageCount();
    this.page = Math.min(this.page, Math.max(0, pageCount - 1));
    this.mountPage();
    this.config.onPageChange?.(this.page, pageCount);
  }

  public getPage(): { page: number; pageCount: number; pageSize: number } {
    return { page: this.page, pageCount: this.pageCount(), pageSize: this.pageSize };
  }

  /** 翻页：夹紧到合法范围，越界直接忽略（避免空白页）。 */
  public setPage(page: number): void {
    const pageCount = this.pageCount();
    const next = Math.max(0, Math.min(pageCount - 1, Math.trunc(page)));
    if (next === this.page) return;
    this.page = next;
    this.mountPage();
    this.config.onPageChange?.(this.page, pageCount);
  }

  public stepPage(delta: number): void {
    this.setPage(this.page + delta);
  }

  private pageCount(): number {
    if (this.pageSize <= 0) return 1;
    return Math.max(1, Math.ceil(this.order.length / this.pageSize));
  }

  private mountPage(): void {
    if (this.pageSize <= 0) this.pageSize = this.pageSizeForWidth();
    const start = this.page * Math.max(1, this.pageSize);
    const slice = this.pageSize <= 0 ? [...this.order] : this.order.slice(start, start + this.pageSize);
    const visible = new Set(slice);

    for (const [id, view] of [...this.views]) {
      if (visible.has(id) || view.fly) continue;
      view.el.remove();
      this.views.delete(id);
    }

    for (const id of slice) {
      const item = this.items.get(id);
      if (!item) continue;
      const existing = this.views.get(id);
      if (!existing) {
        const el = this.config.createCard(id);
        if (!el) continue;
        const view: CardView = {
          id: item.id,
          signature: item.signature,
          el,
          slot: { x: 0, y: 0, rotationDeg: 0, scale: 1, z: 1 },
          x: spring(0),
          y: spring(0),
          rot: spring(0),
          scale: spring(1),
          pushTarget: 0,
          hover: 0,
          hoverTarget: 0,
          appear: 0,
          appearTarget: 1,
          tilt: 0,
          lastZ: 0,
          lastDragScale: 1,
          gone: false
        };
        this.root.appendChild(el);
        this.views.set(id, view);
        continue;
      }
      existing.gone = false;
      existing.appearTarget = 1;
      if (existing.signature !== item.signature) {
        const el = this.config.createCard(id);
        if (el) {
          existing.el.replaceWith(el);
          existing.el = el;
          existing.signature = item.signature;
          // 新节点没有内联样式：清掉缓存，下一帧把 transform / z-index 重新写一遍，
          // 否则重建过的牌会既没有层级也没有位置（表现为"被盖住"或跳一下）。
          existing.lastZ = 0;
          this.relayout();
          this.writeCard(existing, performance.now());
        }
      }
    }

    this.relayout();
    this.applyStyle();
    this.start();
  }

  /**
   * 每页张数：按手牌条宽度自适应。
   *
   * 翻页而不是横向滚动——滚动会和拖拽抢同一个手势轴（玩家想翻页却拖走了牌）。
   * 宽度 / 112 保证每张牌仍有 ~112px 的站台，4–9 之间夹紧。
   */
  private pageSizeForWidth(): number {
    if (this.config.pageSize !== undefined) return this.config.pageSize;
    const width = this.rootRect.width || this.config.layout?.handWidth || 900;
    return Math.max(4, Math.min(9, Math.floor(width / 112)));
  }

  public getState(): CardHandState {
    return this.state;
  }

  public destroy(): void {
    this.destroyed = true;
    this.stopRaf();
    this.resizeObserver?.disconnect();
    this.root.removeEventListener('pointerdown', this.onPointerDown);
    this.root.removeEventListener('pointermove', this.onPointerMove);
    this.root.removeEventListener('pointerup', this.onPointerUp);
    this.root.removeEventListener('pointercancel', this.onPointerCancel);
    this.root.removeEventListener('pointerleave', this.onPointerLeave);
    this.root.removeEventListener('click', this.onClick);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.root.removeAttribute('data-physics');
    this.views.clear();
    this.order.length = 0;
  }

  /* ---------------------------------------------------------------- 布局 */

  private measure(): void {
    const rect = this.root.getBoundingClientRect();
    this.rootRect.left = rect.left;
    this.rootRect.top = rect.top;
    this.rootRect.width = rect.width;
    this.rootRect.height = rect.height;
    // 宽度变了 → 每页容量可能变，重排一次分页（页码会被夹回合法范围）。
    const size = this.pageSizeForWidth();
    if (size !== this.pageSize) {
      this.pageSize = size;
      this.mountPage();
      this.config.onPageChange?.(this.page, this.pageCount());
    } else {
      this.relayout();
    }
    this.start();
  }

  private relayout(): void {
    const active = this.order
      .map(id => this.views.get(id))
      .filter((view): view is CardView => Boolean(view) && !view!.gone && !view!.fly);
    const slots = arcLayout(active.length, {
      ...(this.config.layout ?? {}),
      handWidth: this.rootRect.width || this.config.layout?.handWidth || 900
    });
    active.forEach((view, index) => {
      view.slot = slots[index] ?? { x: 0, y: 0, rotationDeg: 0, scale: 1, z: 1 };
    });
  }

  /* -------------------------------------------------------------- 帧循环 */

  private start(): void {
    if (this.rafId !== 0 || this.destroyed) return;
    this.lastNow = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  private stopRaf(): void {
    if (this.rafId === 0) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame = (now: number): void => {
    this.rafId = 0;
    if (this.destroyed) return;
    const raw = this.lastNow === 0 ? 1 / 60 : (now - this.lastNow) / 1000;
    this.lastNow = now;
    const dt = Math.min(this.config.maxDt ?? DEFAULTS.maxDt, Math.max(1 / 240, raw));
    const hoverMs = this.reduced ? 0 : (this.config.hoverMs ?? DEFAULTS.hoverMs);
    let busy = false;

    for (const view of this.views.values()) {
      if (view.appear !== view.appearTarget) {
        const step = this.reduced ? 1 : (dt * 1000) / 180;
        view.appear += Math.sign(view.appearTarget - view.appear) *
          Math.min(step, Math.abs(view.appearTarget - view.appear));
        busy = true;
      }
      if (view.hover !== view.hoverTarget) {
        const step = hoverMs <= 0 ? 1 : (dt * 1000) / hoverMs;
        view.hover += Math.sign(view.hoverTarget - view.hover) *
          Math.min(step, Math.abs(view.hoverTarget - view.hover));
        busy = true;
      }

      // 悬停目标切换（放大 ↔ 缩小）走 120ms 过渡，过界来回时不会跳。
      const drag = this.drag;
      if (drag && Math.abs(drag.scaleMul - drag.scaleMulTarget) > 0.002) {
        const easeStep = this.reduced ? 1 : dt / 0.12;
        drag.scaleMul += (drag.scaleMulTarget - drag.scaleMul) * Math.min(1, easeStep);
        if (Math.abs(drag.scaleMul - drag.scaleMulTarget) <= 0.002) drag.scaleMul = drag.scaleMulTarget;
        busy = true;
      }

      const dragged = this.drag?.view === view;
      if (!view.fly) {
        const config = dragged || this.state !== 'returning' ? this.springs.follow : this.springs.back;
        const settled =
          springStep(view.x, view.slot.x + view.pushTarget, config, dt) &&
          springStep(view.y, view.slot.y, config, dt) &&
          springStep(view.rot, view.slot.rotationDeg, config, dt) &&
          springStep(view.scale, view.slot.scale, config, dt);
        if (!settled) busy = true;
      }

      if (view.fly) {
        const progress = this.reduced
          ? 1
          : Math.min(1, (now - view.fly.start) / (this.config.flyMs ?? DEFAULTS.flyMs));
        if (progress >= 1) {
          view.el.remove();
          this.views.delete(view.id);
        } else {
          busy = true;
        }
      }

      this.writeCard(view, now);
    }

    if (busy) this.rafId = requestAnimationFrame(this.frame);
    else if (!this.drag && this.state !== 'committing' && this.state !== 'flying') this.setState('idle');
  };

  /** 唯一的样式写入点：只写 transform / opacity / z-index。 */
  private writeCard(view: CardView, now: number): void {
    const hover = HOVER_EASE(view.hover);
    const dragged = this.drag?.view === view && (this.state === 'dragging' || this.state === 'armed');
    const lift = dragged ? 0 : -(this.config.hoverLift ?? DEFAULTS.hoverLift) * hover;
    const hoverScale = 1 + ((this.config.hoverScale ?? DEFAULTS.hoverScale) - 1) * hover;
    const tilt = dragged ? view.tilt : 0;
    const rotation = view.rot.value * (1 - hover) + tilt;
    const dragScale = dragged ? (this.drag?.bigScale ?? 1) * (this.drag?.scaleMul ?? 1) : 1;
    const baseScale = view.scale.value * hoverScale * (dragged ? dragScale : 1);

    // 浏览器把"带 will-change 的图层"栅格化一次后缩放复用：牌先缩小（悬在分区上）
    // 再放大时，合成器手里还是那张小位图，于是发虚。变大瞬间撤掉 will-change，
    // 图层被丢弃 → 下一帧按新尺寸重新栅格，字与卡面恢复清晰。
    if (dragged && dragScale > view.lastDragScale * 1.05) this.forceRaster(view.el);
    view.lastDragScale = dragged ? dragScale : 1;

    let x = view.x.value + (dragged ? (this.drag?.dx ?? 0) : 0);
    let y = view.y.value + lift + (dragged ? (this.drag?.dy ?? 0) : 0);
    let scale = baseScale;
    let opacity = Math.max(0, Math.min(1, view.appear));

    if (view.fly) {
      const progress = this.reduced
        ? 1
        : Math.min(1, (now - view.fly.start) / (this.config.flyMs ?? DEFAULTS.flyMs));
      const eased = FLY_EASE(progress);
      x = view.fly.fromX + (view.fly.toX - view.fly.fromX) * eased;
      y = view.fly.fromY + (view.fly.toY - view.fly.fromY) * eased;
      scale = view.fly.fromScale + ((this.config.flyScale ?? DEFAULTS.flyScale) - view.fly.fromScale) * eased;
      opacity *= 1 - eased;
    }

    view.el.style.transform =
      `translate3d(calc(-50% + ${x.toFixed(2)}px), ${y.toFixed(2)}px, 0) ` +
      `rotate(${rotation.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
    view.el.style.opacity = opacity >= 1 ? '' : opacity.toFixed(3);
    // 层级：飞场 > 拖拽 > 悬停 > 布局顺序。
    // 悬停必须置顶：放大后的牌比邻居高，若沿用布局 z 会被右边的邻居盖住一半。
    const raised = view.hoverTarget > 0 || view.hover > 0.01;
    const z = view.fly ? 3000 : dragged ? 2500 : raised ? 2000 : view.slot.z;
    if (view.lastZ !== z) {
      view.lastZ = z;
      view.el.style.zIndex = String(z);
    }
  }

  /** 丢掉合成图层、强制按当前尺寸重新栅格（只撤一帧 will-change）。 */
  private forceRaster(el: HTMLElement): void {
    if (el.dataset.rasterising === '1') return;
    el.dataset.rasterising = '1';
    el.style.willChange = 'auto';
    requestAnimationFrame(() => {
      el.style.willChange = '';
      delete el.dataset.rasterising;
    });
  }

  private setState(next: CardHandState): void {
    if (this.state === next) return;
    this.state = next;
    this.root.dataset.state = next;
  }

  /** 让静态样式（阴影/hover 描边）与物理状态对齐，只在状态切换时调一次。 */
  private applyStyle(): void {
    for (const view of this.views.values()) view.el.dataset.hover = view.hoverTarget > 0 ? '1' : '0';
  }

  /* --------------------------------------------------------------- 手势 */

  private viewFromEvent(event: Event): CardView | null {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action-id]');
    if (!el) return null;
    const id = el.dataset.actionId ?? '';
    return this.views.get(id) ?? null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const view = this.viewFromEvent(event);
    if (!view || view.fly) return;
    this.suppressClick = false;
    // 接管：无论它正在回弹还是让位，都从"当前渲染位"起算 → 零跳变。
    view.x.velocity = 0;
    view.y.velocity = 0;
    view.el.dataset.active = '1';
    try {
      this.root.setPointerCapture(event.pointerId);
    } catch {
      // 某些浏览器在 pointerdown 之外调用会抛错，忽略即可。
    }
    this.drag = {
      view,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      dy: 0,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velX: 0,
      moved: false,
      // 一次布局读取，换整段拖拽的"看得清"：牌高约占屏幕 1/3。
      bigScale: this.dragScaleFor(view),
      scaleMul: 1,
      scaleMulTarget: 1
    };
    this.setState('armed');
    // 拖拽期间把**整个 HUD 外壳**抬到轮盘之上：卡片在 .ui-layer(z=10) 里，只抬手牌条
    // 不会改变它和 body 上浮层（z=74）的先后，牌还是会被轮盘盖住。
    this.root.dataset.dragging = '1';
    const shell = this.root.closest('.app-shell') as HTMLElement | null;
    if (shell) {
      shell.dataset.dragging = '1';
      this.raisedShell = shell;
    }
    this.setHover(null);
    this.start();
  };

  /**
   * 拖起来的牌的放大倍数。
   *
   * 手感与可读性是一对矛盾：小牌方便排布，但拖起来看就需要"举到眼前"。所以拖拽期间
   * 单独按视口高度算——目标牌高 ≈ 视口 1/3，封顶 `dragMaxScale`，下限 1（只会放大）。
   */
  private dragScaleFor(view: CardView): number {
    if (this.config.dragScaleFromViewport === false) return this.config.dragScale ?? DEFAULTS.dragScale;
    const height = view.el.offsetHeight || 0;
    if (height <= 0) return this.config.dragScale ?? DEFAULTS.dragScale;
    const desired = (window.innerHeight / 3) / height;
    const cap = this.config.dragMaxScale ?? DEFAULTS.dragMaxScale;
    return Math.max(1, Math.min(cap, desired));
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) {
      this.setHover(this.viewFromEvent(event));
      return;
    }
    const drag = this.drag;
    drag.dx = event.clientX - drag.startX;
    drag.dy = event.clientY - drag.startY;
    const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
    const instant = (event.clientX - drag.lastX) / elapsed;
    drag.velX = drag.velX * 0.65 + instant * 0.35;
    drag.lastX = event.clientX;
    drag.lastTime = event.timeStamp;

    if (!drag.moved && Math.hypot(drag.dx, drag.dy) > (this.config.slopPx ?? DEFAULTS.slopPx)) {
      drag.moved = true;
      this.setState('dragging');
      drag.view.el.dataset.drag = '1';
      this.config.onDragStart?.(drag.view.id, { x: event.clientX, y: event.clientY });
    }
    if (drag.moved) {
      const maxTilt = this.config.tiltMaxDeg ?? DEFAULTS.tiltMaxDeg;
      drag.view.tilt = Math.max(-maxTilt, Math.min(maxTilt, drag.velX * (this.config.tiltPerPx ?? DEFAULTS.tiltPerPx)));
      this.applyNeighbourYield(drag.view, event.clientX);
      this.updateZone(event.clientX, event.clientY);
      const at = { x: event.clientX, y: event.clientY };
      this.config.onDragMove?.(at);
      // 落点决定它有多大：中心/轮盘外放大，悬在分区上缩小（让出提示位）。
      const mul = this.config.dragScaleAt?.(at);
      drag.scaleMulTarget = typeof mul === 'number' && Number.isFinite(mul) ? Math.max(0.2, Math.min(1.4, mul)) : 1;
    }
    this.start();
  };

  private onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.releaseCapture(event.pointerId);
    this.drag = null;
    drag.view.el.dataset.active = '0';
    drag.view.el.dataset.drag = '0';
    drag.view.tilt = 0;
    this.clearRaisedShell();
    this.releaseNeighbours();
    this.clearZone();

    if (!drag.moved) {
      // 轻点即激活。不能依赖随后的 click：pointer capture 会把 click 的目标重定向到
      // 捕获元素（手牌条本身），事件里面已经找不到是哪张卡了，所以这里直接发。
      // 随后的 click 由 suppressClick 吞掉，避免同一次点击触发两次。
      this.suppressClick = true;
      this.setState('idle');
      this.config.onActivate?.(drag.view.id);
      return;
    }
    this.suppressClick = true;

    const at: Point = { x: event.clientX, y: event.clientY };
    const inside = this.hitZone(at.x, at.y, this.config.zonePadding ?? DEFAULTS.zonePadding);
    if (!inside) {
      // 落在出牌区外＝取消：收尾钩子负责关掉目标轮盘，否则它会留在屏幕上。
      this.config.onDragEnd?.(at);
      this.releaseBack(drag.view, drag.velX);
      return;
    }
    void this.commit(drag.view, at);
  };

  private onPointerCancel = (): void => {
    const drag = this.drag;
    if (!drag) return;
    this.releaseCapture(drag.pointerId);
    this.drag = null;
    drag.view.el.dataset.active = '0';
    drag.view.el.dataset.drag = '0';
    drag.view.tilt = 0;
    this.clearRaisedShell();
    this.releaseNeighbours();
    this.clearZone();
    this.config.onDragEnd?.({ x: 0, y: 0 });
    this.releaseBack(drag.view, 0);
  };

  private onPointerLeave = (): void => {
    if (this.drag) return; // 拖拽中由 pointer capture 兜底
    this.setHover(null);
  };

  /**
   * 键盘路径（Enter / Space 在聚焦卡片上会派发 click）。
   * 指针路径已经在 pointerup 里发过，靠 suppressClick 挡住这次重复。
   */
  private onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    // 鼠标/触摸来源的 click 已经在上面的 pointerup 处理过（detail >= 1）；
    // detail === 0 才是键盘激活，需要走这里。
    if (event.detail > 0) return;
    const view = this.viewFromEvent(event);
    if (!view) return;
    this.config.onActivate?.(view.id);
  };

  private onWindowBlur = (): void => {
    if (this.drag) this.onPointerCancel();
    this.setHover(null);
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && this.drag) this.onPointerCancel();
  };

  /* ---------------------------------------------------------------- hover */

  private setHover(view: CardView | null): void {
    if (this.hovered === view) return;
    if (this.hovered) {
      this.hovered.hoverTarget = 0;
      this.hovered.el.dataset.hover = '0';
    }
    this.hovered = view;
    if (view && !this.drag) {
      view.hoverTarget = 1;
      view.el.dataset.hover = '1';
      this.setState('hover');
      this.applyNeighbourYield(view, null);
    } else if (!this.drag) {
      this.setState('idle');
      this.releaseNeighbours();
    }
    this.start();
  }

  /** 邻居让位：改的是弹簧**目标**而不是位置，所以是"让"而不是"瞬移"。 */
  private applyNeighbourYield(view: CardView, pointerX: number | null): void {
    const push = this.config.neighbourPush ?? DEFAULTS.neighbourPush;
    const center = this.rootRect.left + this.rootRect.width / 2;
    const anchor = pointerX ?? center + view.slot.x;
    for (const other of this.views.values()) {
      if (other === view || other.gone || other.fly) continue;
      const distance = Math.abs(center + other.slot.x - anchor);
      const influence = push / (1 + distance / 90);
      other.pushTarget = other.slot.x < view.slot.x ? -influence : influence;
    }
    this.start();
  }

  /** 拖拽收尾：把外壳降回原来的层级。 */
  private clearRaisedShell(): void {
    delete this.root.dataset.dragging;
    if (this.raisedShell) {
      delete this.raisedShell.dataset.dragging;
      this.raisedShell = null;
    }
  }

  private releaseNeighbours(): void {
    for (const other of this.views.values()) other.pushTarget = 0;
    this.start();
  }

  /* ------------------------------------------------------------- 出牌区 */

  private zonePoints(): readonly Point[] | null {
    const zone = this.config.playZone?.() ?? null;
    return zone && zone.length >= 3 ? zone : null;
  }

  private hitZone(x: number, y: number, padding: number): boolean {
    const zone = this.zonePoints();
    if (!zone) return false;
    return pointInPolygonWithPadding({ x, y }, zone, padding);
  }

  private updateZone(x: number, y: number): void {
    // 滞回：进区用大容差、出区用小容差，指针在边界上来回时不会闪。
    const enter = this.config.zonePadding ?? DEFAULTS.zonePadding;
    const exit = this.config.zoneExitPadding ?? DEFAULTS.zoneExitPadding;
    const inside = this.inZone ? this.hitZone(x, y, exit) : this.hitZone(x, y, enter);
    if (inside === this.inZone) return;
    this.inZone = inside;
    const value = inside ? 'valid' : 'invalid';
    this.root.dataset.drop = value;
    const zoneEl = this.config.playZoneElement?.() ?? null;
    if (zoneEl) zoneEl.dataset.drop = value;
    if (this.drag) this.drag.view.el.dataset.drop = value;
  }

  private clearZone(): void {
    this.inZone = false;
    this.root.dataset.drop = '';
    const zoneEl = this.config.playZoneElement?.() ?? null;
    if (zoneEl) zoneEl.dataset.drop = '';
    for (const view of this.views.values()) view.el.dataset.drop = '';
  }

  /* ---------------------------------------------------------- 提交 / 回弹 */

  private async commit(view: CardView, at: Point): Promise<void> {
    this.setState('committing');
    let accepted = true;
    try {
      accepted = (await Promise.resolve(this.config.onDrop?.(view.id, at))) ?? true;
    } catch {
      accepted = false;
    }
    if (!accepted) {
      this.releaseBack(view, 0);
      return;
    }
    this.flyOut(view, at);
  }

  private flyOut(view: CardView, at: Point): void {
    const zone = this.zonePoints();
    const target = this.config.flyTarget?.() ?? (zone ? polygonCentroid(zone) : at);
    this.setState('flying');
    view.fly = {
      start: performance.now(),
      fromX: view.x.value,
      fromY: view.y.value,
      fromScale: view.scale.value,
      toX: target.x - (this.rootRect.left + this.rootRect.width / 2),
      toY: target.y - (this.rootRect.top + this.rootRect.height)
    };
    this.start();
  }

  /** 回弹：把拖拽速度灌进弹簧，松手那一下才有惯性，而不是被"拉"回去。 */
  private releaseBack(view: CardView, velocity: number): void {
    this.setState('returning');
    view.x.velocity = velocity * 60;
    this.start();
    // 弹簧收敛后 frame() 会把 state 收回 idle；这里兜底一次，避免状态卡在 returning。
    window.setTimeout(() => {
      if (!this.destroyed && !this.drag && this.state === 'returning') this.setState('idle');
    }, 420);
  }

  private releaseCapture(pointerId: number): void {
    try {
      if (this.root.hasPointerCapture(pointerId)) this.root.releasePointerCapture(pointerId);
    } catch {
      // 已经由浏览器释放。
    }
  }
}
