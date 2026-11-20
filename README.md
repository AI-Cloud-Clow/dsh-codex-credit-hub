# dsh-codex-credit-hub

DeepSeek Harness 扩展插件，在左侧边栏底部、头像上方显示 **Codex** 与 **Codex API** 两个只读额度入口。

## 功能说明

### Codex

- 自动只读读取 `~/.codex/auth.json` 中的 OAuth token，请求 `https://chatgpt.com/backend-api/wham/usage`。
- 若 token 过期或本机没有明文 token，自动回退到 `codex app-server` 的 `account/read` 与 `account/rateLimits/read`，不修改 `~/.codex/`。
- 展示主/次限额窗口剩余百分比、重置时间、附加 Credits 余额和 Reset Credits 次数。

### Codex API

- **只使用 OpenAI Platform 登录态，不接受、不读取、不保存 API Key。**
- **优先复用 Ego Lite**：如果本机安装了 Ego Lite 且已登录 `platform.openai.com`，自动读取其 Platform OAuth 登录态。
- **没有 Ego Lite 也能用**：自动检测系统 Chrome / Edge / Brave / Chromium，打开插件专用登录窗口；登录成功后自动捕获令牌并关闭窗口，不读取或接管日常浏览器配置目录。
- **后续纯后台续期**：保存 Platform OAuth 访问令牌（约 10 天）和刷新令牌后，后台直接调用 OpenAI OAuth 续期、`onboarding/login` 会话兑换和 `credit_grants` 余额查询，不再为每次刷新打开浏览器。
- 展示与 `https://platform.openai.com/home` 一致的真实余额、总额度、已用额度、剩余百分比和最近 grant 到期时间。
- 会话过期时优先在后台续期；只有刷新令牌失效或首次连接时，才需要用户主动点击「同步 OpenAI 登录态」。
- 临时会话只保存到 DSH 凭证库，不返回给界面或 Agent 工具；默认本地凭证文件在 POSIX 系统仅当前 OS 用户可读，但并非加密存储。卸载插件会取消同步并丢弃内存状态；删除凭证请在 DSH 凭证管理中操作。

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
dsh-codex-credit-hub@1.2.1
```

### 本地目录安装

将本仓库克隆到本地后，在 **插件 → 添加插件** 中输入仓库目录的绝对路径。

## 配置项

支持在 `cordis.patch.yml` 中覆盖：

- `refreshIntervalSec`：自动刷新间隔，15–3600 秒，默认 `60`。
- `displayFormat`：紧凑栏显示格式，`both` | `remaining` | `percent`，默认 `both`。

## 运行前提与限制

- 首次连接 OpenAI Platform 需要一个可登录的浏览器：优先使用 Ego Lite；没有时使用系统 Chrome / Edge / Brave / Chromium 的插件专用窗口。
- 插件不会读取 Safari 或日常 Chrome 的本地数据目录，也不会要求用户手动复制 `sess-...` 或 API Key。
- 系统浏览器登录使用独立目录 `<DSH_HOME>/codex-credit-hub-browser`，其中可能保存 OpenAI 登录 Cookie；删除该目录即可清除这套专用浏览器登录状态。
- 日常刷新依赖 DSH 凭证库中的 OAuth 刷新令牌；默认本地凭证文件在 POSIX 系统仅当前 OS 用户可读，并非加密存储。撤销 OpenAI 登录或删除该凭证后，需要重新连接。
- OpenAI Platform 的 `onboarding/login` 和 `credit_grants` 属于网页端接口，不是 OpenAI 面向普通 API Key 的公开余额 API；如果 OpenAI 调整接口，插件会显示同步失败并保留手动重试入口。
- Codex 订阅额度与 OpenAI API 预付/赠送余额是不同账户体系，插件分别展示，不互相推算。
