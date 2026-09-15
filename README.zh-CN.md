# Codex with ChatGPT — Manual Safe Mode

[English](README.md) | **简体中文**

> ChatGPT 规划与审查，Codex 修改与测试，用户负责传递短 Prompt。

这个安全版本面向私有仓库、Solidity、DeFi 和高价值工程项目。

## 架构

```text
┌─────────────────────────────┐
│           ChatGPT           │
│ Planning / Security Review  │
└──────────────┬──────────────┘
               │
        Official Connector
               │
          Read-only MCP
               │
               ▼
┌─────────────────────────────┐
│       Local Workspace       │
│ contracts / tests / docs    │
└──────────────▲──────────────┘
               │
               │ Edit / Shell / Git / Test
               │
┌──────────────┴──────────────┐
│            Codex            │
│     Execution / Testing     │
└─────────────────────────────┘

User manually carries:
Codex Prompt → ChatGPT
ChatGPT Review → Codex
```

ChatGPT 只通过官方自定义 Connector 和 OAuth 保护的 C2C MCP 读取已连接的
Workspace。Codex 保留本地编辑、Shell、Git、Foundry 和测试权限。

## 本 Fork 绝不会

- 自动登录或控制 ChatGPT
- 打开或操作 ChatGPT 页面
- 创建、删除、重连或修改 Connector
- 自动发送 Prompt 或读取回复
- 轮询页面或生成状态
- 创建、恢复 Chat 或 Project
- 保存 ChatGPT conversation URL

Manual Safe Mode 是默认且唯一推荐模式。这样可减少账号自动化、风控以及高价值
代码环境中的额外攻击面。可选固定 Tunnel 的 Cloudflare 账号授权仍是独立、
明确的人工操作。

## Read-only MCP 工具

公网 MCP 只公开：

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`
- `execution_output`

不存在写文件、命令执行、安装依赖或 Git 写操作工具。ChatGPT 无法通过 C2C
修改 Workspace。

## 安全安装

1. Clone 仓库。
2. 审查并固定准备信任的 commit。
3. 运行：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
```

4. 把 `skill/` 复制到 `~/.codex/skills/codex-with-chatgpt/`，并替换已安装
   Skill 中的 `<ACTUAL_CHECKOUT_PATH>`。
5. 缺少 Git、Node.js >= 20 或 cloudflared 时只提示安装命令，不自动安装系统软件。

依赖使用精确版本。普通工作流不会安装包或更新 lockfile。

## 首次配置

```bash
c2c setup -w /path/to/project
```

该命令启动 loopback Bridge、建立 Cloudflare HTTPS Tunnel，并输出 Connector
名称、Server URL、OAuth 认证方式和人工配置指南。它不会打开 ChatGPT，也不会
提前生成 Pairing Code。

请在 ChatGPT 中手动创建自定义 Connector。如需 Developer Mode，请自己在
ChatGPT 设置中开启。授权页要求验证码时，再运行：

```bash
c2c pair -w /path/to/project
```

由你亲自输入这个短期、一次性验证码。

如果 Codex 需要把 C2C state directory 加入 `writable_roots`，先检查：

```bash
c2c sandbox-allow --json
```

该命令只显示将修改的 `config.toml` 和精确 state directory，不写入。明确授权后：

```bash
c2c sandbox-allow --yes
```

`c2c setup` 和 `c2c doctor` 永远不会修改 Codex 全局配置。

## 请求 ChatGPT 制定 Plan

```bash
c2c prompt plan -w /path/to/project --task "实现当前需求"
```

把生成的短 Prompt 手动发给 ChatGPT，再把 ChatGPT 的 PLAN 粘贴回 Codex。
C2C 只生成文本，不发送或接收消息。

## 请求 ChatGPT 独立 Review

Codex 修改并测试后：

```bash
c2c prompt review -w /path/to/project
```

Prompt 会要求 ChatGPT 不相信 Codex 的总结，而是通过命名 Connector 自行检查
真实 `git_status`、`git_diff`、相关文件、测试记录和经过过滤的执行输出。

显式启用 DeFi Review：

```bash
c2c prompt review -w /path/to/project --profile defi
```

存在 Foundry、Hardhat 或 `contracts/` 的 Workspace 会自动使用 DeFi Profile。
检查范围包括权限、重入、外部调用、升级与存储、Oracle 与经济攻击、ERC4626
记账、舍入、异常 Token、MEV、签名、跨链/Bridge 假设、治理、fuzz、invariant
和 fork test。

生成的 Prompt 只含 Connector 名称，不含 MCP URL、OAuth/admin token、Pairing
Code、源码、Diff、日志或 Workspace 绝对路径。

## 日常工作流

开始开发时对 Codex 说：“开启 Bridge”。

Codex 会定位当前 Git 根目录，检查状态，复用健康 Bridge 或启动 detached daemon，
启动已保存的 Named Tunnel，并验证公网 Health 与 OAuth 保护的 MCP：

```text
✓ Workspace: Bifrost
✓ Bridge: healthy
✓ Named Tunnel: healthy
✓ MCP: https://c2c-bifrost.example.com/mcp
```

然后由你自己打开 ChatGPT，选择已经配置好的 `Codex · Bifrost` Connector。
C2C 不会打开或操作 ChatGPT。

## 开发结束

对 Codex 说：“关闭 Bridge”。Codex 会按当前 Workspace 停止 Tunnel 与 Bridge，
并确认二者均已停止。OAuth registration、Named Tunnel、DNS 与 Connector 配置
继续保留，第二天无需重配。

C2C 不安装 launchd、systemd、Windows Startup、Login Item 或其他 7×24 小时
自启动服务。

## 一次性固定域名配置

```text
在阿里云或其他 Registrar 购买域名
→ Cloudflare 添加 Zone
→ 导入并核对所有现有 DNS 记录
→ 在 Registrar 修改 Nameserver
→ 等待 Cloudflare Zone Active
→ 为当前 Workspace 创建唯一 Named Tunnel 与 Hostname
→ 用户手动配置一次 ChatGPT Connector
```

域名可继续由阿里云注册管理，只需把权威 DNS 和 Tunnel 交给 Cloudflare。切换
Nameserver 前必须保留 A、AAAA、CNAME、MX、TXT、CAA 记录，否则网站、API 或
邮箱可能中断。

```bash
c2c tunnel inspect-zone --zone example.com

c2c tunnel choose -w /path/to/project \
  --mode named \
  --zone example.com \
  --hostname c2c-bifrost.example.com

c2c start -w /path/to/project --tunnel
c2c status -w /path/to/project
```

Named 配置保存在机器本地 C2C state directory，不写入 Git。以后启动会复用原
Tunnel ID 与 Hostname。已配置 Named Tunnel 时绝不静默降级随机 Quick Tunnel；
Hostname 冲突也不会自动覆盖。

## Execution Output

Codex 可用 `c2c record` 记录简洁测试元数据。Foundry、Slither、lint、typecheck、
测试和构建输出只有经过以下处理后才可由 `execution_output` 读取：

- Private Key block hard reject
- API Token / Web3 Secret redaction
- Home path redaction
- 行数与字节上限

受限输出只显示元数据，不返回正文。

## 安全模型

- OAuth 2.1 Authorization Code + 强制 PKCE S256
- Pairing Code 短期、一次性、限制尝试次数和 IP 速率
- Access Token TTL、Refresh Token Rotation
- Raw OAuth Token 不落盘，只保存 SHA-256 hash
- Token 绑定单一 Workspace；未认证 `/mcp` 返回 401，错误 Workspace 返回 403
- Bridge 仅监听 loopback；Admin API 同时要求 loopback 和 admin token，并拒绝代理头
- Canonical realpath containment 与 symlink escape 防护
- 敏感路径策略与 `.c2cignore`
- Web3 wallet、keystore、seed、mnemonic、部署 Secret 默认屏蔽
- 内容级私钥拒绝和明显 Token/Secret 脱敏
- 文件、搜索、Diff 和 Execution Output 均有大小边界
- 支持的平台上状态目录 0700、敏感状态文件 0600

ChatGPT 通过 MCP 请求的 Workspace 内容会传给 ChatGPT。项目不会主动整仓上传，
但这并不代表“代码永远不离开本机”。私钥、Seed Phrase 和生产凭据必须放在项目
目录之外。Web3 项目建议：

```bash
cp examples/c2cignore.web3.example .c2cignore
```

高价值仓库建议使用专门的 AI 工作副本。

## 更新

`c2c update-check` 只提示，不自动升级。只有明确要求更新时，才会检查 clean tree、
审查远端 commit/diff 和安全敏感改动，然后 fast-forward，并使用 frozen lockfile。
绝不会自动 stash、reset、clean 或覆盖本地修改。

## 开发验证

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

完整威胁模型：[docs/security.md](docs/security.md)

人工协议：[docs/protocol.md](docs/protocol.md)

排障：[docs/troubleshooting.md](docs/troubleshooting.md)

非官方社区项目，与 OpenAI 无关联，未获其背书。

许可证：[MIT](LICENSE)
