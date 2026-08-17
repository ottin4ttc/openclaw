# INT 第二实例源码部署 Runbook

本文记录 INT 环境第二实例的 OpenClaw 7.1 源码部署、恢复和验收方法。目标是在不影响第一实例的前提下，让 Gateway、Codex runtime、Langfuse 和 OpenMAI 形成一套可回滚、可重复验证的部署。

## 固定基线

| 项目             | 固定值                                                            |
| ---------------- | ----------------------------------------------------------------- |
| 源码目录         | `/home/ubuntu/openclaw-codex`                                     |
| 状态目录         | `/data/openclaw-2`                                                |
| 配置文件         | `/data/openclaw-2/openclaw.json`                                  |
| Gateway 端口     | `18889`                                                           |
| OpenMAI 端口     | `18890`                                                           |
| Gateway 日志     | `/data/openclaw-2/logs/gateway-codex.log`                         |
| Gateway PID 文件 | `/data/openclaw-2/gateway-codex.pid`                              |
| 上游基线         | `v2026.7.1-2` (`0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`)        |
| TTC 交付版本     | `TTC-Kevin-20260810` (`343f31e19cca0704887e434fa31b3dd64c50b037`) |
| Codex CLI        | `0.147.0`                                                         |

硬性隔离规则：

- 不读取、修改、诊断或重启 `/data/openclaw`。
- 不执行 `pnpm link --global`；全局 `openclaw` 仍归第一实例使用。
- 第二实例的每条 CLI 命令都必须显式传入 `OPENCLAW_STATE_DIR` 和 `OPENCLAW_CONFIG_PATH`，日常通过 `occg2` 包装命令操作。
- 不让 7.1 和 7.2 共享可写 state。版本切换时恢复完整副本，不做双写或运行时兼容。
- 不使用默认的 `openclaw gateway start|stop|restart` 管理第二实例；它可能命中第一实例的 systemd unit。

## 1. 部署前盘点

先确认代码、数据、端口和进程归属，不要直接覆盖：

```bash
cd /home/ubuntu/openclaw-codex
git status --short
git rev-parse HEAD
git describe --tags --exact-match 2>/dev/null || true

test -d /data/openclaw-2
test -f /data/openclaw-2/openclaw.json
du -sh /data/openclaw-2

ss -ltnp | grep -E ':18889 |:18890 ' || true
```

如果端口已经监听，先通过 PID 文件和 `/proc/<pid>/environ` 验证进程确实属于 `/data/openclaw-2`。不能仅凭进程名或模糊 `grep` 结果终止进程。

## 2. 恢复完整状态目录

恢复消息和运行配置时，复制完整 state，而不是只复制 `openclaw.json`。完整 state 包括：

- sessions、agents 和各 agent workspace；
- provider/model 配置与认证资料；
- 每个 agent 的 Codex home；
- credentials、plugin-skills 和插件安装记录；
- Langfuse、OpenMAI 及其他插件配置。

恢复前必须停止第二实例。现有目录先做可恢复备份，再从确认过的备份复制；不要删除旧目录：

```bash
stamp="$(date +%Y%m%d-%H%M%S)"
mv /data/openclaw-2 "/data/openclaw-2.pre-71-${stamp}"
cp -a /data/openclaw-2.backup.20260803-21392 /data/openclaw-2
mkdir -p /data/openclaw-2/logs
chown -R ubuntu:ubuntu /data/openclaw-2
```

复制后检查备份是否多包了一层目录，并确认 `/data/openclaw-2/openclaw.json` 直接存在。不要在备份完成前运行会修改状态的 doctor 修复命令。

7.2 配置可能包含 7.1 不认识的字段。以恢复出的 7.1 配置为基线，只迁移已经确认兼容的 provider、model、agent 和插件配置。

## 3. 安装依赖与低资源构建

服务器构建的主要风险不是业务代码，而是 TypeScript declaration 生成的内存和 CPU 峰值。运行时部署不需要 DTS，必须跳过它，同时保留完整 UI 构建。

```bash
cd /home/ubuntu/openclaw-codex

corepack pnpm install \
  --frozen-lockfile \
  --prefer-offline \
  --os=linux \
  --cpu=x64 \
  --libc=glibc \
  --child-concurrency=1 \
  --network-concurrency=4 \
  --fetch-timeout=1800000 \
  --fetch-retries=5
```

优先用临时 cgroup 限制构建资源：

```bash
cd /home/ubuntu/openclaw-codex

systemd-run --user --scope \
  -p CPUQuota=200% \
  -p MemoryHigh=4G \
  -p MemoryMax=6G \
  -p TasksMax=256 \
  env \
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 \
    NODE_OPTIONS=--max-old-space-size=4096 \
  nice -n 15 \
  ionice -c2 -n7 \
  corepack pnpm build
```

如果用户级 cgroup 不可用：

```bash
OPENCLAW_RUN_NODE_SKIP_DTS_BUILD=1 \
NODE_OPTIONS=--max-old-space-size=4096 \
taskset -c 0,1 \
nice -n 15 \
ionice -c2 -n7 \
corepack pnpm build
```

构建注意事项：

- 不使用 `--force` 安装依赖。
- 不复制 macOS 的 `node_modules` 到 Ubuntu。
- 不同时编译多个 OpenClaw checkout。
- 不把 pnpm 网络并发提高到 20。
- swap 只能降低突然 OOM 的概率，不能解决构建峰值；大量换页会让服务器表现为“死机”。优先使用 cgroup、跳过 DTS 和降低并发。
- `qaRuntime` 等精简 profile 可能不包含 Control UI。正式部署使用上述完整 `pnpm build`；如果启动后出现 `Control UI assets not found`，说明构建产物不完整，应补跑 `corepack pnpm ui:build` 后再启动。

构建完成后检查版本和产物：

```bash
node dist/entry.js --version 2>/dev/null || node dist/index.js --version
cat dist/.buildstamp
test -d dist/control-ui/assets
```

版本必须指向当前 checkout 和预期 TTC tag，不能只看 `package.json`。

## 4. 配置的两个模型层级

Codex runtime 可用不等于 OpenClaw provider 配置正确。部署时必须同时核对两个层级：

1. OpenClaw 的 provider/model：模型名、API 类型、base URL、认证引用。
2. 每个 agent 的 Codex home：Codex app-server 实际读取的 provider、base URL 和认证配置。

典型失败是 OpenClaw 层看似使用内部模型，但 Codex home 仍指向 `api.openai.com`，或者内部 base URL 配上了另一套 token，最终返回 401。检查时只报告 key 是否存在和来源，不打印 token 值。

每个需要 Codex runtime 的 agent 都应确认：

- agent 配置选择 `runtime: codex`；
- runtime engine 为 `codex-app-server`，transport 为 `stdio`；
- agent 的 Codex home 存在且归 `ubuntu` 用户所有；
- base URL 与 token 属于同一 provider；
- 配置的模型在该 provider 上真实可调用。

## 5. 插件恢复顺序

按以下顺序启用，避免多个问题互相遮蔽：

1. 先启动纯 Gateway，确认 18889 和 session 基本读写正常。
2. 启用 Codex runtime，完成一轮不带业务插件的真实模型调用。
3. 启用独立的 `openclaw-langfuse` 插件。
4. 启用 OpenMAI 插件，并确认 18890 独立监听。
5. 最后恢复其他非关键插件。

插件源码、enablement、hook policy 或 `plugins.load.paths` 变化后，刷新冷注册表并重启真正的 Gateway 子进程：

```bash
occg2 plugins registry --refresh --json
occg2 plugins list --enabled --verbose
```

注册表刷新只修复持久化插件索引，不会热激活新代码。必须重启后再验收。

### Codex sandbox 中的 skill 路径

不要把宿主机绝对路径直接注入 Codex sandbox。类似 `/data/openclaw-2/plugin-skills/...` 的路径在 sandbox 内可能被解释为 `/home/sandbox/...` 并导致首次读取失败。

正确标准是：Codex runtime 生成 sandbox-aware 的 skill prompt，prompt 中的路径必须是 sandbox 内真实可读的 materialized path。`skills.list` 为空不一定表示 skill 不可用；orchestrator MCP skills 与 prompt 中的 file-backed skills 是两个不同的来源，应以真实 tool call 和文件读取结果验收。

## 6. 手工启动与安全停止

第二实例由 `occg2` 包装命令和 PID 文件管理，不安装 systemd unit。等价启动命令为：

```bash
cd /home/ubuntu/openclaw-codex
mkdir -p /data/openclaw-2/logs

nohup env \
  OPENCLAW_STATE_DIR=/data/openclaw-2 \
  OPENCLAW_CONFIG_PATH=/data/openclaw-2/openclaw.json \
  OPENCLAW_GATEWAY_PORT=18889 \
  OPENCLAW_NO_RESPAWN=1 \
  /usr/bin/node /home/ubuntu/openclaw-codex/openclaw.mjs gateway run \
    --port 18889 \
  >>/data/openclaw-2/logs/gateway-codex.log 2>&1 </dev/null &

echo "$!" >/data/openclaw-2/gateway-codex.pid
```

停止前验证 PID 身份：

```bash
pid="$(cat /data/openclaw-2/gateway-codex.pid)"
tr '\0' '\n' <"/proc/${pid}/environ" | grep -Fx 'OPENCLAW_STATE_DIR=/data/openclaw-2'
tr '\0' '\n' <"/proc/${pid}/environ" | grep -Fx 'OPENCLAW_CONFIG_PATH=/data/openclaw-2/openclaw.json'
tr '\0' '\n' <"/proc/${pid}/environ" | grep -Fx 'OPENCLAW_GATEWAY_PORT=18889'
kill -TERM "$pid"
```

三项环境校验任一失败，都不能向该 PID 发送信号。启动和停止后都要重新检查端口，避免只结束 wrapper、留下 Gateway 子进程。

## 7. 只读健康检查

所有命令通过 `occg2` 或显式 state/config 环境执行：

```bash
occg2 --version
occg2 doctor --lint --json
occg2 plugins registry --json
occg2 plugins list --enabled --verbose

ss -ltnp | grep -E ':18889 |:18890 '
curl --noproxy '*' -fsS http://127.0.0.1:18889/readyz
curl --noproxy '*' -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18890/
tail -n 100 /data/openclaw-2/logs/gateway-codex.log
```

验收预期：

- 18889 `/readyz` 返回成功。
- OpenMAI 18890 已监听；未认证请求返回 401，而不是连接失败。
- doctor lint 没有阻断级配置错误。
- 日志明确加载 Codex、Langfuse 和 OpenMAI，且路径都属于第二实例。
- 18889/18890 的监听 PID 与 `/data/openclaw-2` 环境一致。

先用 `doctor --lint`。不要在没有审阅 findings 和备份的情况下执行 `doctor --fix`；修复模式可能迁移或重写配置、插件索引和 state。

## 8. 端到端验收

静态检查通过后，使用真实 OpenMAI agent 做同一 session 的连续测试。最低标准：

1. 第一轮提出需要业务查询的招聘需求，触发至少两个 LLM call 和两个 tool call。
2. 第二轮沿用完全相同的 session，要求基于第一轮结果继续筛选或比较。
3. OpenClaw 页面能看到最终回复，session 中能看到两轮消息。
4. 第二轮 trace 顶层有 bounded `prior_conversation` 投影，并包含第一轮有价值的 user/assistant 上下文。
5. 每个 LLM generation 上记录 `runtime=codex`、`runtimeEngine=codex-app-server`、`runtimeTransport=stdio`。runtime 属于 LLM call 维度；不强求 trace 顶层重复该字段。
6. 工具调用具有输入、输出、耗时、成功/失败状态和可解释的 parent；无法可靠判定 parent 时不伪造绑定。
7. 连续完成五组包含多轮 LLM/tool call 的场景后，才认为插件组合稳定。

### Langfuse 验收标准

Langfuse 网页下载的 trace JSON 可能只列出 observation，而省略 observation 的 input/output，不能作为完整验收证据。固定使用两类 API：

- `GET /api/public/traces/{traceId}`：检查 trace 顶层 input/output、session、metadata 和 prior conversation。
- `GET /api/public/observations?traceId={traceId}`：逐条检查 generation/tool observation 的 input、output、parent、usage、endTime 和错误。

每次验收至少确认：

- trace 顶层 input/output 完整，第二轮存在有价值的历史投影；
- generation 实时出现，不是等整轮结束后才批量补写；
- 成功 generation 有 output 和 usage；
- 失败 generation 有具体上游错误，而不是笼统的 `failed`；
- tool observation 有 input/output 和正确的执行状态；
- 所有 observation 都有终止时间，或有明确的 terminal error 分类；
- Langfuse 中的最终 output 与 OpenClaw session 中用户实际收到的回复一致。

例如 Responses 流在完成事件前断开时，应保留具体错误：

```text
stream disconnected before completion: stream closed before response.completed
```

如果后续自动重试成功，失败 observation 和成功 observation 都应保留，不能用最终成功覆盖早先失败。

## 9. 常见故障与结论

| 现象                                          | 根因或优先检查项                                         | 处理                                                       |
| --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| build 十几分钟无输出、机器卡顿                | DTS 生成占用大量内存和 CPU                               | 跳过 DTS，限制 cgroup/CPU/内存，降低 pnpm 并发             |
| `Control UI assets not found`                 | 使用了不含 UI 的精简构建或 UI 构建未完成                 | 执行完整 build 或补跑 `pnpm ui:build`                      |
| TUI/页面仍显示旧版本                          | CLI、源码、运行中 Gateway 不是同一 checkout              | 同时核对 CLI 路径、PID cwd/env、buildstamp 和端口          |
| Codex 返回 401                                | Codex home 的 base URL/token 与 OpenClaw provider 不一致 | 同时修正 OpenClaw 和 per-agent Codex 配置                  |
| skill 第一次找不到                            | prompt 注入了宿主机路径，sandbox 内不存在                | 生成 sandbox-aware materialized skill path                 |
| 插件代码更新后没有 trace                      | 只更新了文件或注册表，没有重启实际 Gateway 子进程        | 刷新 registry 后精确重启 18889 进程                        |
| trace 下载 JSON 没有 observation input/output | 下载导出不是完整 API 视图                                | 用 trace API + observations API 验收                       |
| 第二轮没有历史消息                            | 换了 session，或 prior conversation 投影未生成           | 固定 sessionKey，检查 session 持久化和 trace 顶层 metadata |
| Gateway 已停但端口仍占用                      | 只停了 wrapper，子进程仍在                               | 根据端口 PID 和 `/proc/<pid>/environ` 精确确认并停止       |

## 10. 回滚

回滚始终以目录交换完成，不在同一个 state 上尝试跨版本反向迁移：

1. 精确停止 18889/18890 对应的第二实例进程。
2. 将当前 `/data/openclaw-2` 重命名为带时间戳的故障保留目录。
3. 把部署前的完整备份恢复为 `/data/openclaw-2`。
4. 切回对应源码 commit 并重新构建；不要使用另一个版本的 dist。
5. 依次执行 doctor lint、端口检查、Gateway smoke、Codex smoke 和两轮 Langfuse E2E。

停止条件：只有 Gateway、Codex runtime、Langfuse、OpenMAI、历史 session 和两轮真实业务请求全部通过，才结束部署。任何一步失败都保留日志、trace id、源码 SHA 和 state 备份，不继续叠加新的配置修改。
