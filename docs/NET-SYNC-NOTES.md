# 联机增量同步复测（2026-11）

- 条件：hub `:8787`（server 权威），Playwright 独立 context A=host/p1、B=guest/p2，poker `seats_2`；A 依次 RAISE / RAISE / FOLD，B 中间 CALL / CHECK。
- B 的 ws `room-update` 序列：`0F, 0F, 1D, 1D, 2D, 2D … 7D`；每步的第二个 delta `patches=0`，投影内容不变。
- NetSession：A 每步后 B 的 `snapshot.revision` / `netRevision` 均同步递增 1→7，projection 的 `board.seq` 与 `actionLog.length` 同为 1→7。
- scene：每个 revision 增加后 p1 的立柱 group 都换了 UUID（重建），p1 手牌 mesh 数量 2→2→0，并始终与 A 侧同一座位的手牌数/坐标一致。
- 结论：在 main 上**未能复现**「B 看不到 A 立柱/手牌移动」；服务端广播、NetSession 应用、scene 重建三段均正常，未做猜测性修复。
- 探针口径：`ProjectedGameState` 没有 revision 字段，报告用 `session.revision` + `scene.lastState.seq`；失败时请附 B 的原始 ws 帧与 `scene.lastBoardKey`。
- 未覆盖：B 重连、P2P 通道、AI 桌面；这些路径不能由本次证据下结论。
