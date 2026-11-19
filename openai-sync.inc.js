const spaces = await listTaskSpaces();
const existing = spaces.find(space => space.name === "codex-credit-openai-session");
let task;
if (existing?.ownership === "agentDelegatedToUser") {
  task = await takeOverTaskSpace(existing.id);
} else if (existing?.ownership === "user") {
  task = await claimTaskSpace(existing.id);
} else if (existing) {
  task = await taskSpace(existing.id);
} else {
  task = await taskSpace("codex-credit-openai-session");
}
const pages = await task.pages();
const page = pages[0] ?? await task.adopt((await task.tabs())[0].page);
let result = { sessionKey: null, organizationId: "", balance: null, error: "", code: "" };
try {
  const currentUrl = await page.url().catch(() => "");
  // Do not interrupt credentials or 2FA already being entered on the login
  // page. Platform/OIDC completion is awaited below before reading storage.
  if (!currentUrl.startsWith("https://auth.openai.com/")) {
    await page.goto("https://platform.openai.com/home", { timeout: 30000 });
  }
  // Wait for Platform's own OIDC bootstrap instead of reading a CDP response
  // before Network.loadingFinished. Slow first loads are normal on new devices.
  try {
    await page.waitForFunction(() => {
      if (location.hostname === "auth.openai.com") {
        return !location.pathname.includes("log-in") && !location.pathname.includes("login");
      }
      return Boolean(localStorage.getItem("oai-auth:onboard"));
    }, undefined, { timeout: 12000 });
  } catch {}
  if ((await page.url()).startsWith("https://auth.openai.com/")) {
    await page.goto("https://platform.openai.com/home", { timeout: 30000 });
    await page.waitForFunction(() => Boolean(localStorage.getItem("oai-auth:onboard")), undefined, { timeout: 12000 }).catch(() => {});
  }
  const payload = await page.evaluate(async () => {
    const request = async (url, options) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };
    const readJson = async response => {
      const text = await response.text();
      try { return { response, body: JSON.parse(text) }; }
      catch { return { response, body: null }; }
    };
    let accessToken = "";
    try {
      const raw = localStorage.getItem("oai-auth:onboard");
      const auth = raw ? JSON.parse(raw) : null;
      if (typeof auth?.accessToken === "string") accessToken = auth.accessToken;
    } catch {}
    if (!accessToken) return { code: "login-required", error: "请先在已打开的 Ego Lite 页面登录 OpenAI Platform，登录成功后返回插件再次点击同步" };

    const login = await request("https://api.openai.com/v1/dashboard/onboarding/login", {
      method: "POST",
      headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
      body: "{}",
    });
    const loginResult = await readJson(login);
    if (login.status === 401 || login.status === 403) {
      return { code: "login-required", error: "OpenAI Platform 登录已失效，请在已打开的页面重新登录后再次同步" };
    }
    if (!login.ok || !loginResult.body) {
      return { code: "login-exchange-failed", error: "OpenAI 登录态兑换失败（HTTP " + login.status + "），请稍后重试" };
    }
    const sessionKey = loginResult.body?.user?.session?.sensitive_id;
    if (typeof sessionKey !== "string" || !sessionKey.startsWith("sess-")) {
      return { code: "session-missing", error: "OpenAI 登录响应未包含有效会话，请重新同步登录态" };
    }
    const orgs = Array.isArray(loginResult.body?.user?.orgs?.data) ? loginResult.body.user.orgs.data : [];
    const org = orgs.find(item => item.personal) || orgs[0];
    const organizationId = typeof org?.id === "string" ? org.id : "";
    const billing = await request("https://api.openai.com/v1/dashboard/billing/credit_grants", {
      method: "GET",
      headers: {
        Authorization: "Bearer " + sessionKey,
        Accept: "application/json",
        ...(organizationId ? { "OpenAI-Organization": organizationId } : {}),
      },
    });
    const billingResult = await readJson(billing);
    if (!billing.ok || !billingResult.body) {
      return { code: billing.status === 401 || billing.status === 403 ? "login-required" : "billing-failed", error: billing.status === 401 || billing.status === 403 ? "OpenAI 会话已失效，请在打开的页面重新登录后再次同步" : "OpenAI 余额读取失败（HTTP " + billing.status + "），请稍后重试" };
    }
    const body = billingResult.body;
    if (body.total_granted === undefined || body.total_used === undefined) {
      return { code: "billing-shape", error: "OpenAI 余额响应格式已变化，请稍后重试" };
    }
    return { ok: true, sessionKey, organizationId, balance: body };
  });
  Object.assign(result, payload);
} catch (error) {
  result.code = "browser-network";
  result.error = error?.name === "AbortError"
    ? "OpenAI 页面网络请求超时（20 秒），请检查 Ego Lite 的网络或代理后重试"
    : String(error?.message || error);
}
// A verified balance closes the page. Missing login keeps the page visible and
// hands control to the user, who can log in and explicitly retry this sync.
if (result.ok) {
  await task.finish({ keep: [] }).catch(() => {});
} else if (result.code === "login-required") {
  // Land on the real login page, not an empty Platform shell, when there is
  // no OIDC state. The user sees exactly what action is required.
  let handedOff = false;
  try {
    await page.goto("https://auth.openai.com/log-in", { timeout: 30000 });
    const loginUrl = await page.url();
    if (!loginUrl.startsWith("https://auth.openai.com/")) throw new Error("login page unavailable");
    await task.handOff();
    handedOff = true;
    result.needsLogin = true;
    result.taskSpaceId = task.spaceId;
  } catch {}
  if (!handedOff) {
    result.code = "handoff-failed";
    result.needsLogin = false;
    result.error = "无法打开 OpenAI 登录页，请在 Ego Lite 手动登录 platform.openai.com 后重试";
    await task.finish({ keep: [] }).catch(() => {});
  }
} else {
  await task.finish({ keep: [] }).catch(() => {});
}
console.log("__CODEX_OPENAI_SYNC__" + JSON.stringify(result));
