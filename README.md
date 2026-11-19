# dsh-codex-credit-hub

DeepSeek Harness 扩展插件，在左侧边栏底部、头像上方显示 **Codex** 与 **Codex API** 两个只读额度入口。

## 功能说明

### Codex

- 自动只读读取 `~/.codex/auth.json` 中的 OAuth token，请求 `https://chatgpt.com/backend-api/wham/usage`。
- 若 token 过期或本机没有明文 token，自动回退到 `codex app-server` 的 `account/read` 与 `account/rateLimits/read`，不修改 `~/.codex/`。
- 展示主/次限额窗口剩余百分比、重置时间、附加 Credits 余额和 Reset Credits 次数。

### Codex API

- **只使用 OpenAI Platform 登录态，不接受、不读取、不保存 API Key。**
- 插件通过本机 Ego Lite 的 `ego-browser` 复用 `platform.openai.com` 登录态，在页面内完成 `POST /v1/dashboard/onboarding/login` 会话兑换和 `GET /v1/dashboard/billing/credit_grants` 余额校验。
- 展示与 `https://platform.openai.com/home` 一致的真实余额、总额度、已用额度、剩余百分比和最近 grant 到期时间。
- 会话过期、失效或 Node 网络请求超时/失败时自动通过浏览器重新同步；浏览器网络可使用系统代理或 VPN，降低仅 Node 请求超时的影响。
- 新设备未登录时会保留 OpenAI 登录页；完成登录后，再点击一次「同步 OpenAI 登录态」即可继续。
- 临时会话只保存到 DSH 加密凭证库，不返回给界面或 Agent 工具；清除/卸载插件会取消同步并丢弃内存状态。

### Agent 工具

- `codex_cli_quota`：`status` / `refresh`，查询或刷新 Codex 订阅限额。
- `codex_api_quota`：`status` / `refresh` / `sync_browser`，查询余额、强制刷新或同步 OpenAI 登录态。

## 安装方式

### 通过 GitHub 安装

在 DeepSeek Harness 中打开 **插件 → 添加插件**，输入：

```text
https://github.com/AI-Cloud-Clow/dsh-codex-credit-hub
```

或：

```text
github:AI-Cloud-Clow/dsh-codex-credit-hub
```

### 通过公共 npm 安装

```text
dsh-codex-credit-hub
```

指定版本安装（避免包管理器的最新版本观察期影响）：

```text
dsh-codex-credit-hub@1.1.0
```

### 本地目录安装

将本仓库克隆到本地后，在 **插件 → 添加插件** 中输入仓库目录的绝对路径。

## 配置项

支持在 `cordis.patch.yml` 中覆盖：

- `refreshIntervalSec`：自动刷新间隔，15–3600 秒，默认 `60`。
- `displayFormat`：紧凑栏显示格式，`both` | `remaining` | `percent`，默认 `both`。

## 运行前提与限制

- Codex API 自动同步需要安装并启动 [Ego Lite](https://lite.ego.app/)，完成其初始设置，使 `ego-browser` 命令可用。
- 同步依赖 Ego Lite 中的 OpenAI Platform 登录态；它与系统默认浏览器、Chrome 的登录状态不是同一份。如果 Chrome 已登录但 Ego Lite 未登录，插件会打开登录页，登录后需再次点击同步。
- OpenAI Platform 的 `onboarding/login` 和 `credit_grants` 属于网页端接口，不是 OpenAI 面向普通 API Key 的公开余额 API；如果 OpenAI 调整接口，插件会显示同步失败并保留手动重试入口。
- Codex 订阅额度与 OpenAI API 预付/赠送余额是不同账户体系，插件分别展示，不互相推算。
