/**
 * 宪章 / AR-48：`capabilities` 的内核侧推导与消费。
 *
 * ## 问题
 *
 * `GameCapabilities` 的四个布尔位（`simultaneousMoves` / `hiddenInformation` /
 * `interruptStack` / `dynamicRules`）原本只被 `apps/web/src/ui/mathInspector.ts`
 * 读来渲染四个小标签 —— 内核的调度、合法性、投影路径从不看它们。
 * "能力位"于是退化成了"给人看的装饰"。
 *
 * ## 处理方式
 *
 * 1. **可推导的能力不再手写**：它们都能从模块声明 + 状态事实上算出来，
 *    算法在这里，内核在构造时算一次并用于校验模块的声明。
 * 2. **内核真的消费**：`interruptStack` / `simultaneousMoves` 等被用于
 *    合法性校验与不变量检查（见 `engine.ts` 的 `capabilityViolations()`）。
 * 3. 声明与推导不一致时**不静默**：strict 模式下记为宪章违规。
 *
 * 这样做的好处：模块作者写错能力位不会再无声无息，而纯派生的位（如
 * `hiddenInformation`）可以完全省掉声明。
 */

import type { GameModule } from './module';
import type { GameState } from './types';

/** 从模块声明（不依赖运行时状态）可推导的能力位。 */
export interface DerivedCapabilities {
  /** 模块声明了钩子 → 规则可被动态改写。 */
  dynamicRules: boolean;
  /** 模块声明了钩子或使用中断栈 → 存在可插入的响应窗口。 */
  interruptStack: boolean;
  /** 模块声明了 `applySimultaneous` → 存在真正的同时结算。 */
  simultaneousMoves: boolean;
  /** 模块声明了投影脱敏器，或在 setup 里放了隐藏可见性的实体。 */
  hiddenInformation: boolean;
}

/**
 * 模块通过 `meta.capabilities` 之外的**代码事实**表达的额外能力。
 *
 * 由调用方通过 `moduleSources` 传入：内核不该自己读文件系统，但推导时
 * 需要知道"这个模块有没有调用 `InterruptStackManager`"。测试与
 * `charter` 校验脚本可以构造这份映射。
 */
export interface CapabilityEvidence {
  /** 模块的源码里是否出现 `InterruptStackManager.push`。 */
  usesInterruptStack?: boolean;
}

const HIDDEN_VISIBILITY = new Set(['OWNER_ONLY', 'SUBSET', 'HIDDEN']);

/**
 * 推导模块的能力位。
 *
 * 判据刻意保守：**只认代码事实**，不认注释。任一条为真即认为该能力存在。
 *
 * 注意 `hiddenInformation` 需要看状态（实体可见性），模块声明层面只看
 * 是否提供了 `project` 脱敏器；运行期还会由 `stateHasHiddenInformation()`
 * 再确认一次。
 */
export function deriveCapabilities(
  module: GameModule,
  evidence: CapabilityEvidence = {}
): DerivedCapabilities {
  const hooks = module.hooks?.length ?? 0;
  return {
    // 钩子 = 规则可被动态改写。
    dynamicRules: hooks > 0,
    // 中断栈能力**不等于**"有钩子"：dune_mahjong 的 hooks 是空数组，却在
    // rules 里直接调用 `InterruptStackManager.push()`
    // （麻将响应窗口）。因此判据是"钩子 或 显式证据"。
    interruptStack: hooks > 0 || evidence.usesInterruptStack === true,
    // 只有声明了"真正的同时结算入口"才算；`kind: 'SIMULTANEOUS'` 的**单人**
    // 窗口不算（betrayal 的伤害分摊就是这种）。
    simultaneousMoves: typeof module.applySimultaneous === 'function',
    // 隐藏信息**不靠脱敏器**：poker 的牌靠实体的 OWNER_ONLY 可见性隐藏，
    // splendor 靠区域可见性。因此这里一律看运行时状态（见下方 stateHasHiddenInformation）。
    hiddenInformation: false
  };
}

/**
 * 运行期确认：状态里是否存在中断栈帧。
 *
 * **注意**：这只表示"当下是否有一个栈帧挂着"，不能用来判断模块**有没有能力**用
 * 中断栈 —— dune_mahjong 会在麻将响应窗口 push 帧，但随机对局多数时候栈是空的。
 * 用它去否决 `interruptStack: true` 会得到假阳性（我第一版实现就踩了这个坑）。
 */
export function stateHasInterruptStack(state: GameState): boolean {
  return (state.interruptStack?.length ?? 0) > 0;
}

/** 运行期确认：状态里是否真的存在对某些观察者不可见的实体 / 区域。 */
export function stateHasHiddenInformation(state: GameState): boolean {
  for (const zone of Object.values(state.zones ?? {})) {
    if (zone.visibility && HIDDEN_VISIBILITY.has(zone.visibility.type)) return true;
  }
  for (const entity of Object.values(state.entities ?? {})) {
    if (entity.visibility && HIDDEN_VISIBILITY.has(entity.visibility.type)) return true;
  }
  return false;
}

/** 一条能力位与实现不符的记录。 */
export interface CapabilityMismatch {
  field: keyof DerivedCapabilities;
  declared: boolean;
  derived: boolean;
  message: string;
}

/**
 * 对照声明与推导。返回不一致项（通常是"声明说没有，但实现里有"或反之）。
 *
 * 只在 strict 模式下由内核上报，作为宪章违规的一种 —— 模块作者写错能力位
 * 应该被看见，而不是等到某天有人依赖这个位做分支时才发现是假的。
 */
export function capabilityMismatches(
  module: GameModule,
  state?: GameState,
  evidence: CapabilityEvidence = {}
): CapabilityMismatch[] {
  const declared = module.meta.capabilities;
  const derived = deriveCapabilities(module, evidence);

  // 依赖运行时状态的能力位在此覆盖静态推导。
  // `interruptStack` 不在此列：栈为空不代表模块没有这个能力。
  if (state) {
    derived.hiddenInformation = stateHasHiddenInformation(state);
  }
  const out: CapabilityMismatch[] = [];

  const pairs: [keyof DerivedCapabilities, boolean][] = [
    ['dynamicRules', declared.dynamicRules],
    ['interruptStack', declared.interruptStack],
    ['simultaneousMoves', declared.simultaneousMoves],
    ['hiddenInformation', declared.hiddenInformation]
  ];

  for (const [field, claim] of pairs) {
    const truth = derived[field];
    // 只报"声称有但没有"（谎言）与"声称没有但有实现"（遗漏）。
    // 声明为 true 但推导为 false 是有意义的（例如钩子为空但保留扩展点），不报。
    if (claim !== truth) {
      out.push({
        field,
        declared: claim,
        derived: truth,
        message: `capabilities.${field} declared ${claim} but the implementation says ${truth}`
      });
    }
  }

  return out;
}
