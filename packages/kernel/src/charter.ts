/**
 * 宪章执行器（Charter enforcement）。
 *
 * 把 `docs/KERNEL-CHARTER.md` 里方向性的约束变成**机器可读的声明 + 运行期可
 * 校验的违规**。这一层刻意做得很薄：
 *
 *  - 它不改变任何规则语义，只负责"发现"；
 *  - 它不抛异常，违规以结构化事件的形式交给调用方（内核决定是拦截还是记录）；
 *  - 全部是纯函数，无状态、无 IO，因此可以安全地放进 replay。
 *
 * 目前落地的是 C-1 / C-2 / C-5 / C-6 / C-9 五条里可静态或半静态判定的部分：
 *
 *  - C-1  动作代数：`actionSchemas` 声明了的类型必须有 schema；`unknownActionTypes` 内的视为登记偏离
 *  - C-2  单步转移：一次 `reduce` 只允许一次逻辑跃迁（跃迁次数由内核在 reduce 前后比对）
 *  - C-5  信息约束：`isAutomated` 指向的 AI 决策入口只接受投影状态
 *  - C-6  语义不变量：模块可声明 `checkInvariants`，内核在 strict 模式下调用
 *  - C-9  扩展字段收口：`meta.stateSchema.globalVars` 登记的 key 之外的 globalVars 视为违规
 */

import type { Action, GameState, ProjectedGameState } from './types';
import type { GameModule } from './module';

/** 一条宪章违规。`code` 用于聚合与灰度统计，`message` 面向人。 */
export interface CharterViolation {
  code: string;
  message: string;
}

/**
 * 模块对宪章条款的**显式偏离**。
 *
 * 与 `docs/RULES-DEVIATIONS.md` 一一对应：那边写理由，这边写机器判据。
 * 没有登记就偏离，strict 模式下会被记成违规。
 */
export interface CharterDeviation {
  /** 违反的条款，如 'C-2'。 */
  clause: string;
  /** 为什么偏离；必须写成一句话，会进审计日志。 */
  reason: string;
  /** 到期待复核的日期（YYYY-MM-DD）。过期未续相当于未登记。 */
  expires?: string;
}

/** 模块对自身状态的字段契约（C-9）。 */
export interface StateSchemaDeclaration {
  /**
   * `state.globalVars` 允许出现的 key 集合。未在此登记的 key 出现即违规。
   *
   * 约定：`__` 前缀的 key 视为内核/调试用途，不做检查。
   */
  globalVars?: readonly string[];
  /**
   * 允许出现在 `player.customProps` / `entity.components.custom` 上的 key。
   * 不声明则不检查（比 globalVars 弱一档：这两处历史上更自由）。
   */
  customProps?: readonly string[];
}

/** 内核依据模块声明拼出来的执行上下文。由 `resolveCharter` 产出。 */
export interface ResolvedCharter {
  /**
   * 是否记录 C-2（单步转移）。false 表示该模块已登记偏离 C-2。
   */
  enforceSingleTransition: boolean;
  /** 声明了 `actionSchemas` 才能查 C-1；false 表示整块未形式化（由报告脚本统计）。 */
  checksActionAlgebra: boolean;
  /** C-9 的 globalVars key 白名单；undefined 表示模块未声明、不检查。 */
  declaredGlobalVars: ReadonlySet<string> | undefined;
  /** 已登记且未过期的偏离；`checkCharter` 用它决定是否抑制某条违规。 */
  activeDeviations: readonly CharterDeviation[];
}

const KERNEL_VAR_PREFIX = '__';

/** 把模块声明解析成内核可用的判据。纯函数。 */
export function resolveCharter(module: GameModule): ResolvedCharter {
  const today = new Date().toISOString().slice(0, 10);
  const active = (module.charter?.deviations ?? []).filter(d => !d.expires || d.expires >= today);

  return {
    enforceSingleTransition: !active.some(d => d.clause === 'C-2'),
    checksActionAlgebra: !!module.actionSchemas,
    declaredGlobalVars: module.meta.stateSchema?.globalVars
      ? new Set(module.meta.stateSchema.globalVars)
      : undefined,
    activeDeviations: active
  };
}

/** 动作类型是否在模块的代数声明之内（C-1）。 */
export function isDeclaredAction(module: GameModule, action: Action): boolean {
  if (!module.actionSchemas) return true; // 模块整体未声明：交给报告脚本，不在热路径逐个报
  if (action.type === '__TICK__') return true;
  if ((module.driverActions ?? []).includes(action.type)) return true;
  return Object.prototype.hasOwnProperty.call(module.actionSchemas, action.type);
}

/**
 * 校验一次转移的宪章合规性（C-1 / C-6 / C-9）。
 *
 * 只做**检查**：返回违规列表，调用方决定怎么用。`state` 应当是转移**之后**
 * 的状态；`action` 是触发它的动作（可为 undefined，例如时钟推进）。
 */
export function checkCharter(
  module: GameModule,
  charter: ResolvedCharter,
  state: GameState,
  action?: Action
): CharterViolation[] {
  const out: CharterViolation[] = [];
  const suppressed = (clause: string) => charter.activeDeviations.some(d => d.clause === clause);

  /* C-1 动作代数 ------------------------------------------------------- */
  if (action && !suppressed('C-1') && !isDeclaredAction(module, action)) {
    out.push({
      code: 'CHARTER_C1_UNDECLARED_ACTION',
      message: `action "${action.type}" has no entry in actionSchemas`
    });
  }

  /* C-9 扩展字段收口 ---------------------------------------------------- */
  if (!suppressed('C-9') && charter.declaredGlobalVars) {
    const declared = charter.declaredGlobalVars;
    for (const key of Object.keys(state.globalVars ?? {})) {
      if (key.startsWith(KERNEL_VAR_PREFIX)) continue;
      // 值被删成 undefined 的 key 不算"出现过"：模组常用 delete 收尾。
      if (state.globalVars[key] === undefined) continue;
      if (!declared.has(key)) {
        out.push({
          code: 'CHARTER_C9_UNDECLARED_GLOBAL_VAR',
          message: `globalVars.${key} is not declared in meta.stateSchema.globalVars`
        });
      }
    }
  }

  /* C-7 收益独立 -------------------------------------------------------- */
  if (!suppressed('C-7') && module.charter?.requiresRewardLedger && state.rewards) {
    for (const entry of state.rewards) {
      if (!entry || typeof entry.actorId !== 'string' || typeof entry.kind !== 'string') {
        out.push({ code: 'CHARTER_C7_BAD_REWARD', message: 'reward entry is missing actorId or kind' });
        continue;
      }
      if (!Number.isFinite(entry.amount) || entry.amount === 0) {
        out.push({
          code: 'CHARTER_C7_BAD_REWARD',
          message: `reward for ${entry.actorId} has a non-finite or zero amount`
        });
      }
      if (!entry.reason || entry.reason.trim().length === 0) {
        // 没有理由的收益等于没记账：事后无法回答"哪条规则给了这一分"。
        out.push({
          code: 'CHARTER_C7_BAD_REWARD',
          message: `reward ${entry.actorId}/${entry.kind} carries no reason`
        });
      }
    }
  }

  /* C-6 语义不变量 ------------------------------------------------------ */
  if (!suppressed('C-6') && module.checkInvariants) {
    let messages: string[] = [];
    try {
      messages = module.checkInvariants(state);
    } catch (error) {
      messages = [`checkInvariants threw: ${error instanceof Error ? error.message : String(error)}`];
    }
    for (const message of messages) {
      out.push({ code: 'CHARTER_C6_SEMANTIC_INVARIANT', message });
    }
  }

  return out;
}

/**
 * C-5 的**类型级**保障的运行时镜像。
 *
 * 类型系统已经能挡住 `choosePokerAction(rawState, …)`（入参是
 * `ProjectedGameState`）；这里补一条运行期断言，防止 `as any` 绕过。
 * 只在 strict 且模块声明了 `requiresProjection` 时启用。
 */
export function assertProjectedView<T extends ProjectedGameState>(
  view: T,
  actorId: string
): T & { viewerId: typeof actorId } {
  if (!view || __DEV_WEAK__(view)) {
    throw new Error('AI decision received a raw GameState instead of a projected view');
  }
  if (view.viewerId !== actorId) {
    throw new Error(
      `projected view is for ${String(view.viewerId)} but the decision is for ${actorId}`
    );
  }
  return view as T & { viewerId: typeof actorId };
}

/**
 * 判定一个"像状态但可能不是投影"的对象。
 *
 * 投影状态一定带 `viewerId` 且一定**没有** `prngState` / `seed`
 * （`ProjectedGameState` 显式 Omit 了这两个字段）。原始状态恰好相反。
 */
function __DEV_WEAK__(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  const record = value as Record<string, unknown>;
  if (typeof record.viewerId !== 'string') return true;
  return record.prngState !== undefined || record.seed !== undefined;
}
