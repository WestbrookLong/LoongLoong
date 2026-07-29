# Pet 当前记忆系统设计与实现

> 文档状态：对应当前 `main` 工作树，覆盖基础记忆、上下文压缩、连续性状态、Claim 治理与增强检索 P0-P6。
>
> 事实来源：若本文与代码不一致，以 `electron/database.cjs` 的 Schema、各模块导出函数及测试为准。

## 1. 系统目标与边界

Pet 的记忆系统不是单一向量库，也不是把历史聊天全文塞回 Prompt。它需要同时解决四类问题：

1. 保存可追溯的原始经历；
2. 用 LLM 从经历中提取、压缩有价值的信息；
3. 用确定性代码维护状态、时间线、冲突和证据约束；
4. 在有限 Prompt 预算内，检索对当前回复真正有帮助的内容。

当前实现遵守以下原则：

- **原始记录与解释分离**：`messages`、`events` 保存发生过什么，Claim、Topic 和 State 保存系统如何理解它。
- **LLM 提议，代码裁决**：LLM 负责语义判断和结构化提案，确定性 reducer 负责校验与写库。
- **记忆必须可追溯**：长期 Claim、Topic Item、Open Loop 和状态修订都应能回到消息或事件证据。
- **认识论信息进入 Prompt**：回复模型能区分用户明确表达、工具验证、Agent 观察、共同确认和推测。
- **时间状态与事实状态分离**：过去正确的事实不会因为失效而被删除，它会进入历史时间线。
- **先过滤，再排序**：禁止暴露、过期、被替代或非当前查询所需的历史记录不能靠低分“软过滤”。
- **所有智能路径可降级**：Embedding、Reranker 或记忆 LLM 失败时，聊天仍可回退到确定性路径。

## 2. 总体架构

```text
用户输入（文字/语音）
        |
        v
消息与离线事件捕获
        |
        +-----------------------------+
        |                             |
        v                             v
上下文窗口管理                   LLM 记忆提取
快照 + 保留消息尾部              Event / Claim / Topic / State proposal
        |                             |
        |                             v
        |                       确定性校验与 Reducer
        |                       证据 / 幂等 / 冲突 / 时间线
        |                             |
        +--------------+--------------+
                       v
               SQLite 持久化记忆
                       |
          +------------+-------------+
          |            |             |
          v            v             v
       词法召回      语义召回      结构评分
          +------------+-------------+
                       v
                 加权 RRF 融合
                       |
                  条件 LLM Rerank
                       |
                去重、多样性与预算打包
                       |
          Memory + Continuity + State Prompt
                       |
                       v
                    回复模型
```

系统可以从数据职责上分为六层：

| 层 | 主要对象 | 作用 |
| --- | --- | --- |
| 原始交互层 | `sessions`, `messages` | 保存会话和原始对话 |
| 事件证据层 | `journal_days`, `events`, `event_sources` | 保存按日组织、可追溯的经历 |
| 事实层 | `claim_slots`, `memory_claims`, `memory_evidence` | 保存用户事实、偏好、约束及其时间线 |
| 连续性层 | Topic、Topic Item、Open Loop | 保存正在讨论什么、形成了什么决定、还欠什么 |
| 行为状态层 | Self Model、Relationship State | 约束 Agent 如何行动和与用户互动 |
| 检索索引层 | Embedding、Policy、Retrieval Log | 提供语义索引、可见性治理和召回审计 |

## 3. 单轮聊天执行路径

当前一轮文字聊天的核心顺序是：

1. 将用户输入写入 `messages`，并执行确定性离线捕获；
2. 分析 Query，生成一次共享的 Query Embedding；
3. 使用词法和语义信号进行 Topic 路由，解析当前 canonical Topic；
4. 构建 Continuity Context 和 Self/Relationship State Context；
5. 估算上下文占用，必要时压缩旧消息并生成 `context_snapshot`；
6. 执行基础检索；满足条件时执行语义召回、混合融合和条件 Reranker；
7. 在预算内打包 Prompt，调用聊天模型；
8. 保存助手回复；
9. 达到批次阈值或显式触发时，异步执行 LLM 记忆提取和状态更新；
10. 后台处理 Embedding Job，并在启用时发现 Claim 语义邻居候选。

语音模式有意采用更保守的路径：

- 不生成远程 Query Embedding；
- 不执行 LLM Reranker；
- 使用更小的 Memory、Continuity 和 State 预算；
- 优先保证实时性，并继续使用确定性检索作为基础。

## 4. LLM 与确定性代码的职责

### 4.1 LLM 负责

- 从消息中提取语义事件；
- 提出 Claim、Topic Item、Open Loop 和状态更新；
- 判断新 Claim 与候选旧 Claim 是同值、共存、更新、冲突还是无关；
- 在上下文接近上限时生成连续性摘要；
- 执行每日记忆巩固；
- 在条件满足时对候选记忆进行受约束 Rerank；
- 对高相似 Claim 邻居、Topic 合并候选作有证据约束的语义裁决。

### 4.2 确定性代码负责

- 校验证据引用和原文引用；
- 拒绝模型未见过的 ID、越权操作和非法枚举值；
- 计算哈希、幂等键、版本号和 Run 状态；
- 维护 Claim Slot、时间范围和状态迁移；
- 执行 Topic Alias、Merge、Rebuild 和 canonical 解析；
- 执行 Self/Relationship State reducer；
- 过滤禁止暴露、历史、过期和被替代记录；
- 执行检索融合、预算裁剪和降级；
- 保存完整审计日志。

核心边界是：**LLM 可以表达“我认为两条记忆是更新关系”，但不能直接把旧记录改成 superseded。**

## 5. 事件与记忆提取

### 5.1 两条捕获路径

系统同时保留两条路径：

**确定性离线捕获**

- 每条用户消息都会形成最低限度的事件记录；
- 不依赖模型服务，确保对话不会因为 API 故障而完全失忆；
- 适合作为证据链和恢复基础，不承担复杂语义理解。

**LLM 智能提取**

- 按 `memoryBatchSize` 批处理尚未提取的消息；
- 上下文压缩时，对被移出活跃窗口的消息再执行一次提取；
- 每日巩固前先冲刷未处理消息；
- 输出结构化 proposal，而不是直接写最终状态。

### 5.2 提取产物

LLM 可以提出以下内容：

- `events`：值得保留的发生事项；
- `claims`：用户事实、偏好、约束、目标或稳定判断；
- `claim_relations`：支持、修正、细化、冲突等关系；
- `topic_updates`：Topic、Position、Decision、Rationale、Evolution 等；
- `open_loop_updates`：承诺、问题、后续任务和解决状态；
- `state_updates`：Self Model 与克制版 Relationship State 的更新。

所有 proposal 都必须引用本轮可见消息或事件。引用文本必须真实出现在源消息中；非法引用会被丢弃。

### 5.3 认识论来源

新数据允许的主要 `epistemic_basis` 包括：

| 值 | 含义 | 回复要求 |
| --- | --- | --- |
| `stated_by_user` | 用户明确说过 | 可表述为用户曾明确表达 |
| `tool_verified` | 工具结果验证 | 可表述为工具观测到的结果 |
| `observed_by_agent` | Agent 从交互或操作中观察 | 应说明是观察，不冒充用户陈述 |
| `mutually_confirmed` | 用户与 Agent 共同确认 | 可作为已确认共识 |
| `inferred` | 模型推测 | 必须使用不确定语气 |
| `unknown_legacy` | 旧数据迁移来源未知 | 仅兼容旧记录，新提取会归一化为其他来源 |

`corrected` 不是认识论来源。纠正通过证据事件、Claim Relation 和 supersede/refine 迁移表达。

### 5.4 安全、幂等和可恢复性

- 验证码、API Key、密码等禁止持久化内容由 `containsForbiddenSecret()` 过滤；
- Event 使用 `dedupe_key` 去重；
- Topic Item 和 Open Loop 使用 `idempotency_key` 去重；
- 提取、压缩、巩固、连续性更新都有独立 Run 表；
- 应用启动时会恢复被中断的运行状态，避免永久停留在 `running`；
- Run 采用 source hash 和版本信息，防止相同输入被重复应用。

## 6. 上下文窗口与智能压缩

上下文压缩解决的是“当前会话如何继续”，长期记忆解决的是“跨会话应该记住什么”。两者会同时读取同一批源消息，但产物与用途不同。

### 6.1 容量计算

默认配置：

```text
contextWindowTokens = 32768
reservedOutputTokens = 4096
contextSoftThreshold = 0.75
contextTargetRatio = 0.45
```

系统估算以下内容的总 Token：

- System Prompt；
- Memory Context；
- Continuity Context；
- State Context；
- 已有 Context Snapshot；
- 当前保留消息。

当输入占可用容量的比例达到软阈值时触发压缩。Token 当前由启发式 `estimateTokens()` 估算，不是模型官方 tokenizer 的精确结果。

### 6.2 压缩策略

1. 至少保留最近若干条完整消息；
2. 选择更早、可被移出活跃窗口的消息作为压缩范围；
3. 在压缩前提取其中新的 Event、Claim、Topic 和 State proposal；
4. LLM 生成结构化连续性摘要；
5. 写入新的 `context_snapshots`，保存来源消息范围和连续性引用；
6. 后续请求使用“快照 + 原始消息尾部”，而不是重复发送全部历史。

快照重点保留：

- 当前目标、结论和未决问题；
- 用户约束、命名和关键参数；
- 仍需继续的任务状态；
- Topic、Open Loop 和 State 的版本引用；
- 被压缩消息的起止 ID。

### 6.3 失败回退

压缩失败不会删除消息。系统保留原始消息并记录失败 Run；下一轮仍可用旧快照和消息尾部继续工作。

## 7. 每日记忆巩固

每日巩固不是唯一压缩机制，而是跨会话的周期性整理层。

执行流程：

1. 确保当天 `journal_day` 存在；
2. 冲刷尚未经过智能提取的消息；
3. 收集当天 Event、Claim 变化、Topic 更新和 Open Loop；
4. 调用记忆模型生成每日摘要与治理 proposal；
5. 经确定性校验后更新 Claim、Topic、Open Loop 和状态；
6. 更新 `consolidation_cursor`，记录完整 `consolidation_run`。

每日巩固允许模型发现跨多轮才显现的模式，但不能绕过证据校验，也不能直接覆盖整个状态文档。失败时保留基础确定性 `consolidateDay()` 作为回退。

当前只实现**按日巩固**；周、月层级压缩尚未落地。

## 8. Claim 事实模型与冲突治理

### 8.1 Slot 与 Assertion

Claim 被拆成两层：

- `claim_slots`：事实槽位，例如“用户当前居住城市”；
- `memory_claims`：该槽位在某个时间成立的具体值，例如“北京”或“上海”。

Slot 的 canonical key 由 namespace、subject、predicate 和 scope 组成。`cardinality` 决定同一时刻是否允许多个值：

- `single`：同一时刻通常只有一个当前值；
- `multi`：多个值可以共存，例如喜欢茶和喜欢咖啡。

### 8.2 三套正交状态

一个 Claim 同时具有三种不同维度，不能混为一个枚举：

1. `epistemic_basis`：信息从哪里来；
2. `status`：当前是否 active、disputed、superseded 等；
3. `temporal_state`：current、historical、unknown 等时间状态。

此外使用 `valid_from`、`valid_to`、`asserted_at`、`temporal_basis`、`temporal_precision` 和 `temporal_confidence` 表达时间证据。

### 8.3 实时归并流程

新 Claim 到来时：

1. 根据 namespace、主体、属性和 scope 查找候选 Slot；
2. LLM 只能复用候选 Slot，或明确提出这是新事实槽位；
3. 在 Slot 内判断值关系：
   - `same`：复用 Claim，补充证据；
   - `coexist`：在多值槽位中共存；
   - `update`：有明确时间或“现在/改成/不再”等更新语义；
   - `conflict`：值不能共存但时间或证据不足；
   - `unrelated`：不执行槽位内迁移；
4. Reducer 校验证据、版本、cardinality 和时间；
5. 代码事务化更新状态并写入 transition。

### 8.4 时间线规则

对于“6 月住北京，7 月住上海”：

- 北京 Claim 保留，`temporal_state=historical`，并关闭 `valid_to`；
- 上海 Claim 成为 `active/current`，设置新的 `valid_from`；
- `claim_transitions` 记录从北京到上海的迁移及生效时间；
- 查询“现在住哪里”只召回上海；
- 查询“以前住哪里”允许同时召回历史 Claim 和时间线。

如果两个单值事实冲突且没有可靠时间顺序，Reducer 不擅自覆盖，会将相关记录设为 `disputed`。检索到 disputed Slot 时必须成组注入冲突项，避免模型只看到其中一边。

### 8.5 后台语义 Claim 治理

精确 Slot 匹配无法发现“居住地”和“现在住在哪座城市”这类语义近似键。因此当前实现增加了后台语义治理：

1. 从已就绪的 Claim Embedding 中发现高相似邻居；
2. 仅对 namespace/scope 等边界兼容的候选建档；
3. 将候选双方及其证据提交给受约束 LLM；
4. LLM 输出关系和置信度；
5. `applyClaimNeighborAdjudication()` 再验证版本、证据和关系白名单；
6. 只有通过确定性校验的结果才会改变状态。

候选、裁决和证据分别保存在 `claim_neighbor_candidates` 与 `claim_neighbor_evidence` 中，可在开发面板审计。

## 9. Topic、Open Loop 与连续性

### 9.1 Topic 状态

Topic 不是聊天标签，而是持续讨论对象。它保存：

- `overview`：主题长期概览；
- `current_position`：目前形成的立场或方案；
- `topic_items`：Position、Decision、Rationale、Evolution 等结构化项；
- `open_loops`：尚未完成的问题、承诺和后续事项；
- `topic_revisions`：每次状态更新的版本化审计。

Topic Item 注入 Prompt 时会携带 `status`、`epistemic_basis`、`confidence`、`valid_from` 和 `valid_to`。

### 9.2 路由

路由可输出：

- `continue_current`；
- `reopen_old_topic`；
- `switch_topic`；
- `ambiguous`；
- `new_topic`。

低信息续接语句优先延续当前 Topic。明确 Alias 优先命中 canonical Topic。普通文字 Query 可以共享本轮 Query Embedding，结合词法与 Topic 语义相似度进行路由；语义服务不可用时回退到确定性词法路由。

路由分数和各分量会写入日志，在线反馈只用于观察，不自动修改权重。`continuity_profiles` 支持 active/challenger 配置和离线评测。

### 9.3 Alias、Merge 与 canonical Topic

所有 Topic 读取入口应解析 canonical Topic。旧 Topic 不物理删除，原有 Event、Snapshot 和日志引用仍然有效。

治理顺序是：

1. Alias 归一化；
2. 发现可能重复的 Topic Merge candidate；
3. 使用词法、结构和 Embedding 相似度形成候选；
4. LLM 基于证据判断 merge/keep separate/uncertain；
5. 代码验证版本并写入 `merged_into` 关系；
6. 后续读取统一解析到 canonical Topic。

### 9.4 Topic 健康检查与 Rebuild

Rebuild 不是按时间或 Revision 数机械触发。系统先记录健康信号，例如：

- 用户指出 Topic 记忆错误；
- current position 与 active Decision 冲突；
- 已解决 Open Loop 仍被描述为未解决；
- superseded Item 仍进入当前状态；
- Topic 长时间后重新激活并出现结构不一致。

真正 Rebuild 时只重建**当前状态**：overview、current position、active/tentative Item 集合、Open Loop 一致性和冲突报告。已有 Item 默认复用 ID，不重新抽取全部历史。

## 10. Self Model 与 Relationship State

状态更新统一采用 proposal + reducer，不允许 LLM 覆盖整个 JSON 文档。

### 10.1 Self Model 操作

- `record_user_correction`；
- `set_behavior_adjustment`；
- `add_failure_mode`；
- `link_commitment`；
- `fulfill_commitment`。

行为调整必须有用户明确的长期要求或重复证据。Agent 不能仅凭自己的输出给自己增加成功模式。

### 10.2 Relationship State 操作

当前只支持克制的四类状态：

- `add_interaction_style`；
- `add_trust_boundary`；
- `add_recurring_tension`；
- `resolve_tension`。

尚未实现抽象的“关系亲密度总结”或大规模 shared moments。State Prompt 明确禁止模型据此宣称用户信任、亲密或具有某种心理状态。

### 10.3 Reducer 约束

每个 `state_update` 包含 `state_type`、`expected_version` 和操作列表。Reducer 负责：

- expected version 校验；
- operation 白名单；
- global/topic/activity scope 校验；
- 证据校验；
- 幂等；
- 状态修订和审计。

## 11. 增强检索与排序

### 11.1 Query Analyzer

`analyzeQuery()` 提取：

- 词项及中文二元片段；
- 时间意图；
- 原因解释意图；
- 经历/事件意图；
- 低信息续接语句；
- 是否允许远程语义检索。

低信息 Query、包含敏感秘密的 Query 和 voice 模式不发送到远程 Embedding API。

### 11.2 Alibaba Embedding

当前使用阿里云 DashScope 原生 Embedding API：

```text
base URL: https://dashscope.aliyuncs.com/api/v1
model: text-embedding-v4
dimension: 1024
batch size: 10
profile: aliyun-text-embedding-v4-1024-v1
```

向量会 L2 归一化并以 Float32 BLOB 保存。文档采用稳定的结构化文本，而不是直接拼接数据库所有字段：

- Claim：主体、谓词、scope、状态和 canonical text；
- Topic：标题、overview 和 current position；
- Open Loop：主题、owner、状态和描述；
- Event：日期、类型、actor 和内容。

`content_hash` 用于检测源对象变化。对象变更后，旧向量不会继续冒充新内容；`embedding_jobs` 负责异步重建和失败重试。

远程 Embedding 必须同时满足：

```text
embeddingEnabled = true
remoteEmbeddingConsent = true
```

### 11.3 Eligibility 硬过滤

候选进入排序前先执行：

- `surface_policy=do_not_surface` 永不召回；
- `explicit_only` 不进入普通召回；
- 当前态查询只允许有效期内的 `active/current` 与 `disputed` Claim；
- 只有时间意图查询才允许 `active/historical` Claim；
- merged/archived Topic 不作为独立当前 Topic；
- Open Loop 只召回 `open`；
- 禁止敏感 Event 不进入候选。

这一步是正确性边界，不交给相似度分数决定。

### 11.4 三路召回与 RRF

候选同时计算：

- `lexical`：Query 词项与对象文本的匹配；
- `semantic`：Query Embedding 与对象 Embedding 的余弦相似度；
- `structural`：对象重要性、置信度、scope、连续性或 Open Loop 优先级。

当前融合使用加权 Reciprocal Rank Fusion：

```text
fusion_score = sum(weight[channel] / (rrf_k + rank[channel]))

rrf_k = 60
lexical weight = 1.2
semantic weight = 1.1
structural weight = 0.6
semantic floor = 0.15
```

这些默认值可由 active `retrieval_profile` 覆盖，但不会根据在线信号自动调参。

### 11.5 去重与多样性

融合后执行类型配额和语义去重：

| 模式 | Claim | Event | Topic | Open Loop |
| --- | ---: | ---: | ---: | ---: |
| text | 8 | 4 | 2 | 3 |
| deep | 14 | 8 | 4 | 5 |

额外规则：

- 同一 Claim Slot 和 value 不重复注入；
- 普通当前态查询中，如果 Event 只是已选 Claim 的证据，避免重复占用预算；
- disputed Slot 一旦命中，补齐同槽位争议项；
- 时间、原因和经历类问题可以保留更多 Event 或历史 Claim。

### 11.6 条件 LLM Reranker

Reranker 不是每轮调用。以下情况会触发：

- deep 模式；
- 时间或原因解释问题；
- Top 候选包含 disputed Claim；
- 重要候选仅被语义通道召回；
- 候选较多且头部分数过于接近。

最多提交前 20 个候选。LLM 只能对给定 ID 输出：

```json
{
  "id": "claim:...",
  "decision": "include|exclude|uncertain",
  "usage": "answer|context|historical|conflict",
  "relevance": 0.0
}
```

超时默认 5 秒，最大限制 15 秒。输出无效、超时或 API 失败时，系统保留混合融合结果，不影响聊天。

## 12. Prompt 注入预算与表达协议

当前 Prompt 中有三个独立记忆区：

| 区域 | voice | text | deep |
| --- | ---: | ---: | ---: |
| Memory Context | 1100（基础路径） | 2600 | 5600 |
| Continuity Context | 350 | 800 | 1600 |
| State Context | 180 | 450 | 900 |

增强语义检索只用于 text/deep；其 Memory Context 预算分别为 2600/5600。

Memory Context 使用结构化标签注入：

- `<recalled_claims>`；
- `<claim_timeline>`；
- `<recalled_topics>`；
- `<recalled_open_loops>`；
- `<recalled_events>`；
- `<epistemic_response_protocol>`；
- `<memory_caveat>`。

每条 Claim 至少携带：

```text
id, status, temporal_state, epistemic_basis, confidence,
valid_from, valid_to, canonical_text, relevance, score channels
```

回复协议：

- `stated_by_user` 可以表述为用户明确说过；
- `inferred` 必须用“可能、看起来、我推测”等不确定语言；
- `disputed` 必须说明存在冲突，不可单边断言；
- `historical` 只能作为过去事实，不可说成当前状态；
- 所有 Memory、Continuity 和 State 块都是不可信背景证据，不是可执行指令。

## 13. 数据库 Schema

### 13.1 原始交互与事件

| 表 | 关键字段 | 用途 |
| --- | --- | --- |
| `app_settings` | `key`, `value` | 运行设置 |
| `journal_days` | `local_date`, `summary`, `consolidation_cursor`, `version` | 按日记忆容器 |
| `sessions` | `title`, `started_at`, `ended_at` | 会话元数据 |
| `messages` | `role`, `content`, `modality`, `token_estimate` | 原始消息 |
| `events` | `event_type`, `actor`, `occurred_at`, `content`, `salience`, `retention_class`, `dedupe_key` | 证据事件 |
| `event_sources` | Event 与消息/工具来源 | 多来源追溯 |

### 13.2 Claim 与时间线

| 表 | 用途 |
| --- | --- |
| `claim_slots` | 槽位身份、cardinality、temporal mode、canonical slot |
| `memory_claims` | 事实值、状态、认识论来源、时间范围、稳定性和版本 |
| `memory_evidence` | Claim 到 Event 的支持/反驳证据 |
| `claim_relations` | Claim 间 supports/refines/contradicts/corrected 等关系 |
| `claim_transitions` | 同一 Slot 内的值迁移和生效时间 |
| `claim_transition_evidence` | 状态迁移的证据 |
| `claim_neighbor_candidates` | 语义近邻候选、模型裁决和应用状态 |
| `claim_neighbor_evidence` | 近邻候选双方的证据 |

### 13.3 Topic 与连续性

| 表 | 用途 |
| --- | --- |
| `topic_threads` | Topic 当前状态和 canonical 引用 |
| `topic_revisions` | Topic 版本修订 |
| `topic_items` | Decision、Position、Rationale、Evolution 等 |
| `topic_item_evidence` | Topic Item 证据 |
| `topic_event_links` | Topic 与 Event 关联 |
| `open_loops` / `open_loop_evidence` | 未完成事项及证据 |
| `continuity_state` | 当前和近期 Topic |
| `continuity_update_runs` | 连续性提取与应用审计 |
| `topic_aliases` / `topic_alias_evidence` | Alias 与证据 |
| `topic_relations` | merged_into 等 Topic 关系 |
| `topic_health_runs` | 结构一致性检查 |
| `topic_rebuild_runs` | Topic 当前状态重建 |
| `topic_merge_candidates` | 合并候选发现和裁决 |
| `continuity_profiles` / `continuity_profile_state` | 路由与评分版本 |
| `continuity_feedback` / `continuity_eval_runs` | 在线观测与离线评测 |

### 13.4 状态文档

| 表 | 用途 |
| --- | --- |
| `state_documents` | 当前 Self Model / Relationship State |
| `state_revisions` | reducer 修订记录 |
| `state_revision_evidence` | 修订证据 |

### 13.5 压缩、巩固与检索

| 表 | 用途 |
| --- | --- |
| `context_snapshots` | 会话摘要、来源范围和连续性引用 |
| `context_compaction_runs` | 压缩触发、输入输出和错误 |
| `memory_extraction_runs` | LLM 提取批次和应用结果 |
| `consolidation_runs` | 每日巩固运行状态 |
| `retrieval_logs` | Query、路由、选中对象和最终分数 |
| `retrieval_stage_logs` | 语义召回、融合、Rerank 各阶段耗时与降级 |
| `retrieval_profiles` | RRF 参数版本 |
| `reranker_profiles` | Reranker 配置版本 |

### 13.6 Embedding 索引

| 表 | 用途 |
| --- | --- |
| `embedding_profiles` | 模型、维度和文档版本 |
| `memory_embeddings` | 对象向量、content hash 和状态 |
| `embedding_jobs` | 异步索引任务、lease、重试和错误 |
| `memory_object_policies` | `normal`、`explicit_only`、`do_not_surface` 等表面策略 |

Agent 执行表（`agent_tasks`、`agent_runs`、`agent_steps`、`tool_executions` 等）属于整个应用的 Agent 审计层，不是记忆语义模型本身，但工具结果可以作为 Event 和 `tool_verified` 证据进入记忆系统。

## 14. 模块与调用关系

| 模块 | 当前职责 |
| --- | --- |
| `electron/database.cjs` | SQLite Schema、迁移、恢复、默认设置和 Inspector 查询 |
| `electron/memory.cjs` | 确定性事件捕获、基础检索、Token 估算、基础每日巩固 |
| `electron/memory-intelligence.cjs` | LLM 提取、上下文压缩、智能每日巩固 |
| `electron/claim-governance.cjs` | Claim Slot、实时候选归并、时间状态 reducer |
| `electron/claim-semantic.cjs` | Claim 语义近邻发现和裁决 |
| `electron/continuity.cjs` | Topic 路由、Prompt Context、连续性 proposal 应用 |
| `electron/topic-governance.cjs` | canonical Topic、Alias、Merge、健康检查和 Rebuild |
| `electron/topic-merge.cjs` | Topic 合并候选发现与 LLM 裁决 |
| `electron/state.cjs` | Self/Relationship proposal reducer 与 Prompt 注入 |
| `electron/embedding.cjs` | 阿里云 Embedding、文档构建、Job 和向量持久化 |
| `electron/retrieval.cjs` | Query 分析、语义召回、RRF、去重和预算打包 |
| `electron/retrieval-reranker.cjs` | 条件 LLM Rerank 和结构校验 |
| `electron/continuity-profiles.cjs` | 连续性评分和路由配置版本 |
| `electron/model.cjs` | 聊天、结构化输出和模型调用适配 |
| `electron/main.cjs` | Electron IPC、聊天主流程和后台任务编排 |

## 15. 默认配置

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `memoryModel` | `qwen3.7-max` | 提取与治理模型 |
| `compressionModel` | `qwen3.7-max` | 上下文压缩模型 |
| `contextWindowTokens` | `32768` | 上下文窗口估计值 |
| `reservedOutputTokens` | `4096` | 回复预留 |
| `contextSoftThreshold` | `0.75` | 自动压缩阈值 |
| `contextTargetRatio` | `0.45` | 压缩后的目标占比 |
| `memoryBatchSize` | `6` | 智能提取批次 |
| `embeddingEnabled` | `true` | Embedding 总开关 |
| `remoteEmbeddingConsent` | `true` | 允许远程发送可嵌入文本 |
| `embeddingModel` | `text-embedding-v4` | 阿里云 Embedding 模型 |
| `embeddingDimension` | `1024` | 向量维度 |
| `embeddingBatchSize` | `10` | 单批文本数 |
| `hybridRetrievalEnabled` | `true` | 启用混合检索 |
| `rerankerEnabled` | `true` | 启用条件 Reranker |
| `rerankerModel` | `qwen3.7-max` | Reranker 模型 |
| `rerankerTimeoutMs` | `5000` | Reranker 超时 |
| `claimSemanticGovernanceEnabled` | `true` | Claim 后台语义治理 |

## 16. 可观测性与评测

开发面板可以检查：

- Sessions、Messages、Events 和 Claims；
- Claim Slot、Transition、Relation、Evidence；
- Topic、Item、Open Loop、Alias、Merge、Health 和 Rebuild；
- Context Snapshot、Extraction/Compaction/Consolidation Run；
- Embedding Profile、Job、Object Policy 和向量状态；
- Retrieval Log 与每个 Stage 的输入、输出、耗时和错误；
- Claim Neighbor candidate 及裁决结果；
- Self/Relationship 文档和修订；
- Agent 工具执行与普通应用日志。

主要验证命令：

```powershell
npm test
npm run eval:continuity
npm run eval:retrieval
npm run eval:retrieval:hybrid
```

当前测试覆盖基础记忆、智能提取、压缩、连续性、状态治理、Topic 合并、Embedding、Shadow Recall、Hybrid Recall、Reranker、Claim 时间治理、Claim 语义治理和 Agent 审计。

检索评测保存 Query、预期对象、实际选择、路由、泄漏和协议结果。在线信号只记录用户是否立即纠正、是否错误重开、是否重复 Topic 等结果，不直接自动修改权重。

## 17. 降级与故障行为

| 故障 | 行为 |
| --- | --- |
| Embedding 未授权或关闭 | 使用确定性基础检索和词法 Topic 路由 |
| Query Embedding 失败 | 记录 degraded，继续基础路径 |
| Embedding 索引为空 | 跳过语义召回，不阻塞回复 |
| Hybrid 关闭 | 保留 Shadow Semantic 日志，但最终使用基础结果 |
| Reranker 超时或结构非法 | 回退到 RRF 融合顺序 |
| 记忆提取失败 | 原始消息和确定性 Event 仍保留 |
| 上下文压缩失败 | 不删除历史消息，沿用旧快照和消息尾部 |
| 每日智能巩固失败 | 记录失败并保留确定性巩固能力 |
| Claim/Topic proposal 版本冲突 | 拒绝应用，由后续运行基于新版本重试 |

## 18. 当前限制与下一步

以下项目在当前版本中**尚未完整实现**，不应与已落地的 P0-P6 混淆：

1. **精确 Token 计数**：当前仍是启发式估算，需要按模型接入 tokenizer 或用 API usage 校准。
2. **周/月层级巩固**：目前只有会话压缩和每日巩固，尚无周、月渐进摘要树。
3. **记忆复审、衰减和遗忘**：有 `review_after`、稳定性和表面策略字段，但没有完整自动复审调度器。
4. **大规模 ANN 索引**：当前 Float32 向量保存在 SQLite 并在本地线性计算相似度；数据量明显增长后需要向量扩展或专用索引。
5. **本地 Embedding 模型**：目前实现的是阿里云远程 API，尚无离线模型后端。
6. **Relationship 高阶建模**：有意保持克制，未实现亲密度推断、抽象关系总结和大规模共同瞬间。
7. **自动权重学习**：Continuity 与 Retrieval Profile 支持版本和评测，但不会根据在线数据自行改权重。
8. **更深的 Hermes 式闭环**：工具结果已经可以作为事件与证据，Agent 也有独立审计表；尚可继续补充“计划结果 -> 记忆提取 -> Self failure mode/commitment -> 后续规划”的统一反馈回路。

推荐后续顺序：先补 tokenizer 与更大离线评测集，再实现复审调度和周/月巩固；只有向量规模成为真实瓶颈时再引入 ANN。

## 19. 修改约定

修改记忆系统时应保持：

- Schema 变更有兼容迁移和真实旧数据库验证；
- LLM 输出先经过结构、枚举、证据、版本和 scope 校验；
- 新状态迁移放入事务；
- 新检索规则先增加离线用例，再进入在线路径；
- 不用 Reranker 修补 Eligibility 错误；
- 默认不物理删除历史 Claim 或 merged Topic；只有用户在记忆图景中明确执行“删除派生记忆”时，才删除目标 Claim 及其派生索引和关系，原始聊天与 Event 证据仍保留；
- Prompt 中始终携带认识论与时间语义；
- 所有远程语义调用必须遵守 consent 和敏感信息过滤；
- 失败路径保留基础聊天能力和完整审计。

## 20. 当前版本总结

当前 Pet 记忆系统已经形成完整的基础闭环：

```text
原始消息
  -> Event 证据
  -> LLM 结构化提案
  -> 确定性 Claim/Topic/State reducer
  -> 上下文压缩与每日巩固
  -> Alibaba Embedding 索引
  -> 词法 + 语义 + 结构混合检索
  -> 条件 Reranker
  -> 带认识论和时间语义的 Prompt 注入
  -> Retrieval/Run/Transition 全链路审计
```

它不再是“未来计划中的混合检索”，也不是单纯的按日摘要系统。当前版本的核心特征是：LLM 负责理解和压缩，确定性代码负责事实治理，检索层负责在正确性边界内把恰当的记忆交给回复模型。

## 21. 记忆图景与用户治理（P0-P5）

当前版本已经实现完整的记忆可视化闭环。它不是第二套记忆数据库，而是对现有
Claim、Event、Topic、Topic Item、Open Loop、State 和 Retrieval Log 的稳定只读投影。
所有节点 ID 使用 `type:id` 形式，关系图中的边直接来自证据表、关系表、状态修订和检索日志。

### 21.1 P0：投影模型与 IPC

`electron/memory-visualization.cjs` 提供以下投影：

- `getMemoryOverview()`：当前记忆统计、分类 Claim、Topic、Open Loop、每日活动和复核队列；
- `getMemoryGraph()`：局部或全局节点/边投影，可选语义邻居和回复检索路径；
- `getMemoryTimeline()`：Event、Topic、Claim 有效期、Open Loop 和治理操作的多轨时间线；
- `getMemoryNodeDetail()`：对象、证据、来源消息、关系、版本、变化线和召回记录；
- `getMemoryRetrievalTrace()`：某条回复实际收到的记忆集合与检索 Stage；
- `getMemoryDiagnostics()`：Embedding、Hybrid Retrieval、Reranker、邻居候选和治理健康状态。

Electron 主进程通过 `memory:atlas-*` IPC 暴露这些能力，preload 只提供结构化方法，不向
Renderer 暴露数据库或 Node 权限。

### 21.2 P1：概览、局部图和证据详情

记忆入口默认打开“概览”，按事实、偏好、目标、约束和习惯展示当前 Claim，并同时展示：

- 当前 Claim、活跃 Topic、Open Loop 和待复核数量；
- Topic 当前立场与未完成事项；
- 最近 84 天 Event 密度；
- Claim 的 `status`、`epistemic_basis`、`confidence` 和时间状态。

“关系图”使用 Cytoscape 渲染。默认局部模式执行受控 BFS，并对身份中心这类高连接节点设置
邻居上限，避免把整个数据库一次铺开。节点点击后打开详情栏，证据可以追溯到 Event 和原始
Message。全局模式只展示 Identity、Claim、Topic、Open Loop 和 State 等核心对象。

### 21.3 P2：时间线与历史时点

时间线以五条轨道展示事件、主题、事实变化、未完成事项和用户治理。Claim 使用
`valid_from` / `valid_to`，Open Loop 使用 `created_at` / `resolved_at`。

顶部“历史时点”会重新投影指定时间的 Claim、Topic Revision 和 Open Loop 状态：

- 尚未创建的对象不出现；
- 当时尚未解决的 Open Loop 恢复为 open；
- 纠正前的 superseded Claim 可在其历史有效时点重新出现；
- 当前数据库不具备精确历史字段的 Topic 状态只恢复最近 Revision 内容，不伪造状态变化。

### 21.4 P3：回复级记忆溯源

`retrieval_logs` 增加 `user_message_id` 和 `assistant_message_id`。每次回复保存 Retrieval ID，
聊天气泡上的记忆按钮可以打开溯源抽屉，展示：

- 查询、路由、评分版本和时间；
- 被提供给模型的 Claim、Event、Topic、Topic Item 和 Open Loop；
- 每个 Retrieval Stage 的状态、耗时、输入输出数量和 payload。

界面明确声明：日志能证明“哪些记忆被提供给模型”，不能证明模型最终依赖了每一条记忆。

### 21.5 P4：确认、纠正、隐藏和删除

用户操作写入 `memory_governance_actions`，保存 before/after JSON、原因、来源 Event 和时间。

- **确认**：复用原 Claim value，补充用户证据，不创建重复 Claim；
- **纠正**：创建 `memory_governance` Event，再通过 `applyClaimProposal()` 和既有确定性 reducer
  执行 correction/supersede；
- **隐藏**：写入 `memory_object_policies(do_not_surface, do_not_embed)`，删除现有 Embedding 和 Job，
  从普通检索与概览中退出；
- **恢复**：将 surface/embedding policy 恢复为普通继承；
- **删除**：只允许显式删除 Claim 派生对象，清理 Evidence 关联、Claim Relation、Transition、
  Neighbor、Embedding 和 Job；原始 Message 与 Event 不删除。

LLM 不参与这些最终状态变更，用户操作由事务和 reducer 保证原子性及审计性。

### 21.6 P5：全局图与开发诊断

开发视图展示 Embedding Ready/Failed、待处理 Job、Retrieval 数量、降级 Stage、隐藏对象、
Topic 健康警告和 Claim Neighbor 候选。语义相似边默认关闭，并标记为推断关系；它不会被表现
成用户明确陈述，也不会直接改变 Claim 状态。

原始数据表仍保留为独立“数据表”入口，用于逐行核对投影与底层记录。新增测试
`tests/memory-visualization.test.cjs` 覆盖投影、回复溯源以及确认、纠正、隐藏、恢复和删除闭环。
