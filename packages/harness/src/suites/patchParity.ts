/**
 * 类型级一致性校验（issue #218）：协议的 op 集合必须与实现完全一致。
 *
 * 两边各写一份 `Record<Op, ...>` 字面量：
 * - 协议多声明一个 op（比如 move）→ 第一份字面量缺 key，tsc 报错；
 * - 实现新增一个 op 但协议没跟上 → 第二份字面量缺 key，tsc 报错。
 *
 * 这样不需要运行时断言，也不会因为"结构不同"而误报。
 */
import type { PatchOp as ProtocolOp } from '@rds/room-protocol';
import type { PatchOp as NetOp } from '@rds/net/patch';

const protocolOps: Record<ProtocolOp['op'], true> = { add: true, remove: true, replace: true };
const implementedOps: Record<NetOp['op'], true> = { add: true, remove: true, replace: true };

void protocolOps;
void implementedOps;
