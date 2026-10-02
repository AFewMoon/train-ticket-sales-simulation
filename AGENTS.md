# AGENTS.md — 项目说明与经验教训

《火车票销售模拟》：纯前端单页应用（**TypeScript + Vite（IIFE 单文件产物）** + IndexedDB 持久化（v3.2 起，内存镜像 + 后台防抖落盘，localStorage 为降级/迁移来源）），双击 `index.html` 或任意静态服务即可运行；**重度计算（出票/补录/退票/批量仿真/对账）运行于 Web Worker，失效自动降级主线程直算**；核心算法由 Vitest 单测覆盖。

## 项目结构

```
index.html                     # 单页入口，七个标签面板（引用 dist/train-ticket-sales.js）
css/style.css                  # 主题变量、卡片、座位图、toast、响应式
src/main.ts                    # 启动链：IndexedDB 镜像就绪 → 容器/UI 注入 → 种子化 → 对账 → 号码池重建
src/container.ts               # 组合根：依赖装配，方向严格单向
src/domain/model/              # OrderStatus/EventType/SimType 枚举、SeatSegment/StationNo
                               #   值对象、Order 实体类（状态迁移收口）
src/domain/engine/             # 纯函数计算引擎（快照进/补丁出）：ticketing/simulation/
                               #   protocol（快照/补丁/Worker 消息契约）/dispatch（RPC 调度）
src/domain/repository.ts       # IRepository<T> 存储契约（domain 定义，infra 实现）
src/domain/services/           # Station/Line/Train/Numbering/Ticketing 领域服务（持久化收口）+ 对账
src/infrastructure/            # 强类型 KeyRegistry、泛型 LocalStorageRepository<T>、
                               #   IdbMirrorStorage 内存镜像（IndexedDB 防抖落盘）、BatchScope 批量事务缓冲、
                               #   OrderRepository 实体映射
src/workers/engine.worker.ts   # 计算引擎 Worker 入口（?worker&inline 内联 blob，IIFE 自包含）
src/application/               # SimulationService 仿真、BookingAppService 用例编排、
                               #   ComputeGateway（Worker/直算双路径 + 失效自动降级）、
                               #   EngineTransport（快照构建/补丁落盘）、BuiltinSeeder、view-models
src/ui/                        # 视图层：渲染、下拉联动、事件绑定（只消费 ViewModel，await 网关结果）
tests/                         # Vitest 单测（45 用例，内存存储隔离容器；FakeWorker 回环验证 Worker 路径）
dist/                          # 构建产物（入库，保证克隆后双击可用）
```

分层约定与依赖方向：`ui → application → domain ← infrastructure`（依赖倒置）；`ui` 只操作 DOM 与事件、只消费应用层 ViewModel、await 网关结果后渲染；业务规则全部在 `domain/engine`（纯算法）与 `domain/services`（持久化收口）；持久化只经 `infrastructure` 的泛型仓库。计算路径：`ComputeGateway` 接口的两个实现——`WorkerComputeGateway`（postMessage 快照 → Worker 引擎 → 补丁 → 落盘）与 `DirectComputeGateway`（主线程直算同一引擎）；Worker 构造失败或运行失效（onerror/postMessage 异常）自动降级直算，两条路径由同一套等价测试覆盖。

构建与验证：`npm run build`（tsc strict + Vite 产物，Worker 以 `?worker&inline` 内联为 blob，保持单文件自包含与 file:// 可直开）、`npm test`（Vitest）。CI（deploy.yml）在发布前先跑构建与单测。

## Web Worker 计算架构（v3.0）

- **纯函数引擎**（`domain/engine`）：算法核心为「快照进（纯 DTO）→ 补丁出（orders 按 id upsert + 队列按策略合并 + 新增事件）」，无仓库/DOM 依赖，Worker 与主线程共用同一实现——这是双路径行为等价与可测试性的根基。
- **消息协议**：`EngineRequest/EngineResponse` 封包；单次购票/退票只传该车次快照（train + 该车次订单 + 该车次队列），批量运算（退票模拟/对账/仿真）传全量快照，降低结构化克隆开销。
- **补丁策略**：`replace-codes`（购票/退票，按 code 整段替换）、`replace-all`（对账，整体重建文件对象以丢弃 legacy 残留键）、`merge-append`（预留，按 createdAt 归并）。仿真补丁还包含「既有候补被兑现」的订单变更（按 id upsert），否则丢失状态更新。
- **主线程职责**：EngineTransport 构建快照、应用补丁、登记仿真车次到号码池；轻量查询（容量/候补名次/座位图/查询区）保持同步直读，渲染不异步化。
- **SharedArrayBuffer 被否决的原因**：GitHub Pages 无法设置 COOP/COEP 响应头、file:// 直开无响应头，且 Worker 内无 localStorage，SAB 无法解决持久化共享。
- **可观测标记**：`globalThis.__ttsCompute` 为 `'worker'`（网关升级成功）或 `'direct'`（默认/降级）；`globalThis.__ttsStorage` 为 `'idb'`（IndexedDB 镜像生效）、`'local'`（降级 localStorage）或 `'memory'`（降级内存）；`globalThis.__ttsVersion` 为应用版本号（package.json 单来源，vite/vitest define 构建期注入 `__APP_VERSION__`，组合根 `markVersion()` 登记），供浏览器回归断言与用户问题排查。

## IndexedDB 存储架构（v3.2）

- **内存镜像 + 后台落盘**：`IRepository`/`StorageLike` 同步契约不变（domain/application/ui 零改动，与「轻量查询同步直读」决策一致）。`IdbMirrorStorage` 启动时一次性 `getAll` 预热内存 Map，此后读写同步 O(1)；写操作登记脏键，**500ms 防抖合并**（同键去重保留末值）落盘 IndexedDB，`visibilitychange(hidden)`/`pagehide` 兜底 flush，落盘失败回滚脏键稍后自动重试。
- **异步引导时序**：存储预热是异步的，`main.ts` 须先 `await createBrowserStorageAsync()` → `initDefaultContainer(storage)`，再**动态 `import('./ui/ui')`**——`ui.ts` 模块顶层即取容器（全 src 唯一顶层副作用），静态 import 会在镜像就绪前触发容器创建。
- **一次性迁移**：IndexedDB 为空且 localStorage 存在 `tts:*` 键时整体搬运（跳过已退役键），落盘成功后清除旧键；镜像非空则跳过，幂等可重入。
- **降级链**：IndexedDB 不可用（隐私模式/打开被阻塞/预热异常）→ localStorage → 内存，行为与 v3.1 前一致；IndexedDB 交互收敛在 `IdbLike` 最小接口后，node 单测注入内存假实现，无需 fake-indexeddb 依赖。
- **已知局限（本期留档）**：镜像载入后不感知其他标签页写入，多开页面后写者以自身镜像覆盖（旧 localStorage 为读时直读、天然跨页共享）。如需恢复跨页语义，可引入 BroadcastChannel 通知他页重载镜像。

## 核心业务规则

- **出票规则（逐单区间适配）**：候补订单按 createdAt 升序逐单尝试补录，任一座位的目标区间 `[fromIdx, toIdx)`（左闭右开，区间端点为车次站序下标）完全空闲即出票到该座位；允许座位存在空洞，最大化利用率。
- **退票语义（v2.0 起）**：退票/取消候补**不再删除订单**——状态置 `OrderStatus.CANCELLED` 并保留 seatNo 留档；一切占用统计（差分/前缀和、容量摘要、座位图、按段查询、候补适配）只认 `status === ISSUED`；重复退票幂等拒绝。
- **占用统计**：座位分段占用用差分数组 + 前缀和计算，只遍历「已占用座位集合」（与座位数上限解耦），同时服务于剩余运力摘要与座位图渲染定位。
- **批量事务**：仿真批次内 orders/queues/events 走内存缓存（BatchScope），结束时一次性落盘。

## 经验教训

### 1. 出票算法：先找等价模型，再写枚举

最初计划的「子集回溯搜索」复杂度是 O(2^W)。意识到「首尾相接恰好覆盖全程」本质上是 DAG 路径存在性问题后，改为 BFS + `prevOrder` 前驱还原，代码更短、更快、天然无重叠。教训：**遇到"拼接/覆盖/组合"类需求，先尝试转化为图论模型，往往有线性或近线性解法。**

### 2. 本机端口可能被无关进程占用，启动服务前要验证归属

验证时 `http.server` 绑定 8765 端口看似成功，实际端口被「百度输入法」进程（`BaiduPinyin.exe`）占用，Python 静默失败，`curl` 请求挂起无响应。通过 `Get-NetTCPConnection -LocalPort <port>` 查到真实占用进程后换用 8931 端口立即解决。教训：**服务"监听中"不代表"是你的进程"；端口探活必须核对 PID 对应的进程名。另：`Start-Process -WindowStyle Hidden` 会让启动失败完全静默，调试期应保留输出。**

### 3. 本地回环请求也可能被代理干扰

`Invoke-WebRequest http://127.0.0.1:...` 报「连接被意外关闭」，实际是系统代理拦截了回环请求。用 `curl.exe --noproxy "*"` 绕过即可。教训：**Windows 上排除代理问题时，优先用 `curl --noproxy` 定位是网络问题还是服务问题，而不是先怀疑代码。若确需临时设置代理环境变量，验证完必须清理（`$env:HTTP_PROXY` 等），避免污染后续请求。**

### 4. 环境假设必须逐一实测

计划假设「Anaconda Python」，但机器上 `anaconda3` / `miniconda3` / `ProgramData` 均不存在，最终用 `C:\Python314\python.exe`。同理，playwright-cli 默认找 Chrome（不存在），改用 `--browser=msedge`（Windows 一定有 Edge）。教训：**对任何"应该装了"的运行时，先探测再使用；给出回退路径（系统 Python → msedge）能避免验证流程卡死。**

### 5. UI 与算法分层使验证和修错成本大幅降低

本次发现并修复的唯一 bug（`renderToOptions` 中变量先使用后赋值，`var` 提升导致 `undefined`）位于视图层一处小函数。因为业务算法全部在无 DOM 的独立模块里，通过 `page.evaluate` 直接读 localStorage 断言订单状态即可端到端验证算法正确性，不受渲染干扰。教训：**`var` 在循环体内先引用后声明是典型陷阱，统一用 `let/const` 可从根上消除；领域层与视图层分离让"localStorage 即测试断言源"成为可能。**

### 6. 同毫秒创建的订单需要稳定排序

候补队列按 `createdAt` 排序，快速连续提交时时间戳可能相同，导致名次不稳定。实现中在 `createdAt` 上叠加了微小的确定性偏移。教训：**任何"按时间排队"的数据结构，测试时都要考虑同时间戳的并发写入。**

### 7. 数据校验放在领域层，且删除要有引用检查

车站被车次引用则禁删、乘车人有订单则禁删、身份证做校验位验证而不只是正则——这些规则全部收敛在 `domain.js`，UI 层只展示返回的 `msg`。教训：**校验规则与 UI 分离后，规则天然可复用、可单测，也不会因换一套界面而丢失。**

### 8. 批量生成的实体要"落地时"打标记，回收才不会漏

「清理仿真数据」首测漏删了全部 80 个订单：车次、乘车人、线路都在生成时写了 `sim: true`，唯独订单是经 `Ticketing.purchase` 创建的，没有任何一处给它打标记——单测每个实体类型都"看起来有标记"，整合后清理却静默不完整。教训：**数据带生命周期标记时，要在创建路径的收口处统一补标记（并配一条"清理后计数归零"的端到端断言）；对经过中间层创建的实体尤其如此。**

### 9. 站点资源可跨线路共享，种子数据要按名称去重

内置「四纵四横」种子化时，多个线路共享真实车站（上海虹桥、南京南、郑州东等）。按"车站名称 → 号码"映射去重后，72 座车站支撑 8 条线路，且大/小站标记以车站本体为准，避免同一车站出现两套身份。教训：**种子化基础数据前先设计好去重键；去重键冲突处理不当会在删除/引用检查时产生级联异常。**

### 10. Set.has 的类型陷阱：号码"唯一性"从未生效过

`randomPick(1000, usedSet)` 中 `takenSet.has(i)` 用**数字**查询，而站号池里存的是 **pad3 字符串**（'103'）——严格相等下永远 miss，唯一性检查形同虚设，号码分配退化为纯随机。72 站时碰撞概率低侥幸未暴露；一次种子化 200+ 站立即产生十余组重复号，连锁导致"线路站序重复"校验拒绝建线。教训：**集合成员判断必须确认元素类型一致；"看似在排除"的过滤逻辑要用数据验证（构造大数据量压测），小样本通过 ≠ 正确。**

### 11. 种子数据要幂等自愈，跳过不如复用

版本化种子（SEED_VERSION）迁移旧脏数据时，`addStation` 遇"重名已存在"直接 return 跳过，导致个别站从线路站序中静默缺失。改为重名时**复用既有同名车站**后自愈。教训：**upsert 逻辑中"创建失败"要区分"该复用"与"真失败"；种子函数必须能在任意中间状态下重入收敛。**

### 12. "缺一站"可能不是缺站，而是校对口径错误

排查"沪昆线 53/54"耗时一轮，最终发现站表本身就是 53 站（此前误记 54）。教训：**报告数量异常前先与源头清单精确比对（用脚本 diff，而不是心算），避免追不存在的问题。**

### 13. 测试期 raw 写入与应用内定时器并发，会制造"假 bug"

验证在线引擎时，测试脚本用 raw `localStorage.write` 注入订单，而页面内 5 秒自动扫描定时器同时在读-改-写同一 key，双方互相覆盖产生"兑现了冲突组合"等无法解释的现场。受控实验（同一同步代码块内完成全部步骤）复测后引擎行为完全正确。教训：**对带有定时器/异步副作用的页面做数据级测试时，先停用定时器或把全部操作收敛到单次同步块；出现"不可能"的中间态先怀疑测试自身的并发，其次才是被测代码。**

### 14. "退票释放座位 → 候补填补"受全程覆盖规则强约束

出票规则要求候补组**恰好覆盖全程**，因此部分退票后空洞几乎不可能被单张候补填补（单张不覆盖全程）；只有当候补中存在（或可拼出）完整全程组合且目标座位完全空闲时才会兑现。测试场景必须按此规则设计，把"规则性不兑现"误判为 bug 会浪费大量排查时间。

### 15. 规则级重构前，先把"新规则能解释旧现象"想清楚

出票规则从「拼全程组」改为「逐单区间适配」时，大量旧验证结论（如"部分退票后空洞几乎无法填补"）随之失效——新规则下退票后空洞几乎总能被适配的候补立即填补。教训：**规则变更类重构，先重写预期行为清单再跑验证；用旧规则推导的"必然现象"去质疑新代码，只会浪费时间。**

### 16. 持久化结构变更要兼容旧数据

队列结构从 `{ buckets: [...] }`（按 fromIdx 分桶）改为单条有序列表时，`scanAllTrains` 对账先识别旧结构（存在 buckets 字段）整体废弃重建，避免对旧格式做错误遍历。教训：**localStorage 没有迁移框架，结构变更必须在对账入口做显式版本/形状探测。**

### 17. 格式化函数与比较格式必须同源

`randomPick` 第一次修复用 `String(i)` 做排除查询，但站号是 `pad3(i)`（'005' ≠ '5'）——000~099 号段永远排除不掉，且小样本（72 站）恰好不暴露，274 站立刻重现重复号。同一缺陷两次现形，只是换了类型陷阱的外衣。教训：**修复"比较格式不一致"类 bug 时，把两端的格式化来源统一收敛到同一个函数（如都用 pad3），并补一条"全量分配后零重复"的压力断言，而不是只修当下报错的那一类值。**

### 18. 优先级冲突的规则要显式声明让位关系

「隔站停车隔 1~3 站」与「途经大站必停」相遇时，大站可能紧邻上一停靠点（间隔 0）。实现上让"大站必停"优先于随机间隔，测试断言也应按"非大站间隔 1~3、大站无条件停"分别校验，而不是一条"所有间隔都在 1~3"的粗断言。后续规则再次收紧为按**中途停靠站数**约束（大站快车中途 ≥1 站、隔站停车中途 ≥3 站），"间隔"一词在需求里既可指相邻停靠跨度也可指中途停靠数，落实前必须先与需求方对齐语义。

### 19. 部署自动化遵循"仅 master 动作"约束

Pages 部署采用官方 `actions/deploy-pages` 链路直接从 master 发布，工作流不创建/推送任何部署分支——这满足了"只在 master 上动作"的要求，也消除了双分支双通道的混淆。代价是需要一次性的 Settings → Pages → Source 切换为 GitHub Actions。教训：**自动化方案选型要服从既有约束（此处为用户明确的分支边界），宁可多做一步一次性手工设置，也不引入违背约束的隐藏分支操作。**

### 20. 上限解锁前，先清点"按上限线性扫描"的代码

座位数解锁至 INT_MAX 后立即暴露两处按 1..N 枚举座位的代码：座位分配 O(seatCount × S) 直接卡死、座位图渲染尝试生成 10 万行 DOM。修复方式是把循环对象换成「已占用座位集合」（来自实际订单的 seatNo 去重）——复杂度只与真实数据量相关。教训：**放开一个常量上限前，全局搜索所有以该上限为循环边界的代码；"数据量可能为 0"的维度（空座位）绝不能进入枚举。**

### 21. 实体退役要做全量引用清扫，包括生成器与文案

移除「乘车人」时，除了 CRUD 与 UI 面板，还牵连仿真身份证生成器、事件/提示文案、查询表列等十余处散点。教训：**删除实体前用 `grep 全大小写变体 + 中英文名称` 列出完整引用清单再动手；文案里的人称（"乘客/乘车人"）也算引用，遗漏会让界面说出不存在的概念。**

### 22. 渲染兜底要覆盖"关联实体缺失"与"下标越界"两类来源

`undefined` 文案来自两处：车次被删后 `st[o.fromIdx]` 为 undefined、station lookup 返回 null 后三元取 else 分支直接输出 undefined 值。统一用 `safe` 兜底函数（缺失显示「未知站/未知车次」）。教训：**渲染侧凡 `arr[idx]` 与 `getXxx().field` 组合处必须两级兜底；宁可显示占位符，也不把 JS 的 undefined 拼进 HTML。**

### 23. 下拉的"上一次选中值"恢复必须绑定实体身份

用户报告仿真后「购票」「订单与座位」面板出现 undefined/范围溢出类错误数据。实测多路径未能复现，但排查发现下拉恢复逻辑只按**数值边界**恢复 prev 下标（如 `Number(prevFrom) < stationSeq.length`），不校验车次是否还是原来那个——车次一旦更换，同数值下标指向不同车站，属于语义错位隐患；另有事件时间线对未知事件类型直接输出 `ev.type`（undefined 数据会拼进 HTML）。修复：prev 恢复前先比对车次 code 未变、未知事件类型显示占位文案、座位号输出补空值守卫。教训：**select 重建后恢复旧选中值时，要同时校验"数值仍合法"与"实体未变"两个条件；无法复现的用户报告也要顺着症状清单做防御性加固，并把候选病因逐一排除留档。**

### 24. 共享的 fallback 默认值是跨实例的可变状态陷阱

TS 化时把每个 localStorage key 的 fallback（如 `[]`、`{trains:{}}`）定义为注册表常量，`LocalStorageRepository.read` 无数据时直接 `return fallback`——所有仓库/所有测试容器共享**同一个数组实例**，第一次 push 后默认值被永久污染，跨容器「记忆」数据导致 25 个单测集体报「车站中文名已存在」。修复：read 返回 fallback 的浅拷贝（数组 slice / 对象展开）。教训：**注册表中的对象/数组默认值本质是共享可变状态；"返回默认值"的地方必须返回副本，或改用工厂函数 `() => T`。共享单例容器 + 每用例新建容器是排查此类问题的放大器——单测第一个失败别急着改业务代码，先看失败信息是否跨用例串味。**

### 25. 迁移时"等价改写"要警惕区间端点这类隐含语义

TS 化出票引擎时，测试里把 4 站车次的"全程购票"写成 `purchase(code, 0, 4)`——区间是**左闭右开的站序下标**，全程实为 `[0, 3)`，`toIdx=4` 被合法地以「区间超出车次站序」拒绝。旧 JS 代码行为完全正确，错的是测试对语义的想当然。教训：**重构算法层时，先从旧实现中提炼"魔法数字的语义"（下标 or 计数、闭开区间、含端点否）写成类型注释（如 SeatSegment 的 JSDoc），再写测试；测试失败时先区分"被测代码错了"还是"测试构造错了"。**

### 26. 逐行等价迁移 + 行为快照先行，是遗留代码 TS 化的安全网

本次将 7 个 IIFE 全局模块迁移为 TS 分层（约 2000 行）零行为回归，依赖三个顺序：先补齐 Vitest 行为用例（含旧数据迁移/幂等对账等"隐藏规约"）再动手；迁移中逐函数对照旧实现（保留算法注释与教训编号）；迁移后用固定种子做同种子复现断言 + msedge 浏览器全流程回归。教训：**无测试的遗留代码先写测试再重构是老生常谈，但关键增量是"把历史教训（#6/#10/#16/#20/#23）逐一转化为断言"——教训清单本身就是隐藏需求规格。**

### 27. 「先提取纯函数引擎，再上 Worker」是异步化的安全顺序

把同步算法直接改造成 Worker RPC 很容易把持久化读写与计算搅在一起、产生两套行为。本次先在主线程内把算法提取为「快照进/补丁出」的纯函数（Service 变薄包装，原 37 个单测不改断言全部通过），然后 Worker 只是给同一引擎换了个运行位置——回环测试（FakeWorker 走完整 RPC → 补丁落盘 → 与直算对比）得以在 node 环境覆盖 Worker 代码路径。教训：**Worker 化的本质约束是"计算必须与 I/O 分离"；先做纯函数化提取并用等价测试锁定行为，再把纯函数搬进 Worker，每一步都可验证。**

### 28. 补丁协议要覆盖"既有数据被计算波及"的变更，而非只传新增数据

仿真批次的补录会兑现快照中**既有的**候补订单并使其队列条目出队——最初补丁只含新增订单与新增候补条目，落盘后既有订单的状态更新与队列删除全部丢失（仅靠下次对账自愈掩盖）。修复：补丁按「受影响实体全量 upsert（按 id）+ 受影响队列整段替换」表达，仿真还回传号码池登记。教训：**设计快照/补丁协议时，穷举引擎会触碰哪些既有数据（不只是新增），补丁粒度要么"按 id upsert"要么"受影响集合整段替换"，绝不做"只传增量"的隐式假设。**

### 29. `?worker&inline` + 动态 import，让 Worker 进 IIFE 单文件且不污染测试环境

Vite 的 `?worker&inline` 可把 Worker 内联为 base64 blob（`worker.format: 'iife'`），IIFE 主产物保持 file:// 可直开；但顶层静态 import 会让 node 环境的 Vitest 在加载容器时就触碰 Worker 模块。改为在 `attachWorkerCompute`（仅 main.ts 调用）里动态 import + 构造探测（probe.terminate()），失败静默保持直算网关——测试环境天然走直算路径，浏览器入口才升级 Worker。教训：**平台相关模块（Worker/localStorage/IntersectionObserver…）用"动态 import + 运行时探测 + 可降级默认实现"三件套隔离，组合根只持有可替换的抽象。**

### 30. 补丁落盘函数的"统一收尾写回"会覆盖分支内的整体替换

`applyPatchToStore` 在开头 `const q = store.getQueues()`、各分支修改 `q`、末尾无条件 `saveQueues(q)`——`replace-all` 分支先保存了重建的新文件对象，末尾又把**旧对象**整体写了回去，legacy 残留键与悬空条目因此"复活"（且仅在 legacy 测试与悬空测试中同时现形）。修复：replace-all 分支直接 return，其余分支共享局部可变对象。教训：**「先取值、分支修改、统一写回」的函数里，任何"整体替换"分支都必须提前返回或改写同一引用；这类 bug 会被"对账自愈"机制掩盖成偶发问题，测试要对新旧两代持久化形状分别断言。**

### 31. 同步契约下的异步存储：把异步性吸收在"预热 + 镜像"里，而不是传播异步

localStorage→IndexedDB 升级面对的根本矛盾是 IndexedDB 天然异步而全链路同步直读。方案不是把 `IRepository` 改成 Promise（那会波及全部领域服务与 UI），而是让存储实现自己吸收异步性：启动时 await 全量预热内存镜像，此后同步 API 不变，写操作防抖合并后台落盘。配套两个关键点：① 迁移必须幂等（镜像非空即跳过，防重入覆盖新数据）；② 依赖模块顶层副作用的模块（ui.ts）必须改为显式注入。教训：**引入异步依赖时优先寻找"在边界处一次性消化异步"的结构（预热/快照/镜像），而不是让 async 沿调用链扩散；判据是"谁能等待"——只有启动序列能等待，运行时的每一次读写都不能。**

### 32. 单文件 IIFE 里动态 import 不会推迟模块求值——顶层副作用必须显式注入

为等 IndexedDB 镜像预热，曾把 `import('./ui/ui')` 改成动态 import 以"推迟" ui.ts 顶层 `getContainer()`。结果页面出现两个容器：Rollup 单 chunk（`inlineDynamicImports`）会把动态 import 的模块提升进主包并**随 bundle 求值立即执行其顶层副作用**——`getContainer()` 在镜像就绪前创建了 localStorage 回退容器，UI 的全部读写（含仿真数据）静默分流到 localStorage，IDB 侧只有启动链写入。靠「劫持 `Storage.prototype.setItem` 捕获调用栈 + `createContainer` 临时日志对比两次创建的 storage 类型」定位。修复：ui.ts 改为 `initUi(container)` 延迟注入，main.ts 恢复静态 import。教训：**「动态 import 会推迟模块求值」只在多 chunk（code splitting）下成立；单文件 bundle 中所有模块顶层代码都在脚本加载时执行。模块顶层永远不要取环境相关单例（容器/存储/Worker），一律显式注入。排查"数据被写去别处"类问题，先验证'是否存在第二实例'，劫持原型方法抓调用栈是最快手段。**

## 验证清单（回归测试用）

> 1~13、15~17 项已有 Vitest 自动化覆盖（tests/*.spec.ts，59 用例；其中 Worker 路径经 FakeWorker 回环验证，IndexedDB 镜像经 IdbLike 假实现验证），浏览器端仅做冒烟与渲染回归。

1. 登记车站 → 号码唯一且随机；重复中文名被拒。（domain.spec：含 600 站号码唯一压测）
2. 登记车次 → 站序 < 2 站或重复被拒；自定义车次号格式（**仅 G/D 字头** + 4 位数字，首位 1~3/6~8、末位奇数）非法或重复被拒，留空随机生成（G/D 等概率）；**启动时自动清理非 G/D 字头的存量车次（连带订单含取消历史与候补队列条目）**。（domain.spec）
3. 挂接线路：乱序站序被拒，正序子序列通过；挂线后途经站候选随路线成形单调收缩；删除被挂接线路被拒。（domain.spec）
4. 购票：区间适配无空闲座位 → 候补；退票释放区间 → 候补按时间戳自动补录；**退票/取消保留订单为 CANCELLED 且不参与占用统计，重复退票被拒**。（ticketing.spec）
5. 刷新页面 → 数据持久化；座位图展示票段分布（空洞为未售区间）。
6. 删除被引用车站 → 被拒。
7. 首次运行 → 自动种子化「四纵四横」8 条线路完整站表（京沪 24 / 京广深港 42 / 京哈 29 / 杭深 54 / 青太 24 / 徐兰 29 / 沪汉蓉 31 / 沪昆 53，去重后共 276 站，站号唯一、跨线共享去重），版本不匹配时自动迁移重建。（seeder.spec）
8. 全站无乘车人/身份证概念（订单为匿名票段）；任何渲染处不出现 undefined/NaN 文案（含车次被删后的兜底）。
9. 自动仿真：同种子结果可复现（批量事务内零逐条落盘，结束一次性 flush）；三类车次——直达车（仅两大站之间、G）/ 大站快车（大站子区间、不一定线路首末、起终点之间至少停靠 1 站、G）/ 隔站停车（起终点随机、起终点之间至少停靠 3 站、以隔 1~3 站推进、途经大站必停、终点必停、D）；仿真结果含「运算时间」统计卡片与耗时 toast；「清理仿真数据」后 sim 实体计数归零、手动数据与内置线路保留。（simulation.spec）
10. 大数据：座位数 100000 × 数百订单不卡死（座位分配/容量/座位图只遍历已占用座位）；事件时间线（tts:events，上限 500）刷新后可见、最新置顶，卡片位于「购票下单」正下方。
11. 数据查询区：选车次查看全部订单；选车次+相邻段查看该段已出票订单与座位。
12. 退票模拟：购票页比率输入（默认 5%）+「退票模拟」按钮（位于比率右侧），随机退票并自动按时间戳补录（业务已下沉 BookingAppService.refundSimulation）。
13. 座位图：站数 × 72px 计算内轨最小宽度，容器 overflow-x 滑动；仅渲染已占用座位。
14. 首页初始即「自动仿真」标签（HTML 初始状态 + JS 双保险）。
15. 部署：push master → Actions 先 `npm run build && npm test` 再经官方 Pages 链路发布 dist（deploy-pages），远端无 gh-pages 等部署分支。
16. 旧数据兼容：legacy 队列 `{buckets}` 结构对账废弃重建；旧 `'waiting'/'issued'` 状态字符串直读兼容；退票后落盘 `'cancelled'`。（migration.spec）
17. 计算架构：`__ttsCompute === 'worker'`（Worker 生效）；同种子仿真经 Worker 与直算统计一致；Worker postMessage 失效自动降级直算且结果正确；补丁三策略（replace-codes/replace-all/merge-append）合并正确。（engine.spec）
18. 退役字头（v3.1）：车次号仅 G/D；注入 K 字头存量（含订单与队列）后启动即被 purgeNonGDTrains 清除，号码池重建后 K 号不复用；随机生成的车次号全部匹配 /^[GD]/。（domain.spec）
19. 存储架构（v3.2）：`__ttsStorage === 'idb'`（IndexedDB 镜像生效）；数据写入后刷新页面可恢复（IndexedDB 持久化）；localStorage 旧 `tts:*` 数据启动时一次性迁移进 IndexedDB 并清除旧键（镜像非空时跳过，幂等）；防抖窗口内同键多次写合并为一次落盘、落盘失败回滚重试；IndexedDB 不可用回退 localStorage/内存。（idb-mirror.spec + 浏览器冒烟）
20. 版本标记（v3.2）：`__ttsVersion` 与 package.json 版本一致且为语义化版本；页脚展示 `v<版本号>`；`tts:appVersion` 记录最后写入数据的应用版本（仅变更时写入）；CI 断言 dist 产物内嵌正确版本号。（version.spec + deploy.yml）
21. 仿真链接复现：仿真 8 项参数编码进 URL hash（`#sim=line=<线路名|__auto__>&auto&gd&ge&gs&seats&req&seed`）——线路按**名称**编码（id 由 uid() 生成跨机器不稳定）；「复制复现链接」按钮一键复制；运行成功后 hash 自动更新为实际种子（-1 随机种子运行后写入 usedSeed）；打开带参链接自动回填表单但不自动运行；线路不存在时保留当前选择并 toast 提示（降级不静默）；seed 非整数/越界整段拒绝；复现口径为统计结果与订单分布（车次号 Math.random 生成、不参与复现）。（sim-link.spec + 浏览器冒烟）

## 运行

开发：`npm install` 后 `npm run build`（类型检查 + 产出 dist/）或 `npm run watch`；单测 `npm test`。
使用：双击 `index.html`，或 `python -m http.server <port>` 后访问。运行时无外部依赖（dist 为 IIFE 单文件）。
