import { redact } from "../logger/index.js";
import { sanitizeWorkspaceText } from "../workspace/sanitize.js";

export type PromptProfile = "default" | "defi";

export interface PromptContext {
  workspaceName: string;
  connectorName: string;
  task?: string;
  profile?: PromptProfile;
}

const DEFI_REVIEW = `
这是一个 DeFi / Solidity 高价值代码仓库。请重点检查：
Access Control、Reentrancy、CEI、External Call、delegatecall、Upgradeability、
Initializer、Storage Layout、Ownership、Roles、Pause Mechanism、Oracle/Price
Manipulation、Flash Loan、Accounting、Share/Asset Conversion、Rounding Direction、
Precision Loss、Donation/Inflation/First Depositor Attack、ERC4626 Semantics、
Fee Accounting、Slippage、DoS、Griefing、Front-running、Sandwich/MEV、Signature
Replay、Nonce、Cross-chain Message Validation、Bridge Trust Assumptions、Integer
Boundary、Invariant Violation、Economic Attack、Unexpected/Fee-on-transfer/Rebasing
Token、ERC777 Callback、Upgrade/Governance Risk。

同时检查测试是否真正覆盖此次修改，是否缺少 fuzz、invariant 或 fork test，
以及是否存在“测试通过但逻辑仍错误”的情况。`;

function safePromptText(raw: string): string {
  const gated = sanitizeWorkspaceText(redact(raw));
  const text = gated.allowed ? gated.text : "[REDACTED PRIVATE KEY]";
  return text
    .replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?:\/[^\s]*)?/gi, "[REDACTED MCP URL]")
    .replace(/https?:\/\/[^\s]+\/mcp\b[^\s]*/gi, "[REDACTED MCP URL]")
    .replace(/\/Users\/[^/\s"'`]+/g, "/Users/[user]")
    .replace(/\/home\/[^/\s"'`]+/g, "/home/[user]")
    .replace(/C:\\Users\\[^\\\s"'`]+/gi, String.raw`C:\Users\[user]`)
    .slice(0, 4000);
}

function safeLabel(raw: string): string {
  return safePromptText(raw).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function header(ctx: PromptContext): string {
  return `请使用「${safeLabel(ctx.connectorName)}」连接器，并先调用 workspace_info 确认 Workspace 是「${safeLabel(ctx.workspaceName)}」。`;
}

export function generatePlanPrompt(ctx: PromptContext): string {
  return `${header(ctx)}

任务：
${ctx.task?.trim() ? safePromptText(ctx.task.trim()) : "<请在发送前填写任务>"}

请自行使用 read_file、search_workspace、git_status 等只读工具了解真实代码。
不要修改任何文件，也不要要求我粘贴代码、Diff 或日志。

输出：
1. 任务理解
2. 涉及文件
3. 实现方案
4. 安全风险
5. 测试计划

完成后请把 PLAN 返回给我，我会手动交给 Codex 执行。`;
}

export function generateReviewPrompt(ctx: PromptContext): string {
  const profile = ctx.profile ?? "default";
  return `${header(ctx)}

请对 Codex 刚完成的修改做独立 Review。不要相信 Codex 对修改内容或测试结果的文字总结。
请自行调用 workspace_info、git_status、git_diff，必要时调用 read_file、
search_workspace、test_status、execution_summary；如存在可读测试输出，再调用
execution_output。基于真实 Workspace 状态审查，不要要求我复制代码或 Diff。
${profile === "defi" ? `\n${DEFI_REVIEW}\n` : ""}
最终格式：
Verdict: PASS | PASS WITH NOTES | CHANGES REQUIRED | BLOCK

Findings 按 Critical、High、Medium、Low、Info 分类。每个 Finding 必须包含：
- 文件
- 相关函数
- 问题
- 攻击/失败路径
- 建议修复方式

最后输出 Recommended next action。`;
}
