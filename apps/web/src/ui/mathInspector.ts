import { GamePresenter, GameSnapshot, UiHook, UiLogEntry } from '@rds/app/contracts';
import { html, raw, setHtml } from './dom/html';

type InspectorTab = 'G' | 'STACK' | 'FACTIONS' | 'HOOKS' | 'TIME';

const TAB_META: { id: InspectorTab; label: string; title: string }[] = [
  { id: 'G', label: '𝒢 九元组', title: '九元组博弈系统' },
  { id: 'STACK', label: 'Σ 响应栈', title: 'LIFO 中断响应栈' },
  { id: 'FACTIONS', label: 'Φ 阵营', title: '动态阵营拓扑' },
  { id: 'HOOKS', label: '𝒦 元规则', title: 'AOP 规则切面' },
  { id: 'TIME', label: '↺ 溯源', title: '事件溯源时间机器' }
];

const REL_LABEL: Record<string, string> = {
  ALLIED: '同盟',
  HOSTILE: '敌对',
  NEUTRAL: '中立',
  UNKNOWN: '未知'
};

const REL_CLASS: Record<string, string> = {
  ALLIED: 'allied',
  HOSTILE: 'hostile',
  NEUTRAL: 'neutral',
  UNKNOWN: 'unknown'
};

export interface InspectorOptions {
  onClose?: () => void;
}

/**
 * Presentation-only inspector.
 * Reads `GameSnapshot` + `UiHook` DTOs and calls the presenter for replay.
 * It must not import the engine or any game module.
 */
export class MathematicalInspectorUI {
  private readonly panel: HTMLElement;
  private presenter: GamePresenter;
  private readonly options: InspectorOptions;

  private tab: InspectorTab = 'G';
  // The kernel inspector is a developer tool: start collapsed so the board is
  // the hero of the screen.
  private collapsed = true;
  private scrubbing = false;
  private lastDepth = 0;
  private snapshot!: GameSnapshot;

  private unsubSnapshot: (() => void) | null = null;
  private unsubNotice: (() => void) | null = null;

  constructor(container: HTMLElement, presenter: GamePresenter, options: InspectorOptions = {}) {
    this.presenter = presenter;
    this.options = options;

    this.panel = document.createElement('section');
    this.panel.className = 'math-inspector-panel collapsed';
    container.appendChild(this.panel);

    this.bind(presenter);
  }

  public setPresenter(presenter: GamePresenter): void {
    this.unsubSnapshot?.();
    this.unsubNotice?.();
    this.presenter = presenter;
    this.tab = 'G';
    this.lastDepth = 0;
    this.bind(presenter);
  }

  public dispose(): void {
    this.unsubSnapshot?.();
    this.unsubNotice?.();
  }

  public isOpen(): boolean {
    return !this.collapsed;
  }

  public toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.panel.classList.toggle('collapsed', this.collapsed);
    if (!this.collapsed) this.render();
  }

  public setOpen(open: boolean): void {
    this.collapsed = !open;
    this.panel.classList.toggle('collapsed', this.collapsed);
    if (open) this.render();
  }

  public showTab(tab: InspectorTab): void {
    this.tab = tab;
    if (!this.collapsed) this.render();
  }

  public update(): void {
    if (this.collapsed) return;
    if (this.tab === 'TIME' && this.scrubbing) return;
    this.render();
  }

  private bind(presenter: GamePresenter): void {
    this.unsubSnapshot = presenter.subscribe(snapshot => {
      this.snapshot = snapshot;
      if (snapshot.stackDepth > this.lastDepth) this.tab = 'STACK';
      this.lastDepth = snapshot.stackDepth;
      this.update();
    });

    this.unsubNotice = presenter.onNotice(notice => {
      if (notice.tabHint === 'HOOKS') this.showTab('HOOKS');
      else if (notice.tabHint === 'STACK') this.showTab('STACK');
    });
  }

  /* ------------------------------------------------------------------ */

  private render(): void {
    if (this.collapsed || !this.snapshot) return;
    const snapshot = this.snapshot;

    setHtml(this.panel, html`
      <header class="mip-head">
        <div class="mip-title">
          <span class="mip-kicker"><span class="mip-live"></span>LIVE KERNEL STATE</span>
          <span class="mip-h1">${raw(TAB_META.find(t => t.id === this.tab)!.title)}</span>
        </div>
        <div class="mip-head-actions">
          <button class="icon-btn" id="mip-close" title="收起面板" style="width:30px;height:30px;font-size:var(--type-xs)">✕</button>
        </div>
      </header>

      <nav class="mip-tabs">
        ${raw(TAB_META.map(
          tab => `
          <button class="mip-tab ${tab.id === this.tab ? 'active' : ''} ${
            tab.id === 'STACK' && snapshot.stackDepth > 0 ? 'alerting' : ''
          }" data-tab="${tab.id}">
            ${tab.label}
            ${tab.id === 'STACK' ? `<span class="badge">${snapshot.stackDepth}</span>` : ''}
            ${tab.id === 'HOOKS' ? `<span class="badge">${snapshot.hooks.length}</span>` : ''}
          </button>
        `
        ).join(''))}
      </nav>

      <div class="mip-body">${raw(this.renderTab(snapshot))}</div>
    `);

    this.panel.querySelectorAll<HTMLElement>('.mip-tab').forEach(button => {
      button.addEventListener('click', () => {
        this.tab = (button.dataset.tab as InspectorTab) ?? 'G';
        this.render();
      });
    });

    this.panel.querySelector('#mip-close')?.addEventListener('click', () => {
      this.collapsed = true;
      this.panel.classList.add('collapsed');
      this.options.onClose?.();
    });

    this.wireTimeControls();
  }

  private wireTimeControls(): void {
    const snapshot = this.snapshot;
    const total = snapshot.log.total;
    const slider = this.panel.querySelector('#tl-slider') as HTMLInputElement | null;

    if (slider) {
      const paint = () => {
        const pct = total === 0 ? 0 : (Number(slider.value) / total) * 100;
        slider.style.setProperty('--pct', `${pct}%`);
      };
      paint();

      slider.addEventListener('pointerdown', () => (this.scrubbing = true));
      slider.addEventListener('pointerup', () => (this.scrubbing = false));
      slider.addEventListener('input', () => {
        paint();
        this.presenter.rewind(Number(slider.value));
      });
      slider.addEventListener('change', () => {
        this.scrubbing = false;
        this.render();
      });
    }

    this.panel.querySelectorAll<HTMLElement>('[data-rewind]').forEach(button => {
      button.addEventListener('click', () => {
        const target = button.dataset.rewind;
        const cursor = snapshot.log.cursor;
        if (target === 'start') this.presenter.rewind(0);
        else if (target === 'prev') this.presenter.rewind(Math.max(0, cursor - 1));
        else this.presenter.rewind(total);
      });
    });

    this.panel.querySelector('#tl-verify')?.addEventListener('click', () => {
      this.presenter.verifyReplay();
    });

    this.panel.querySelectorAll<HTMLElement>('[data-clock]').forEach(button => {
      button.addEventListener('click', () => {
        this.presenter.advanceClock(Number(button.dataset.clock ?? 1));
      });
    });
  }

  private renderTab(snapshot: GameSnapshot): string {
    switch (this.tab) {
      case 'G':
        return this.renderG(snapshot);
      case 'STACK':
        return this.renderStack(snapshot);
      case 'FACTIONS':
        return this.renderFactions(snapshot);
      case 'HOOKS':
        return this.renderHooks(snapshot);
      case 'TIME':
        return this.renderTime(snapshot);
    }
  }

  /* ------------------------------------------------------------------ */

  private renderG(snapshot: GameSnapshot): string {
    const board = snapshot.board;
    const entityTotal = Object.keys(board.entities).length;
    const masked = board.maskedEntityCount;
    const nodeTotal = Object.keys(board.mapGraph.nodes).length;
    const edgeTotal = Object.keys(board.mapGraph.edges).length;
    const name = (id: string) =>
      board.players[id]?.name ?? snapshot.npcs?.find(npc => npc.id === id)?.name ?? id;

    return `
      <div class="mip-section">
        <div class="formula-card">
          <div class="formula">
            <span class="f-sym">𝒢</span><span class="f-op">=</span><span class="f-op">⟨</span>
            <span class="f-sym">𝒩</span><span class="f-op">,</span>
            <span class="f-sym">𝒮</span><span class="f-op">,</span>
            <span class="f-sym">s₀</span><span class="f-op">,</span>
            <span class="f-sym">𝒜</span><span class="f-op">,</span>
            <span class="f-sym">ℒ</span><span class="f-op">,</span>
            <span class="f-sym">𝒯</span><span class="f-op">,</span>
            <span class="f-sym">𝒪</span><span class="f-op">,</span>
            <span class="f-sym">ℛ</span><span class="f-op">,</span>
            <span class="f-sym">𝒦</span><span class="f-op">⟩</span>
          </div>
          <div class="formula-caption">
            扩展因式分解观测随机博弈（FOSG）· 状态转移 s<sub>t+1</sub> = 𝒯<sub>𝒦<sub>t</sub></sub>(s<sub>t</sub>, a<sub>t</sub>)
          </div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Nine-tuple bindings · 九元组实时绑定</div>
        <div class="tuple-grid">
          <div class="tuple-cell">
            <div class="t-sym">𝒩</div><div class="t-name">Actors</div>
            <div class="t-val">${board.playerOrder.length} 玩家${
              (snapshot.npcs?.length ?? 0) > 0 ? ` + ${snapshot.npcs!.length} NPC` : ''
            } <span class="accent">+ c</span></div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">𝒮</div><div class="t-name">State</div>
            <div class="t-val">|E| ${entityTotal} · |Z| ${Object.keys(board.zones).length}</div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">s₀</div><div class="t-name">Initial</div>
            <div class="t-val mono">seed ${snapshot.log.seed}</div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">𝒜</div><div class="t-name">Actions</div>
            <div class="t-val">Σ 已执行 ${snapshot.log.total}</div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">ℒ</div><div class="t-name">Legal</div>
            <div class="t-val">|ℒ(s,i)| <span class="accent">${snapshot.legalCount}</span></div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">𝒯</div><div class="t-name">Transition</div>
            <div class="t-val">确定性纯函数</div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">𝒪</div><div class="t-name">Observation</div>
            <div class="t-val">${snapshot.viewer} · 遮蔽 ${masked}</div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">ℛ</div><div class="t-name">Reward</div>
            <div class="t-val">${snapshot.gameOver ? `<span class="accent">${snapshot.winnerLabel}</span>` : `${board.playerOrder.length} 名玩家存活`}</div>
          </div>
          <div class="tuple-cell">
            <div class="t-sym">𝒦</div><div class="t-name">Meta-rules</div>
            <div class="t-val">${snapshot.hooks.length} 枚钩子</div>
          </div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Live configuration · 当前局势</div>
        <div class="kv-grid">
          <div class="kv"><span class="k">时间步</span><span class="v">R${snapshot.round} · T${snapshot.turn}</span></div>
          <div class="kv"><span class="k">逻辑时钟</span><span class="v">${snapshot.clock} ticks</span></div>
          <div class="kv"><span class="k">相位</span><span class="v">${snapshot.phaseLabel}</span></div>
          <div class="kv"><span class="k">行动者</span><span class="v">${snapshot.actorName}</span></div>
          <div class="kv"><span class="k">焦点 𝒫(s)</span><span class="v">${(snapshot.focusActors ?? snapshot.focus).map(name).join(', ') || '—'}</span></div>
          <div class="kv"><span class="k">栈深 |Σ|</span><span class="v">${snapshot.stackDepth}</span></div>
          <div class="kv"><span class="k">决策窗口 Δ</span><span class="v">${snapshot.openDecisions}</span></div>
          <div class="kv"><span class="k">拓扑</span><span class="v">${nodeTotal} 节点 / ${edgeTotal} 边</span></div>
          <div class="kv"><span class="k">状态哈希</span><span class="v" style="font-family:var(--font-mono);font-size:9px">${snapshot.log.hash.slice(0, 12)}…</span></div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Module capabilities · 夹具能力</div>
        <div class="chips">
          <span class="chip">topology ${snapshot.capabilities.topology}${
            snapshot.capabilities.topologySpec
              ? ` · ${snapshot.capabilities.topologySpec.adjacency}${
                  snapshot.capabilities.topologySpec.directed ? ' · directed' : ''
                }`
              : ''
          }</span>
          <span class="chip ${snapshot.capabilities.hiddenInformation ? 'done' : ''}">hidden info</span>
          <span class="chip ${snapshot.capabilities.interruptStack ? 'done' : ''}">interrupts</span>
          <span class="chip ${snapshot.capabilities.simultaneousMoves ? 'done' : ''}">simultaneous</span>
          <span class="chip ${snapshot.capabilities.dynamicRules ? 'done' : ''}">dynamic rules</span>
        </div>
        <div class="kv-grid">
          <div class="kv"><span class="k">动作 Schema</span><span class="v">${snapshot.schemaCount} 条</span></div>
          <div class="kv"><span class="k">规则依赖图</span><span class="v">${snapshot.dependencyErrors.length === 0 ? '✓ 无环' : '✗ 异常'}</span></div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">V_global · 全局变量</div>
        <pre class="code-block">${this.escapeJson(board.globalVars)}</pre>
      </div>

      <div class="mip-section">
        <div class="sec-head">Transition pipeline · 转移算子管线</div>
        <div class="pipeline">
          <div class="pipe-step"><span class="p-sym">ℒ</span><span class="p-name">合法掩码</span><span class="p-meta">${snapshot.legalCount} 个</span></div>
          <span class="pipe-arrow">›</span>
          <div class="pipe-step"><span class="p-sym">𝒯</span><span class="p-name">确定性内核</span><span class="p-meta">纯函数</span></div>
          <span class="pipe-arrow">›</span>
          <div class="pipe-step"><span class="p-sym">𝒦</span><span class="p-name">AOP 拦截</span><span class="p-meta">${snapshot.hooks.length} 钩子</span></div>
          <span class="pipe-arrow">›</span>
          <div class="pipe-step"><span class="p-sym">𝒪</span><span class="p-name">认知裁剪</span><span class="p-meta">${masked} 遮蔽</span></div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Information projection · 信息投影</div>
        <div class="proj-bar">
          <span class="pb-visible" style="width:${entityTotal === 0 ? 0 : ((entityTotal - masked) / entityTotal) * 100}%"></span>
          <span class="pb-masked" style="width:${entityTotal === 0 ? 0 : (masked / entityTotal) * 100}%"></span>
        </div>
        <div class="legend">
          <span class="lg">可见 ${entityTotal - masked}</span>
          <span class="lg">遮蔽 ${masked}</span>
          <span class="lg">视角 ${snapshot.viewer === 'GOD' ? '全知' : snapshot.viewer}</span>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Shortcuts · 快捷键</div>
        <div class="kv-grid">
          <div class="kv"><span class="k">1 – 9</span><span class="v">执行动作</span></div>
          <div class="kv"><span class="k">I</span><span class="v">收起检查器</span></div>
          <div class="kv"><span class="k">Esc</span><span class="v">清除高亮</span></div>
          <div class="kv"><span class="k">拖拽</span><span class="v">旋转桌面</span></div>
        </div>
      </div>
    `;
  }

  private renderStack(snapshot: GameSnapshot): string {
    const gauge = `
      <div class="mip-section">
        <div class="sec-head">Depth gauge · 栈高 ${snapshot.stackDepth} / 8</div>
        <div class="stack-gauge">
          ${Array.from({ length: 8 })
            .map((_, index) => `<div class="gauge-bar ${index < snapshot.stackDepth ? 'filled' : ''}"></div>`)
            .join('')}
        </div>
      </div>
      ${
        snapshot.decision
          ? `
        <div class="mip-section">
          <div class="sec-head">Concurrent decisions · 并发决策 Δ</div>
          <div class="frame top">
            <div class="frame-head">
              <span class="frame-depth">Δ</span>
              <span class="frame-title">${snapshot.decision.title}</span>
              <span class="frame-state">${snapshot.decision.secret ? 'SECRET' : 'OPEN'}</span>
            </div>
            <div class="frame-desc">${snapshot.decision.description}</div>
            <div class="chips">
              ${snapshot.decision.participants
                .map(
                  participant =>
                    `<span class="chip ${participant.committed ? 'done' : 'wait'}"><span class="c-dot"></span>${
                      participant.name
                    }${participant.committed ? ' · 已提交' : ' · 待提交'}</span>`
                )
                .join('')}
            </div>
            <div class="frame-meta">policy ${snapshot.decision.policyLabel} · secret ${String(snapshot.decision.secret)}</div>
          </div>
        </div>
      `
          : ''
      }
    `;

    if (snapshot.stackDepth === 0) {
      return `
        ${gauge}
        <div class="empty-state">
          <div class="es-ico">Σ</div>
          <div class="es-title">响应栈为空 · Depth = 0</div>
          <div class="es-desc">
            当玩家打出卡牌、触发技能或亮出预兆时，内核会把待结算效果压入栈顶，并开启响应窗口。
            所有具备响应权的玩家放弃后，栈顶帧才会弹出并执行真实状态修改。
          </div>
        </div>

        <div class="mip-section">
          <div class="sec-head">Interrupt chain example · 中断链示意</div>
          <div class="resp-chain">
            <span class="rc-node start">【杀】</span>
            <span class="rc-arrow">→</span>
            <span class="rc-node">【闪】/ 八卦阵</span>
            <span class="rc-arrow">→</span>
            <span class="rc-node danger">濒死求【桃】</span>
            <span class="rc-arrow">→</span>
            <span class="rc-node violet">【无懈可击】</span>
            <span class="rc-arrow">↺</span>
          </div>
          <div class="formula-caption">
            每一枚节点都是一个 σ 帧；后进先出结算，最后压入的帧最先完成。若【无懈可击】被另一张【无懈可击】反制，
            新的帧会再压入栈顶，形成任意深度的递归响应链。
          </div>
        </div>

        <div class="mip-section">
          <div class="sec-head">Frame anatomy · 栈帧结构</div>
          <div class="kv-grid">
            <div class="kv"><span class="k">id</span><span class="v">帧唯一标识</span></div>
            <div class="kv"><span class="k">type</span><span class="v">结算类型</span></div>
            <div class="kv"><span class="k">sourcePlayerId</span><span class="v">发起者</span></div>
            <div class="kv"><span class="k">responseWindow</span><span class="v">响应权集合</span></div>
          </div>
        </div>
      `;
    }

    return `
      ${gauge}
      <div class="mip-section">
        <div class="sec-head">LIFO frames · 由栈顶向下</div>
        <div class="stack-list">
          ${snapshot.stack
            .map(
              (frame, index) => `
            <div class="frame ${index === 0 ? 'top' : ''}">
              <div class="frame-head">
                <span class="frame-depth">σ${snapshot.stackDepth - index}</span>
                <span class="frame-title">${frame.title}</span>
                <span class="frame-state">${index === 0 ? 'TOP · ' : ''}${frame.status}</span>
              </div>
              <div class="frame-desc">${frame.description}</div>
              <div class="frame-meta">
                <span>SRC ${frame.sourceName}</span>
                ${frame.targetName ? `<span>→ ${frame.targetName}</span>` : ''}
              </div>
              ${
                frame.window
                  ? `
                <div class="window-box">
                  <div class="window-label">⧫ RESPONSE WINDOW ${frame.window.priority ? '· 优先级仲裁短路' : ''}</div>
                  <div class="chips">
                    ${frame.window.eligible
                      .map(
                        player =>
                          `<span class="chip ${player.pending ? 'wait' : 'done'}"><span class="c-dot"></span>${
                            player.name
                          }${player.pending ? ' · 待响应' : ' · 已提交'}</span>`
                      )
                      .join('')}
                  </div>
                </div>
              `
                  : ''
              }
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;
  }

  private renderFactions(snapshot: GameSnapshot): string {
    const board = snapshot.board;
    const players = board.playerOrder;
    const matrix = board.factionTopology;

    return `
      <div class="mip-section">
        <div class="formula-card">
          <div class="formula"><span class="f-sym">Φ</span>(s) : <span class="f-sym">𝒩</span> × <span class="f-sym">𝒩</span> → { 同盟, 敌对, 中立, 未知 }</div>
          <div class="formula-caption">阵营并非静态常量，而是依赖当前状态 s 的内生有向关系矩阵。</div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Relation matrix · 视角 ${snapshot.viewer}</div>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead>
              <tr><th>主体 \\ 目标</th>${players.map(pid => `<th>${board.players[pid]?.name ?? pid}</th>`).join('')}</tr>
            </thead>
            <tbody>
              ${players
                .map(
                  a => `
                <tr>
                  <th>${board.players[a]?.name ?? a}</th>
                  ${players
                    .map(b => {
                      const relation = matrix[a]?.[b] ?? 'NEUTRAL';
                      return `<td class="${a === b ? 'self' : ''}">
                        <span class="rel ${REL_CLASS[relation] ?? 'neutral'}"><span class="r-dot"></span>${REL_LABEL[relation] ?? relation}</span>
                      </td>`;
                    })
                    .join('')}
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="legend">
          <span class="lg"><span class="rel allied"><span class="r-dot"></span>同盟</span></span>
          <span class="lg"><span class="rel hostile"><span class="r-dot"></span>敌对</span></span>
          <span class="lg"><span class="rel neutral"><span class="r-dot"></span>中立</span></span>
          <span class="lg"><span class="rel unknown"><span class="r-dot"></span>未知（身份未公开）</span></span>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Role projection · 身份投影</div>
        ${players
          .map(pid => {
            const player = board.players[pid];
            return `<div class="kv"><span class="k">${player?.name ?? pid}</span><span class="v">${
              player?.role ?? '—'
            }</span></div>`;
          })
          .join('')}
      </div>
    `;
  }

  private renderHooks(snapshot: GameSnapshot): string {
    const hooks: UiHook[] = snapshot.hooks;

    const body =
      hooks.length === 0
        ? `
          <div class="empty-state">
            <div class="es-ico">𝒦</div>
            <div class="es-title">当前未挂载可观察规则钩子</div>
            <div class="es-desc">
              基础规则以纯函数形式存在；当游戏进入元规则阶段（作祟爆发、装备防具触发），
              内核会把新的拦截器热注入 activeHooks，实时改写 ℒ、𝒯 与 ℛ。
            </div>
          </div>
        `
        : hooks
            .map(
              hook => `
          <div class="hook">
            <div class="hook-head">
              <span class="hook-name">${hook.name}</span>
              <span class="hook-stage">${hook.stage}</span>
            </div>
            <div class="hook-desc">${hook.description}</div>
            <div class="hook-meta">priority ${hook.priority} · ${hook.hookId} · instance ${hook.instanceId}</div>
            <div class="hook-meta">owner ${hook.ownerName ?? '—'} · params ${hook.params}</div>
          </div>
        `
            )
            .join('');

    return `
      <div class="mip-section">
        <div class="formula-card">
          <div class="formula">
            <span class="f-sym">𝒦</span><span class="f-op">=</span>⟨<span class="f-sym">ℋ</span><sub>hooks</sub>,
            <span class="f-sym">ℳ</span><sub>modifiers</sub>, <span class="f-sym">ℛ</span><sub>win</sub>⟩
          </div>
          <div class="formula-caption">
            规则本身被提升为状态空间中的一等公民：AOP 洋葱管道依次执行 FILTER_MODIFY → BEFORE_REPLACE → AFTER_TRIGGER。
          </div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Active interceptors · 已挂载 ${hooks.length} 枚</div>
        ${body}
      </div>
    `;
  }

  private renderTime(snapshot: GameSnapshot): string {
    const log = snapshot.log;
    const pct = log.total === 0 ? 0 : (log.cursor / log.total) * 100;
    const replay = log.replay;

    return `
      <div class="mip-section">
        <div class="formula-card">
          <div class="formula">s<sub>t</sub> = 𝒯<sup>t</sup>(s₀, [a₀ … a<sub>t−1</sub>])</div>
          <div class="formula-caption">
            Append-Only 动作日志流。给定 s₀ 与种子，任意步重放都得到比特级一致的 s_t —— 这是录像、回放与断线恢复的基础。
          </div>
        </div>
      </div>

      <div class="mip-section">
        <div class="sec-head">Deterministic replay · 时间机器</div>
        <div class="tl-controls">
          <button class="tl-btn" data-rewind="start" title="回到初始状态">⇤</button>
          <button class="tl-btn" data-rewind="prev" title="后退一步">◂</button>
          <input class="tl-slider" id="tl-slider" type="range" min="0" max="${log.total}" value="${log.cursor}" style="--pct:${pct}%" />
          <button class="tl-btn" data-rewind="end" title="回到最新">▸</button>
          <span class="tl-count">${log.cursor} / ${log.total}</span>
        </div>
        <div class="tl-controls" style="margin-top:6px">
          <button class="tl-btn" id="tl-verify" title="重放全部动作并比对状态哈希">✓</button>
          <button class="tl-btn" data-clock="1" title="推进逻辑时钟 1 tick">⏱</button>
          <button class="tl-btn" data-clock="8" title="推进逻辑时钟 8 ticks">+8</button>
          <span style="font-size:var(--type-xs);color:var(--text-tertiary);font-family:var(--font-mono)">
            seed ${log.seed} · hash ${log.hash.slice(0, 12)}…
          </span>
        </div>
        ${
          replay
            ? `<div class="kv" style="border-color:${replay.ok ? 'rgba(87,192,139,0.4)' : 'rgba(224,96,78,0.45)'}">
                 <span class="k">重放校验</span>
                 <span class="v" style="color:${replay.ok ? '#8de0b5' : '#f0a59a'}">
                   ${replay.ok ? 'PASS · 哈希一致' : `FAIL · ${replay.errors[0] ?? '哈希不一致'}`}
                 </span>
               </div>
               <div class="code-block" style="max-height:90px">expected ${replay.expectedHash}
actual   ${replay.actualHash}</div>`
            : ''
        }
      </div>

      <div class="mip-section">
        <div class="sec-head">Action log · 共 ${log.total} 条</div>
        ${
          log.entries.length === 0
            ? `<div class="empty-state"><div class="es-ico">∅</div><div class="es-title">尚无动作</div>
               <div class="es-desc">执行任意动作后，日志会逐条记录玩家、动作类型与目标，可拖动上方滑块回到任意时刻。</div></div>`
            : `<div class="log-list">${log.entries.map(entry => this.logRow(entry)).join('')}</div>`
        }
      </div>
    `;
  }

  private logRow(entry: UiLogEntry): string {
    return `
      <div class="log-row">
        <span class="n">${String(entry.index + 1).padStart(2, '0')}</span>
        <span class="who">${entry.playerId}</span>
        <span class="act">${entry.type}</span>
        ${entry.targetId ? `<span class="tgt">→ ${entry.targetId}</span>` : ''}
      </div>
    `;
  }

  private escapeJson(value: unknown): string {
    const text = JSON.stringify(value ?? {}, null, 2) ?? '{}';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .slice(0, 1600);
  }
}
