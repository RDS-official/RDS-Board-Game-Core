# 通用桌游内核 · Universal Board Game Kernel

> 产品是**内核框架**，不是某一款桌游。
> `packages/games/src/*` 下的六款游戏只是**一致性测试夹具**，用来证明内核可以覆盖顺序回合、递归响应、隐藏信息、同步盲提与运行时改规则。

```
𝒢 = ⟨𝒩, 𝒮, s₀, 𝒜, ℒ, 𝒯, 𝒪, ℛ, 𝒦⟩
```

内核把任意桌面博弈编译为：**纯 JSON 状态 + 纯函数转移 + 可热插拔规则 + 信息投影 + 事件溯源**。浏览器端（Three.js + HUD）是这套内核的可视化调试器。

> 截图不入库。所有验证图由 `pnpm shots` 现场生成到 `shots/`（该目录已在 `.gitignore` 中），
> 需要时自己跑一次即可，避免二进制历史不断膨胀。

---

## 1. 快速开始

```bash
pnpm install
pnpm run dev       # http://127.0.0.1:5173/  （可视化调试器）
# 场景直达：http://127.0.0.1:5173/?scenario=rich_action
pnpm test          # 内核一致性 257 例 + 分层边界检查
pnpm run build     # 生产构建
pnpm shots         # 按需生成全部验证截图到 shots/（自动起停 dev server）
```

内核本身可在 Node 中通过 Vite SSR 直接加载（见 `scripts/test-core.mjs`），不依赖浏览器。

> 生产环境部署方案（Docker 单容器、Docker Compose 一键编排、Node.js + PM2 进程守护等）详见 **[§10 部署方案](#10-部署方案)**。

---

## 2. 这个内核解决什么问题

| 能力 | 机制 | 代码 |
| --- | --- | --- |
| 确定性状态转移 | `dispatch` 单一管线 + 纯函数 reduce | [engine.ts](packages/kernel/src/engine.ts) |
| 隐藏信息与反作弊 | `𝒪(s,i)` 投影、虚拟 ID、区域重映射、模块级 redactor | [observer.ts](packages/kernel/src/observer.ts) |
| 递归响应链 | LIFO 中断栈、响应窗口、优先级短路 | [stack.ts](packages/kernel/src/stack.ts) |
| 同步/秘密决策 | 决策窗口、秘密提交、原子揭晓 | [decisions.ts](packages/kernel/src/decisions.ts) |
| 运行时改规则 | 规则以数据挂载，实现从注册表解析 | [aop.ts](packages/kernel/src/aop.ts) · [rules.ts](packages/kernel/src/rules.ts) |
| 状态可持久化 | 状态内禁止函数；规则实现不在状态里 | [types.ts](packages/kernel/src/types.ts) |
| 结构正确性 | 30+ 条不变量，转移后校验 | [invariants.ts](packages/kernel/src/invariants.ts) |
| 回溯与时间机器 | 规范化 JSON + FNV-1a 哈希 + 完整动作历史 | [serialize.ts](packages/kernel/src/serialize.ts) |
| 扩展契约 | `GameModule` 接口 + 能力矩阵 | [module.ts](packages/kernel/src/module.ts) |
| 动作结构校验 | 模块声明 `actionSchemas`，合法性之前校验 | [validation.ts](packages/kernel/src/validation.ts) |
| 规则依赖图 | `requires` 声明、环检测、依赖优先执行 | [rules.ts](packages/kernel/src/rules.ts) |
| AI 接口 | `BotPolicy` + 随机策略 + 批量对局 | [policy.ts](packages/harness/src/policy.ts) |
| 网络适配层 | 权威房间 + 投影增量补丁 | [room.ts](packages/net/src/room.ts) · [patch.ts](packages/net/src/patch.ts) |
| UI 解耦 | Presenter + DTO + PresentationPorts | [contracts.ts](packages/app/src/contracts.ts) · [session.ts](packages/app/src/session.ts) |
| 决策策略 | ALL_COMMITTED / FIRST_ACCEPT / PRIORITY，首个接受短路 | [decisions.ts](packages/kernel/src/decisions.ts) |
| 玩家级超时 | 每个参与者独立 deadline，逐人 PASS | [engine.ts](packages/kernel/src/engine.ts) |
| 可重放场景 | module.scenarios + 导出日志携带 scenario | [module.ts](packages/kernel/src/module.ts) |
| 参数表单 | Action.fields → UI 表单 → payload，一步完成 | [contracts.ts](packages/app/src/contracts.ts) · [hud.ts](apps/web/src/ui/hud.ts) |
| 逻辑时钟与超时 | `__TICK__` 控制动作、decision/response deadline、可重放超时 | [engine.ts](packages/kernel/src/engine.ts) |
| 检查点持久化 | 种子 + Action Log 导出、重放式恢复 | [room.ts](packages/net/src/room.ts) |

规则手册级的契约见 **[docs/CORE.md](docs/CORE.md)**；当前分层、模块实现与调用链见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**；山屋的规则覆盖与模拟器缺陷评估见 **[docs/BETRAYAL.md](docs/BETRAYAL.md)**；内核表达缺陷的改造 RFC 见 **[docs/KERNEL-EXPRESSION.md](docs/KERNEL-EXPRESSION.md)**；持续维护的模拟器质量清单见 **[docs/SIMULATOR-AUDIT.md](docs/SIMULATOR-AUDIT.md)**。

待办分成两份，**只记还没做的事**（已完成的按时间留在审计账本里，不重复）：

- **[docs/BACKLOG.md](docs/BACKLOG.md)** — 可选开发：性能基线结论、楼层隔离与小地图、效果生命周期、检定窗口、i18n、网络，以及"已明确不做"清单。§10 附**复核手法**：动手前先确认该待办是否仍然成立。
- **[docs/ARCHITECTURE-ISSUES.md](docs/ARCHITECTURE-ISSUES.md)** — 架构层：已修问题（AI-01~17）、重复特性合并建议、仍未完成的 AI-21/23/24/25/27。
- **[docs/UI-ARCHITECTURE.md](docs/UI-ARCHITECTURE.md)** — 表现层升级方案：现状实测（41 条绝对定位、167 处硬编码字号、移动端行动坞宽度归零）、业界方案调研（设计令牌 / 容器查询 / 流体排版 / Lit）、分层目标架构与 5 个阶段的可独立合并迁移路线。

---

## 3. 核心管线

`engine.dispatch(action)`：

```
validate → 决策窗口 Δ → 响应窗口 Σ → AOP(𝒦) → reduce(𝒯) → outcome(ℛ)
        → invariants → hash → actionLog → visual events
```

- **拒绝路径不改变状态**；
- **被规则取消的动作不递增 `seq`、不写日志**，因此回放严格对齐；
- 回放不是“再 reduce 一次”，而是用完全相同的 `dispatch` 管线重新推演（含决策、栈与钩子）。

状态只保存规则**数据**：

```ts
activeHooks: [{ instanceId, hookId: 'haunt_crimson_beast', ownerId, params: { bonusMight: 2 } }]
```

实现位于模块的 `hooks` / `RuleRegistry`，因此 `GameState` 永远可以 `JSON.stringify`、哈希与跨进程传输。钩子可用 `requires` 声明前置依赖，注册表会做环检测并按依赖顺序执行。

动作在进入合法性判断前先过 `actionSchemas`（必填/枚举/范围），防止畸形提交进入秘密决策窗口。

---

## 4. 六款夹具验证的能力

| 夹具 | 验证点 |
| --- | --- |
| Catan | 蛇形初始布局、9 港口 3:1/2:1、有限银行、19 地形 + 18 数字、25 发展卡、7 点弃牌/强盗/偷取、最长道路/最大军队、隐藏 VP、10 分胜利 |
| Sanguosha | 递归中断栈（杀→闪/八卦→濒死→无懈）、暗置身份、AOP 拦截 |
| Splendor | 近似完全信息、永久费用修饰器、自动结算 |
| Betrayal | 44 房间、四维轨道、13 预兆/25 物品/45 事件、NPC 怪物与三剧本 |
| Dune / Mahjong | 秘密同步决策 `|P(s)|>1`、优先级仲裁与短路 |
| Poker | 无限注下注轮、2–10 人、52 张牌的确定性洗牌与暗底牌、边池分层、平分余数、短全押不重开叫注 |

| 三国杀响应栈 | 山屋三剧本 | 沙丘秘密决策 |
| --- | --- | --- |
| `05b-sanguosha-stack-panel.png` | `betrayal-mummy-01.png` | `11b-dune-secret.png` |

| Catan 初始布局 | Catan 建造与最长道路 | Catan 发展卡 | 参数表单 |
| --- | --- | --- | --- |
| `20-catan-setup.png` | `22-catan-built.png` | `23-catan-dev.png` | `24-catan-payload-form.png` |

> 上表是 `pnpm shots` 生成的文件名，不是已入库的图片；跑一次脚本就能在 `shots/` 里看到。

> 夹具只实现 `setup / legalActions / reduce / outcome`。调度、隐藏、中断、热注入、回放全部由内核负责。

### Catan 规则覆盖

- 19 张地形（4 木 / 4 羊 / 4 麦 / 3 砖 / 3 矿 / 1 沙漠）、18 个数字片、9 个港口（5 个 2:1 + 4 个 3:1）；
- 蛇形初始布局 `p1→p2→p3→p3→p2→p1`：定居点 + 道路，距离规则、第二座定居点获得初始资源；
- 有限银行（每种 19 张），生产受银行库存与强盗阻挡；
- 7 点：>7 张者弃半、移动强盗、按相邻建筑偷取 1 张；
- 建筑：道路 / 定居点 / 城市 / 发展卡，费用与 VP 完全按规则；
- 25 张发展卡：14 骑士、2 垄断、2 修路、2 丰饶、5 分数卡；购买当回合不可打出；
- 最长道路（≥5，对手建筑阻断）与最大军队（≥3 骑士）各 2 VP，平局保持原持有者；
- 玩家交易走 FIRST_ACCEPT 决策窗口（1:1），银行/港口交易支持 4:1 / 3:1 / 2:1；两者都是单动作 + 参数表单；
- 10 分胜利；分数卡（VP）对对手隐藏，游戏结束时揭晓；
- 简化：弃半自动按“最大堆优先”执行；玩家交易固定 1:1；发展卡仅在 ACTION 阶段打出（官方允许掷骰前）。

---

## 5. 分层与边界

```
apps/web/src/main.ts (装配根)
   │
   ▼
UniversalSession (packages/app/src)  ──GamePresenter(DTO)──▶  apps/web/src/ui/hud.ts, mathInspector.ts
   │  owns engine                                                  │
   ▼                                                              ▼
UniversalGameEngine (packages/kernel/src)                 PresentationPorts
                                                                  │ camera / audio / highlight
                                                                  ▼
                                                        apps/web/src/render (Three.js)
```

- UI **只** import `packages/app/src/contracts`，不 import 引擎、游戏模块、Three.js、音频；
- 应用层负责动作标签、玩家卡片、阶段文案、已脱敏日志与重放结果；
- 相机 / 音效 / 桌面高亮经 `PresentationPorts` 回传；
- `pnpm test` 内置静态边界检查：UI 引用 core/games/render/net/ai 即失败。

---

## 6. 一致性测试

```bash
pnpm test
```

```
Universal Board Game Kernel — conformance suite
  ✓ serialize: canonical order + hashing is stable
  ✓ stack: LIFO order, response collection and priority short-circuit
  ✓ decisions: secret submissions stay hidden until reveal
  ✓ observer: hidden cards are scrubbed, aliased and zone-remapped
  ✓ engine: deterministic replay reproduces the exact state hash
  ✓ validation: schemas reject malformed actions before legality
  ✓ fixture */initialises under strict invariants        (×5)
  ✓ fixture */random play + bit-exact replay             (×5)
  ✓ fixture */projections never leak hidden card faces   (×5)
  ✓ room: projection patches round-trip exactly
  ✓ room: hidden information never appears in patches
  ✓ room: an injected engine is the single source of truth (A2)
  ✓ room: checkpoints restore through replay
  ✓ presenter: viewer switching reprojects without exposing the raw engine

  Architecture boundary

  ✓ UI / application / kernel imports are separated

  257 passed, 0 failed, 257 cases, 0 boundary violations
```

（节选；完整清单见 `node scripts/test-core.mjs` 输出）

---

## 7. 目录

```
packages/kernel/src/                 # 内核（与具体游戏无关）
  engine.ts               # 调度、校验、回放、哈希
  module.ts               # GameModule 契约 + 能力矩阵
  types.ts                # 状态/动作/栈帧/决策窗口/规则钩子
  rules.ts                # RuleHookImpl + RuleRegistry + 依赖图
  aop.ts                  # FILTER_MODIFY / BEFORE_REPLACE / AFTER_TRIGGER
  stack.ts                # LIFO 中断栈
  decisions.ts            # 秘密/同步决策
  observer.ts             # 𝒪(s,i) 投影、反作弊、日志脱敏
  invariants.ts           # 结构不变量
  serialize.ts            # 规范化 JSON + FNV-1a
  validation.ts           # 动作 Schema 校验
  ecs.ts / graph.ts / prng.ts
packages/app/src/                    # 应用层：Presenter 契约 + Session + DTO
packages/harness/src/                # 一致性测试套件（suite.ts + suites/*）+ Bot 策略
packages/net/src/                    # 权威房间 + RFC6902 投影差分 + WebRTC transport
packages/games/src/                  # 六款夹具（setup + rules + hooks）
apps/web/src/render/                 # Three.js 可视化调试器
  procedural/             # 2.5D 洋馆资产库
    materials.ts          #   共享 PBR 调色板（木/金属/石材/织物/自发光）
    props.ts              #   45+ 件程序化家具与陈设（床/柜/书柜/实验台/石棺/熔炉/烛台…）
    roomLayout.ts         #   门位感知布局引擎（门廊禁区 + AABB 互斥 + 连通性洪水填充）
    roomTile.ts           #   房间壳体：墙纸/护墙板/踢脚/线脚/窗/门套/门槛 + 按材质合并
    cardMesh.ts           #   做旧羊皮纸卡面与皮革烫金卡背
apps/web/src/ui/                     # HUD 与数学模型检查器
  theme-gothic.css        # 山屋专用烛光/黄铜主题覆盖层
apps/web/src/lobby/                  # 大厅 / 房间 / 联机 UI
apps/server/src/                     # 大厅 + 服务器权威对局（MatchBroker）+ WebRTC 信令（Hono + ws + PM2 部署）
docs/CORE.md                         # 契约、扩展指南、路线图
docs/ARCHITECTURE.md                 # 分层架构、模块实现与调用链
docs/BETRAYAL.md                     # 山屋 44 房间/三剧本覆盖 + 内核缺陷清单
docs/KERNEL-EXPRESSION.md            # 内核表达缺陷分析与分波次改造 RFC
scripts/test-core.mjs                # Vite SSR 测试运行器
```

---

## 8. 设计取舍

- **不做“万能规则 DSL”**：规则仍是 TypeScript 纯函数，但所有横切能力（调度/隐藏/栈/热注入/回放）被内核收口，避免每款游戏重复实现。
- **规则实现与状态分离**：这是可序列化、可回放、可联网的前提。
- **严格模式**：非法动作与不变量违例默认拒绝并保持状态不变，便于夹具开发时立刻暴露问题。
- **夹具优先**：先让多种极端机制跑通，再抽象；不为单一游戏做特例。

---

## 9. 2.5D 洋馆资产库与布局引擎

> 目标：让《山屋惊魂》的桌面读起来像一座被剖开的微缩洋馆，而不是一堆贴图方块。
> 相关契约与回归方式见 **[docs/SIMULATOR-AUDIT.md](docs/SIMULATOR-AUDIT.md)**（§3.3.1 几何硬约束）。

### 9.1 资产库（`apps/web/src/render/procedural/props.ts`）

每件陈设都是一个返回 `THREE.Group` 的构建器，约定「落地在 y=0、正面朝 +Z、背面贴墙」，
由布局引擎负责旋转与落位。所有部件共享 `materials.ts` 的单例材质，因此房间可以按材质
合并几何：一间房从 ~400 个 draw call 降到 ~12 个。

| 类别 | 代表资产 |
| --- | --- |
| 卧室 | 四柱床（床柱/帷架/被褶/翻边床单）、半开衣柜（挂衣杆+衣物+叠放织物）、梳妆柜（倾斜镜+香水瓶）、摇篮、木马、玩具箱 |
| 书斋 | 分层书柜（斜靠书/横堆/书立/胸像/卷轴）、写字台（抽屉+墨水瓶+烛台）、落地钟（钟摆+表盘）、立式钢琴、落地镜、地球仪 |
| 起居 | 壁炉（炉膛辉光+壁炉架陈设）、沙发、扶手椅、边几、衣帽架 |
| 餐饮 | 长餐桌（桌旗+烛台+餐位）、高背餐椅（面向桌心）、厨房操作台（水槽+陶器）、吊挂锅具、食品架 |
| 实验 | 实验台（蒸馏装置/试管架/酒精灯）、手术台（束缚带/无影灯）、标本架（玻璃罐）、工作台（工具板/台钳） |
| 神秘 | 石棺（象形纹带）、棺架、祭坛（圣布+仪式碗+烛台）、五芒星法阵、骨堆、颅骨堆、雕像、盔甲架 |
| 地下 | 熔炉（炉膛/烟道/煤堆）、锅炉、铁笼、水洼、石笋、酒架、木桶组、箱堆 |
| 大门 | 门厅双扇前门（石套+大理石过梁+铁铆钉+门环+锁梁） |
| 壁面 | 肖像画、壁烛、织锦、蜘蛛网（角部专用） |

### 9.2 布局引擎（`apps/web/src/render/procedural/roomLayout.ts`）

```
门廊禁区 → 墙挂优先 → 中心件 → 卫星件（餐椅绕桌）→ 连通性校验
```

- **门廊禁区**：每扇门向内 0.58、宽 0.92 的走廊内禁止放任何实体，家具永不堵门；
- **精确 AABB 互斥**：摆放前与已落位实体做矩形不相交测试（含 0.045 安全边距）；
- **连通性洪水填充**：落位后从门格出发泛洪，必须仍能到达其余所有门格，否则回滚该件；
- **确定性**：种子来自 `roomId + 名称 + 门位`，同一房间每次重建布局完全一致。

`node scripts/probe-layout.mjs` 会把 47 个房间全部跑一遍并报告落位数、拒绝数与**门位冲突数（应为 0）**。

### 9.3 几何硬约束与回归

棋盘格距 2.86、板块边长 2.84，相邻板块净距仅 **0.02**。任何构件越过 `±1.42` 就会挤进邻块，
并与邻块共面产生 **z-fighting 闪烁**。`node scripts/probe-overlap.mjs` 逐顶点换算世界坐标，
断言所有房间的包围盒 `≤ ±1.42`——新增贴墙/贴角构件后必须跑一次。

### 9.4 界面（复古哥特）

| 界面 | 表现 |
| --- | --- |
| 角色卡 | 速/力/智/识 四条 0..8 阶梯，实心=当前值，空心框=印刷初值 |
| 卡牌详情 | 做旧羊皮纸浮层：牌型色带、火漆印章、英文副标题、事实表 |
| 房间档案 | 楼层徽章、门位罗盘、印刷描述、在场者、`◎` 镜头聚焦 |
| 房间揭示 | 探索出新板块时居中弹出，配入场动画，7s 自动收起 |
| 作祟过场 | 全屏暗红晕影 + `HAUNT No.xx` + 巨号标题 + 背叛者 + 角色化目标 |
| 悬停提示 | 光标所指对象与可执行动作（房间/门/卡牌/骰子） |

---

## 10. 部署方案

RDS-Board-Core 在 Monorepo 重组后，由单一服务同时承载：
- **联机大厅与信令服务端 (Hub Server)**：基于 Hono + ws，提供 `/healthz`、`/api/*`、`/ws` 信令；
- **前端静态外壳与 3D 游戏调试器**：构建产物位于 `dist/`，由 Hub 服务端直接内嵌托管（根路径承载统一外壳 SPA，`/games/rds-board-core/` 承载子应用）。

提供以下三种标准化生产部署方案。

### 10.1 方案一：Docker 独立容器部署

Dockerfile 采用多阶段构建（Stage 1: Node 22 + pnpm 编译静态资源；Stage 2: 极简 Node 22 镜像运行 `tsx apps/server/src/index.ts`），单容器同时提供 Web、API 与 WebSocket 信令服务。

#### 1. 构建镜像

```bash
docker build -t rds-board .
```

#### 2. 运行容器

```bash
docker run -d \
  --name rds-board \
  -p 8787:8787 \
  -e HUB_SECRET="your-production-secret-token" \
  -v rds-data:/repo/apps/server/data \
  --restart unless-stopped \
  rds-board
```

容器启动后，访问 `http://localhost:8787/` 即可进入联机大厅与游戏界面；健康检查端点为 `http://localhost:8787/healthz`（返回 `{"ok":true}`）。

---

### 10.2 方案二：Docker Compose 一键容器编排部署（推荐）

适合快速部署与生产运维管理，`docker-compose.yml` 已配置健康检查（打 `/healthz`）、自动重启、端口绑定及数据卷持久化。

#### 1. 一键启动

```bash
# 默认端口 8788 映射至容器 8787 端口
docker compose up -d
```

#### 2. 自定义端口与常用命令

```bash
# 指定宿主机端口与会话密钥启动
PORT=8787 HUB_SECRET="your-production-secret-token" docker compose up -d

# 查看容器运行状态与健康检查结果
docker compose ps

# 查看实时日志
docker compose logs -f

# 停止并移除容器
docker compose down
```

---

### 10.3 方案三：Node.js 运行时与 PM2 进程守护部署（原生服务器部署）

适合拥有 Node.js 环境的 Linux VPS 或独立物理机，使用 PM2 守护完整的 Hub 服务端。

#### 1. 安装依赖并执行生产构建

```bash
pnpm install
pnpm run build
```

#### 2. 使用 PM2 进行守护运行

仓库内已预置 `ecosystem.config.cjs` 配置文件，运行 `apps/server/src/index.ts`：

```bash
# 全局安装 PM2（如未安装）
npm install -g pm2

# 启动服务（支持环境变量覆盖端口和密钥）
PORT=8787 HUB_SECRET="your-production-secret-token" pm2 start ecosystem.config.cjs

# 管理服务
pm2 status                  # 查看运行状态
pm2 logs rds-board-core     # 查看输出日志
pm2 restart rds-board-core  # 重启服务
pm2 stop rds-board-core     # 停止服务

# 设置开机自启
pm2 save
pm2 startup
```

---

### 10.4 补充：Caddy / Nginx 反向代理配置（必须支持 WebSocket）

由于 Hub 服务端包含 `/ws` WebSocket 信令以及 `/healthz`、`/api`，反向代理必须正确转发并支持 HTTP Upgrade。

#### Caddy 配置示例：

```caddy
rdsbg.example.com {
	encode zstd gzip

	# 转发全部流量到 Hub 服务端（8787），Caddy 默认原生支持 WebSocket
	reverse_proxy http://127.0.0.1:8787
}
```

#### Nginx 配置示例：

```nginx
server {
    listen 80;
    server_name rdsbg.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 11. 代码贡献量统计 (Contributors & Code Stats)

### 11.1 贡献者墙 (Contributors)

<p align="center">
  <a href="https://github.com/RDS-official/RDS-Board-Game-Core/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=RDS-official/RDS-Board-Game-Core" alt="Contributors" />
  </a>
</p>

### 11.2 代码贡献量指标 (Contribution Metrics)

<p align="center">
  <img src="https://img.shields.io/github/commit-activity/m/RDS-official/RDS-Board-Game-Core?label=Monthly%20Commits&color=d9b45b" alt="Commit Activity" />
  <img src="https://img.shields.io/github/contributors/RDS-official/RDS-Board-Game-Core?label=Contributors&color=4ade80" alt="Contributors Count" />
  <img src="https://img.shields.io/badge/Total%20Commits-140%2B-blue" alt="Total Commits" />
</p>

数据源自 Git 提交审计与 GitHub 贡献记录：

| 贡献者 (GitHub ID) | 提交次数 (Commits) | 贡献占比 | 代码增删行数 (Lines Changed) | 
| :--- | :---: | :---: | :---: |
| **[@Xhopo-hk](https://github.com/Xhopo-hk)** | **72 次** | 57.1% | +14,113 / -1,890 |
| **[@QSanSi](https://github.com/QSanSi)** | **30 次** | 23.8% | +5,146 / -1,108 |
| **[@1368129224](https://github.com/1368129224)** | **24 次** | 19.0% | +4,322 / -205 |

### 11.3 仓库规模概览 (Repository Overview)

- **总提交次数**：140+ 次提交
- **工程结构**：Monorepo 多包架构（`packages/kernel` 核心内核、`packages/games` 六款游戏夹具、`packages/app` 应用状态桥接、`packages/net` 联机信令、`apps/web` Three.js 3D 渲染与 Web 调试器、`apps/server` 独立服务大厅）
- **语言与规范**：100% 严格类型 TypeScript + ESM 模块规范，无外部框架依赖的纯函数内核与严格状态隔离
- **实时图表**：可前往 [GitHub 官方贡献图表页面](https://github.com/RDS-official/RDS-Board-Game-Core/graphs/contributors) 查看更多维度的代码增删行数与周期统计。


