const state = {
  session: null,
  dashboard: null,
  page: "overview",
  draft: {
    serverId: null,
    streamId: null,
    workspaceId: null,
    groupId: null,
    serverTenantId: "",
    streamTenantId: "",
    groupTenantId: ""
  },
  filters: {
    query: "",
    status: "all"
  },
  explorerLevel: 2,
  collapsedGroups: {},
  collapsedServers: {}
};

const ROLE_LABELS = {
  super_admin: "超级管理员",
  tenant_admin: "客户管理员",
  operator: "操作员"
};

const STATUS_LABELS = {
  healthy: "正常",
  restarting: "恢复中",
  cooldown: "冷却中",
  failed: "异常",
  unknown: "未知",
  up: "在线",
  down: "离线",
  active: "有效",
  disabled: "停用",
  expired: "已到期",
  unused: "未使用",
  redeemed: "已兑换"
};

function qs(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

function statusClass(status) {
  if (["healthy", "up", "active", "unused"].includes(status)) return "status-healthy";
  if (["restarting", "cooldown", "redeemed"].includes(status)) return "status-restarting";
  return "status-failed";
}

function setView(view, role = "guest") {
  document.body.dataset.view = view;
  document.body.dataset.role = role;
}

function authPathMode() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (pathname === "/admin" || pathname === "/admin/login") return "admin";
  if (pathname === "/customer" || pathname === "/customer/login" || pathname === "/login") return "customer";
  if (pathname === "/redeem" || pathname === "/cdk") return "redeem";
  if (pathname === "/setup") return "setup";
  return "landing";
}

function syncAuthRoute(setupRequired, mode) {
  const target = setupRequired
    ? "/setup"
    : mode === "admin"
      ? "/admin/login"
      : mode === "customer"
        ? "/customer/login"
        : mode === "redeem"
          ? "/redeem"
          : "/";
  if (window.location.pathname !== target) {
    window.history.replaceState({}, "", target);
  }
}

const PAGE_META = {
  overview: { title: "总览", description: "先看异常，再看客户空间、分组和恢复状态。" },
  matrix: { title: "直播矩阵", description: "按状态筛选全部直播流，适合快速检索和批量巡检。" },
  groups: { title: "分组巡检", description: "按分组、服务器、直播流三级展开，适合日常运营查看。" },
  servers: { title: "服务器管理", description: "维护 SSH 配置，并可一键识别当前正在直播的推流。" },
  streams: { title: "直播流管理", description: "维护媒体文件、推流码、重推命令和恢复策略。" },
  workspaces: { title: "客户空间", description: "管理客户空间额度、状态、到期时间和基础资料。" },
  users: { title: "客户账号", description: "创建和删除客户后台账号，保持空间隔离。" },
  cdk: { title: "CDK 管理", description: "批量生成不同套餐的 CDK，支持后续服务销售。" },
  resources: { title: "资源监控", description: "查看管理服务器和当前程序本身的 CPU、内存、流量占用。" },
  settings: { title: "平台设置", description: "调整巡检间隔、超时和全局运行参数。" },
  notifications: { title: "通知设置", description: "配置 SMTP 和测试邮件通知链路。" },
  events: { title: "事件记录", description: "查看最近的重要系统事件，超出后滚动浏览。" },
  security: { title: "账号安全", description: "维护当前登录账号密码。" }
};

function pageGroupsForRole(role) {
  if (role === "super_admin") {
    return [
      {
        title: "控制台",
        items: [
          { page: "overview", label: "总览", meta: "异常与核心指标" },
          { page: "matrix", label: "直播矩阵", meta: "全局直播检索" },
          { page: "groups", label: "分组巡检", meta: "三级结构视图" },
          { page: "servers", label: "服务器", meta: "SSH 与自动识别" },
          { page: "streams", label: "直播流", meta: "推流码与恢复" }
        ]
      },
      {
        title: "CRM",
        items: [
          { page: "workspaces", label: "客户空间", meta: "套餐与额度" },
          { page: "users", label: "客户账号", meta: "后台账号管理" },
          { page: "cdk", label: "CDK 管理", meta: "支持批量生成" }
        ]
      },
      {
        title: "平台",
        items: [
          { page: "resources", label: "资源监控", meta: "主机与程序占用" },
          { page: "settings", label: "平台设置", meta: "巡检与会话参数" },
          { page: "notifications", label: "通知设置", meta: "SMTP 与邮件" },
          { page: "events", label: "事件记录", meta: "系统日志" },
          { page: "security", label: "账号安全", meta: "修改当前密码" }
        ]
      }
    ];
  }

  return [
    {
      title: "控制台",
      items: [
        { page: "overview", label: "总览", meta: "异常与核心指标" },
        { page: "matrix", label: "直播矩阵", meta: "当前空间直播检索" },
        { page: "groups", label: "分组巡检", meta: "三级结构视图" },
        { page: "servers", label: "服务器", meta: "SSH 与自动识别" },
        { page: "streams", label: "直播流", meta: "推流与恢复配置" }
      ]
    },
    {
      title: "账户",
      items: [
        { page: "events", label: "事件记录", meta: "近期操作与告警" },
        { page: "security", label: "账号安全", meta: "修改当前密码" }
      ]
    }
  ];
}

function normalizePageForRole(role, requestedPage) {
  const allowedPages = new Set(pageGroupsForRole(role).flatMap((group) => group.items.map((item) => item.page)));
  return allowedPages.has(requestedPage) ? requestedPage : "overview";
}

function parseAppPage(role) {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  if (role === "super_admin") {
    if (pathname.startsWith("/admin/") && pathname !== "/admin/login") {
      return pathname.slice("/admin/".length) || "overview";
    }
    return "overview";
  }

  if (pathname.startsWith("/customer/") && pathname !== "/customer/login") {
    return pathname.slice("/customer/".length) || "overview";
  }

  return "overview";
}

function syncAppRoute(role, page, replace = false) {
  const target = role === "super_admin"
    ? `/admin/${page}`
    : `/customer/${page}`;
  if (window.location.pathname === target) {
    return;
  }

  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", target);
}

function showToast(message, isError = false) {
  const toast = qs("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  toast.style.borderColor = isError ? "rgba(255,125,102,.35)" : "rgba(98,215,205,.3)";
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(payload?.message ?? `HTTP ${response.status}`);
  }

  return payload;
}

function serializeForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function checkboxValue(form, name) {
  return Boolean(form.querySelector(`[name="${name}"]`)?.checked);
}

function textareaLines(form, name) {
  return (form.querySelector(`[name="${name}"]`)?.value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeGroupName(value) {
  return String(value ?? "").trim() || "Default";
}

function normalizeStreamKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/^rtmp:\/\/[^/]+\/live2\//i, "")
    .replace(/^live2\//i, "")
    .trim();
}

function normalizeMediaPath(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  return normalized.includes("/") ? normalized : `/root/${normalized}`;
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildManagedMatchTerms(sourcePath, streamKey) {
  return dedupe([
    normalizeStreamKey(streamKey),
    normalizeMediaPath(sourcePath)
  ]);
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "n/a";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** index;
  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : "n/a";
}

function daysUntil(value) {
  if (!value) return "长期";
  const days = Math.ceil((Date.parse(value) - Date.now()) / 86400000);
  if (days < 0) return "已到期";
  if (days === 0) return "今天到期";
  return `${days} 天`;
}

function usagePercent(current, max) {
  if (!max || max <= 0) return 100;
  return Math.min(100, Math.round((current / max) * 100));
}

function usageBars(space) {
  if (!space) return "";
  const rows = [
    ["账号", space.userCount, space.maxUsers],
    ["服务器", space.serverCount, space.maxServers],
    ["直播流", space.streamCount, space.maxStreams]
  ];
  return `
    <div class="usage-bars">
      ${rows.map(([label, current, max]) => `
        <div class="usage-row">
          <div class="usage-head"><span>${label}</span><span>${current} / ${max}</span></div>
          <div class="usage-track"><div class="usage-fill" style="width:${usagePercent(current, max)}%"></div></div>
        </div>
      `).join("")}
    </div>
  `;
}

function tenantNameById(dashboard, tenantId) {
  return (dashboard.tenants ?? []).find((item) => item.id === tenantId)?.name ?? "";
}

function workspaceOptions(dashboard) {
  return (dashboard.tenants ?? [])
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join("");
}

function groupsForTenant(dashboard, tenantId) {
  return (dashboard.groups ?? []).filter((group) => !tenantId || group.tenantId === tenantId);
}

function groupOptions(dashboard, tenantId, selectedName = "Default") {
  const names = new Set(groupsForTenant(dashboard, tenantId).map((group) => normalizeGroupName(group.name)));
  names.add(normalizeGroupName(selectedName));
  names.add("Default");
  return [...names]
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((name) => `<option value="${escapeHtml(name)}"${name === normalizeGroupName(selectedName) ? " selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
}

function serverOptions(dashboard, tenantId, selectedServerId = "") {
  return dashboard.servers
    .filter((server) => !tenantId || server.tenantId === tenantId)
    .map((server) => `
      <option value="${escapeHtml(server.id)}"${server.id === selectedServerId ? " selected" : ""}>
        ${escapeHtml(server.groupName)} / ${escapeHtml(server.label)}
      </option>
    `)
    .join("");
}

function buildStreamPayload(form) {
  const body = serializeForm(form);
  const sourcePath = normalizeMediaPath(body.sourcePath);
  const streamKey = normalizeStreamKey(body.streamKey);
  const manualMatchTerms = textareaLines(form, "matchTerms");
  const managedMatchTerms = buildManagedMatchTerms(sourcePath, streamKey);
  const label = String(body.label ?? "").trim() || (sourcePath ? sourcePath.split("/").pop() : "");

  return {
    ...body,
    label,
    sourcePath,
    streamKey,
    matchTerms: dedupe([...managedMatchTerms, ...manualMatchTerms]),
    enabled: checkboxValue(form, "enabled")
  };
}

function streamIdentityHtml(stream) {
  const rows = [];
  if (stream.sourceFileName || stream.sourcePath) {
    rows.push(`<div class="subtle meta-mono">文件：${escapeHtml(stream.sourceFileName || stream.sourcePath)}</div>`);
  }
  if (stream.streamKey) {
    rows.push(`<div class="subtle meta-mono">推流码：${escapeHtml(stream.streamKey)}</div>`);
  }
  return rows.join("");
}

async function saveStreamFromForm({ startAfterSave = false } = {}) {
  const form = qs("#streamForm");
  const payload = buildStreamPayload(form);
  const path = state.draft.streamId ? `/api/streams/${encodeURIComponent(state.draft.streamId)}` : "/api/streams";
  const response = await api(path, {
    method: state.draft.streamId ? "PUT" : "POST",
    body: payload
  });

  const streamId = response.stream?.id ?? state.draft.streamId;
  resetDrafts("stream");
  await refreshAdmin();

  if (startAfterSave && streamId) {
    const result = await api(`/api/streams/${encodeURIComponent(streamId)}/recover`, { method: "POST" });
    await refreshAdmin();
    return result.message ?? "直播已启动";
  }

  return "直播流已保存";
}

function currentServerTenantId(dashboard, user, current = null) {
  if (user.role !== "super_admin") return user.tenantId;
  return state.draft.serverTenantId || current?.tenantId || dashboard.tenants?.[0]?.id || "";
}

function currentStreamTenantId(dashboard, user, current = null) {
  if (user.role !== "super_admin") return user.tenantId;
  return state.draft.streamTenantId || current?.tenantId || dashboard.tenants?.[0]?.id || "";
}

function currentGroupTenantId(dashboard, user, current = null) {
  if (user.role !== "super_admin") return user.tenantId;
  return state.draft.groupTenantId || current?.tenantId || dashboard.tenants?.[0]?.id || "";
}

function filteredStreams(dashboard) {
  const query = state.filters.query.trim().toLowerCase();
  const status = state.filters.status;
  return dashboard.streams.filter((stream) => {
    if (status !== "all" && stream.status !== status) return false;
    if (!query) return true;
    return [stream.label, stream.serverLabel, ...(stream.matchTerms ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

function explorerGroupKey(group) {
  return `${group.tenantId ?? "global"}:${normalizeGroupName(group.name)}`;
}

function renderAuth(setupRequired) {
  const requestedMode = authPathMode();
  const mode = setupRequired
    ? "setup"
    : ["admin", "customer", "redeem"].includes(requestedMode)
      ? requestedMode
      : "landing";
  const landing = mode === "landing";

  setView("auth");
  qs("#authShell").classList.remove("hidden");
  qs("#appShell").classList.add("hidden");
  syncAuthRoute(setupRequired, mode);
  qs("#setupCard").classList.toggle("hidden", !setupRequired);
  qs("#loginHub").classList.toggle("hidden", setupRequired);
  qs("#loginHub").dataset.layout = landing ? "grid" : "single";

  document.querySelectorAll("[data-auth-card]").forEach((card) => {
    const cardMode = card.dataset.authCard;
    const landingVisible = landing && ["customer", "redeem"].includes(cardMode);
    const visible = !setupRequired && (landingVisible || cardMode === mode);
    const form = card.querySelector(".auth-form");
    const entryActions = card.querySelector(".auth-entry-actions");
    const routeActions = card.querySelector(".auth-route-actions");
    card.classList.toggle("hidden", !visible);
    form?.classList.toggle("hidden", landing || cardMode !== mode);
    entryActions?.classList.toggle("hidden", !landing);
    routeActions?.classList.toggle("hidden", landing || cardMode !== mode);
  });
}

function renderSidebarNavigation(user) {
  const nav = qs("#appSidebarNav");
  if (!nav) return;
  const groups = pageGroupsForRole(user.role);
  nav.innerHTML = groups.map((group) => `
    <section class="nav-group">
      <div class="nav-group-title">${escapeHtml(group.title)}</div>
      <div class="nav-group-links">
        ${group.items.map((item) => `
          <button class="nav-link" type="button" data-page-nav="${escapeHtml(item.page)}" data-active="${item.page === state.page ? "true" : "false"}">
            <span class="nav-link-title">${escapeHtml(item.label)}</span>
            <span class="nav-link-meta">${escapeHtml(item.meta)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function applyPageVisibility(user) {
  document.querySelectorAll(".page-section").forEach((section) => {
    const requiredRole = section.dataset.role;
    const allowed = !requiredRole || requiredRole === user.role;
    const active = allowed && section.dataset.page === state.page;
    section.classList.toggle("hidden", !active);
  });

  const meta = PAGE_META[state.page] ?? PAGE_META.overview;
  qs("#pageContextTitle").textContent = meta.title;
  qs("#pageContextDescription").textContent = meta.description;
}

function renderWorkspaceSnapshot(dashboard, user) {
  const panel = qs("#workspaceSnapshotPanel");
  panel.classList.remove("hidden");

  if (user.role === "super_admin") {
    panel.innerHTML = `
      <p class="eyebrow">PLATFORM SNAPSHOT</p>
      <div class="workspace-snapshot">
        <div>
          <div class="title">平台总览</div>
          <div class="subtle">集中管理客户空间、分组、服务器和恢复策略</div>
        </div>
        <div class="workspace-snapshot-grid">
          <div class="snapshot-item"><span>客户空间</span><strong>${dashboard.tenants?.length ?? 0}</strong></div>
          <div class="snapshot-item"><span>分组</span><strong>${dashboard.groups?.length ?? 0}</strong></div>
          <div class="snapshot-item"><span>服务器</span><strong>${dashboard.servers.length}</strong></div>
        </div>
        <div class="guide-links">
          <a class="button ghost small" href="/guides/customer-guide.md" target="_blank" rel="noreferrer">普通用户教程</a>
          <a class="button ghost small" href="/guides/admin-guide.md" target="_blank" rel="noreferrer">超管教程</a>
        </div>
      </div>
    `;
    return;
  }

  const workspace = dashboard.workspace;
  if (!workspace) {
    panel.classList.add("hidden");
    return;
  }

  panel.innerHTML = `
    <p class="eyebrow">MY SPACE</p>
    <div class="workspace-snapshot">
      <div>
        <div class="title">${escapeHtml(workspace.name)}</div>
        <div class="subtle">${escapeHtml(workspace.slug)} · ${statusLabel(workspace.status)} · ${daysUntil(workspace.expiresAt)}</div>
      </div>
      <div class="workspace-snapshot-grid">
        <div class="snapshot-item"><span>分组</span><strong>${workspace.groupCount ?? dashboard.groups?.length ?? 0}</strong></div>
        <div class="snapshot-item"><span>服务器</span><strong>${workspace.serverCount}</strong></div>
        <div class="snapshot-item"><span>直播流</span><strong>${workspace.streamCount}</strong></div>
      </div>
      ${usageBars(workspace)}
      <div class="guide-links">
        <a class="button ghost small" href="/guides/customer-guide.md" target="_blank" rel="noreferrer">查看教程</a>
      </div>
    </div>
  `;
}

function renderMetrics(dashboard, user) {
  const badServers = dashboard.servers.filter((server) => server.enabled && server.connectionStatus !== "up").length;
  const badStreams = dashboard.streams.filter((stream) => stream.enabled && stream.status !== "healthy").length;
  const items = user.role === "super_admin"
    ? [
        ["客户空间", dashboard.tenants?.length ?? 0],
        ["分组", dashboard.groups?.length ?? 0],
        ["异常服务器", badServers],
        ["异常直播流", badStreams]
      ]
    : [
        ["正常直播流", dashboard.streams.filter((stream) => stream.status === "healthy").length],
        ["异常直播流", badStreams],
        ["服务器分组", dashboard.groups?.length ?? 0],
        ["异常服务器", badServers]
      ];

  qs("#metrics").innerHTML = items.map(([label, value]) => `
    <article class="metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      <div class="muted">最后巡检 ${escapeHtml(formatTime(dashboard.meta.lastCycleAt))}</div>
    </article>
  `).join("");
}

function renderRuntimeMetrics(dashboard, user) {
  const panel = qs("#infrastructurePanel");
  const visible = user.role === "super_admin";
  panel.classList.toggle("hidden", !visible);
  if (!visible) return;

  const metrics = dashboard.runtimeMetrics;
  if (!metrics) {
    qs("#hostResourceGrid").innerHTML = '<div class="empty">当前还没有采集到资源数据。</div>';
    qs("#appResourceGrid").innerHTML = '<div class="empty">当前还没有采集到程序占用数据。</div>';
    return;
  }

  const host = metrics.host;
  const app = metrics.app;
  qs("#hostResourceGrid").innerHTML = `
    <article class="resource-card">
      <div class="resource-label">CPU</div>
      <div class="resource-value">${formatPercent(host.cpu.utilizationPercent)}</div>
      <div class="subtle">${host.cpu.cores} 核 · Load ${host.cpu.loadAverage.join(" / ")}</div>
    </article>
    <article class="resource-card">
      <div class="resource-label">内存</div>
      <div class="resource-value">${formatPercent(host.memory.usedPercent)}</div>
      <div class="subtle">${formatBytes(host.memory.usedBytes)} / ${formatBytes(host.memory.totalBytes)}</div>
    </article>
    <article class="resource-card">
      <div class="resource-label">磁盘</div>
      <div class="resource-value">${formatPercent(host.storage?.usedPercent)}</div>
      <div class="subtle">${formatBytes(host.storage?.usedBytes)} / ${formatBytes(host.storage?.totalBytes)}</div>
    </article>
    <article class="resource-card">
      <div class="resource-label">主机流量</div>
      <div class="resource-value">${formatBytes(host.network?.rxBytes)} / ${formatBytes(host.network?.txBytes)}</div>
      <div class="subtle">接收 / 发送累计</div>
    </article>
    <article class="resource-card resource-card-wide">
      <div class="resource-label">系统信息</div>
      <div class="resource-value">${escapeHtml(host.hostname)}</div>
      <div class="subtle">${escapeHtml(`${host.platform} ${host.release} · ${host.arch}`)}</div>
      <div class="subtle">运行时长 ${Math.floor(host.uptimeSeconds / 3600)} 小时</div>
    </article>
  `;

  qs("#appResourceGrid").innerHTML = `
    <article class="resource-card">
      <div class="resource-label">程序 CPU</div>
      <div class="resource-value">${formatPercent(app.cpu.hostPercent)}</div>
      <div class="subtle">主机占比 · 单核 ${formatPercent(app.cpu.corePercent)}</div>
    </article>
    <article class="resource-card">
      <div class="resource-label">程序内存</div>
      <div class="resource-value">${formatBytes(app.memory.rssBytes)}</div>
      <div class="subtle">Heap ${formatBytes(app.memory.heapUsedBytes)} / ${formatBytes(app.memory.heapTotalBytes)}</div>
    </article>
    <article class="resource-card">
      <div class="resource-label">程序流量</div>
      <div class="resource-value">${formatBytes(app.traffic.rxBytes)} / ${formatBytes(app.traffic.txBytes)}</div>
      <div class="subtle">HTTP 累计接收 / 发送 · ${app.traffic.httpRequests} 次请求</div>
    </article>
    <article class="resource-card">
      <div class="resource-label">运行时长</div>
      <div class="resource-value">${Math.floor(app.uptimeSeconds / 3600)} 小时</div>
      <div class="subtle">PID ${app.pid} · Node ${app.nodeVersion}</div>
    </article>
    <article class="resource-card resource-card-wide">
      <div class="resource-label">运行环境</div>
      <div class="resource-value">${escapeHtml(app.runtime.env)}</div>
      <div class="subtle">${escapeHtml(app.runtime.cwd)}</div>
      <div class="subtle">${app.runtime.containerized ? "容器环境" : "非容器环境"}</div>
    </article>
  `;
}

function renderRuntimeForm(settings) {
  qs("#runtimeForm").innerHTML = `
    <label><span>后台名称</span><input name="panelTitle" value="${escapeHtml(settings.panelTitle)}" /></label>
    <label><span>公网地址</span><input name="publicBaseUrl" value="${escapeHtml(settings.publicBaseUrl ?? "")}" /></label>
    <label><span>巡检间隔（秒）</span><input name="pollIntervalSeconds" type="number" min="5" value="${escapeHtml(settings.pollIntervalSeconds)}" /></label>
    <label><span>SSH 超时（秒）</span><input name="connectionTimeoutSeconds" type="number" min="5" value="${escapeHtml(settings.connectionTimeoutSeconds)}" /></label>
    <label><span>默认验证延迟（秒）</span><input name="defaultVerifyDelaySeconds" type="number" min="1" value="${escapeHtml(settings.defaultVerifyDelaySeconds)}" /></label>
    <label><span>会话时长（小时）</span><input name="sessionTtlHours" type="number" min="1" value="${escapeHtml(settings.sessionTtlHours)}" /></label>
    <label><span>事件保留数</span><input name="eventRetentionCount" type="number" min="50" value="${escapeHtml(settings.eventRetentionCount)}" /></label>
    <div class="inline-actions"><button id="saveRuntimeButton" class="button primary" type="button">保存平台设置</button></div>
  `;
}

function renderEmailForm(settings) {
  qs("#emailForm").innerHTML = `
    <label><span><input name="enabled" type="checkbox" ${settings.enabled ? "checked" : ""} /> 启用邮件通知</span></label>
    <label><span>SMTP Host</span><input name="smtpHost" value="${escapeHtml(settings.smtpHost ?? "")}" /></label>
    <label><span>SMTP Port</span><input name="smtpPort" type="number" value="${escapeHtml(settings.smtpPort ?? 587)}" /></label>
    <label><span><input name="smtpSecure" type="checkbox" ${settings.smtpSecure ? "checked" : ""} /> 启用 TLS</span></label>
    <label><span>SMTP 用户名</span><input name="smtpUser" value="${escapeHtml(settings.smtpUser ?? "")}" /></label>
    <label><span>SMTP 密码</span><input name="smtpPass" type="password" placeholder="留空则保持不变" /></label>
    <label><span>发件邮箱</span><input name="fromAddress" value="${escapeHtml(settings.fromAddress ?? "")}" /></label>
    <label><span>收件邮箱</span><textarea name="toAddresses">${escapeHtml((settings.toAddresses ?? []).join("\n"))}</textarea></label>
  `;
}

function renderGroupForm(dashboard, user) {
  const current = (dashboard.groups ?? []).find((item) => item.id === state.draft.groupId) ?? null;
  const tenantId = currentGroupTenantId(dashboard, user, current);
  const workspaceField = user.role === "super_admin"
    ? `<label><span>所属客户空间</span><select name="tenantId"><option value="">请选择客户空间</option>${workspaceOptions(dashboard)}</select></label>`
    : "";

  qs("#groupForm").innerHTML = `
    ${workspaceField}
    <label><span>分组名称</span><input name="name" value="${escapeHtml(current?.name ?? "")}" /></label>
    <label><span>分组说明</span><textarea name="notes">${escapeHtml(current?.notes ?? "")}</textarea></label>
  `;

  if (user.role === "super_admin") {
    const select = qs('#groupForm [name="tenantId"]');
    if (select) select.value = tenantId;
  }
}

function renderGroupList(dashboard, user) {
  const groups = dashboard.groups ?? [];
  qs("#groupCountBadge").textContent = `${groups.length} 个分组`;
  qs("#groupList").innerHTML = groups.length === 0
    ? '<div class="empty">当前还没有分组。</div>'
    : groups.map((group) => `
      <article class="list-row">
        <div class="status-pill status-healthy">分组</div>
        <div class="title">${escapeHtml(group.name)}</div>
        <div class="subtle">
          ${group.serverCount} 台服务器 · ${group.healthyStreamCount}/${group.streamCount} 路正常直播流
          ${user.role === "super_admin" ? `· ${escapeHtml(tenantNameById(dashboard, group.tenantId) || "未命名空间")}` : ""}
        </div>
        ${group.notes ? `<div class="subtle">${escapeHtml(group.notes)}</div>` : ""}
        <div class="card-actions">
          ${group.id ? `<button class="button ghost" data-action="edit-group" data-id="${escapeHtml(group.id)}">编辑</button>` : ""}
          ${group.id && group.name !== "Default" ? `<button class="button ghost" data-action="delete-group" data-id="${escapeHtml(group.id)}">删除</button>` : ""}
        </div>
      </article>
    `).join("");
}

function renderServerForm(dashboard, user) {
  const current = dashboard.servers.find((item) => item.id === state.draft.serverId) ?? null;
  const tenantId = currentServerTenantId(dashboard, user, current);
  const workspaceField = user.role === "super_admin"
    ? `<label><span>所属客户空间</span><select name="tenantId"><option value="">请选择客户空间</option>${workspaceOptions(dashboard)}</select></label>`
    : "";

  qs("#serverForm").innerHTML = `
    ${workspaceField}
    <label><span>服务器分组</span><select name="groupName">${groupOptions(dashboard, tenantId, current?.groupName ?? "Default")}</select></label>
    <label><span>服务器名称</span><input name="label" value="${escapeHtml(current?.label ?? "")}" /></label>
    <label><span>主机地址</span><input name="host" value="${escapeHtml(current?.host ?? "")}" /></label>
    <label><span>SSH 端口</span><input name="port" type="number" value="${escapeHtml(current?.port ?? 22)}" /></label>
    <label><span>SSH 用户名</span><input name="username" value="${escapeHtml(current?.username ?? "root")}" /></label>
    <label><span>SSH 密码</span><input name="password" type="password" placeholder="${current?.hasPassword ? "留空则保持不变" : ""}" /></label>
    <label><span><input name="enabled" type="checkbox" ${current ? (current.enabled ? "checked" : "") : "checked"} /> 启用服务器</span></label>
    <label><span>备注</span><textarea name="notes">${escapeHtml(current?.notes ?? "")}</textarea></label>
  `;

  if (user.role === "super_admin") {
    const select = qs('#serverForm [name="tenantId"]');
    if (select) select.value = tenantId;
  }

  const discoverButton = qs("#discoverServerStreamsButton");
  if (discoverButton) {
    discoverButton.classList.toggle("hidden", !current?.id);
    discoverButton.dataset.serverId = current?.id ?? "";
  }
}

function renderStreamForm(dashboard, user) {
  const current = dashboard.streams.find((item) => item.id === state.draft.streamId) ?? null;
  const tenantId = currentStreamTenantId(dashboard, user, current);
  const workspaceField = user.role === "super_admin"
    ? `<label><span>所属客户空间</span><select name="tenantId"><option value="">请选择客户空间</option>${workspaceOptions(dashboard)}</select></label>`
    : "";
  const candidateServers = dashboard.servers.filter((server) => !tenantId || server.tenantId === tenantId);
  const selectedServerId = current?.serverId ?? candidateServers[0]?.id ?? "";

  qs("#streamForm").innerHTML = `
    ${workspaceField}
    <label><span>所属服务器</span><select name="serverId"><option value="">请选择服务器</option>${serverOptions(dashboard, tenantId, selectedServerId)}</select></label>
    <label><span>直播流名称</span><input name="label" value="${escapeHtml(current?.label ?? "")}" /></label>
    <label><span>媒体文件名 / 路径</span><input name="sourcePath" value="${escapeHtml(current?.sourcePath ?? "")}" placeholder="/root/lbo2.mp4 或 lbo2.mp4" /></label>
    <label><span>YouTube 推流码</span><input name="streamKey" value="${escapeHtml(current?.streamKey ?? "")}" placeholder="r6ab-8cc4-g8sg-jduw-a1qm" /></label>
    <label><span>匹配关键字</span><textarea name="matchTerms">${escapeHtml((current?.matchTerms ?? []).join("\n"))}</textarea></label>
    <label><span>重启命令</span><textarea name="restartCommand">${escapeHtml(current?.restartCommand ?? "")}</textarea></label>
    <label><span>重启日志路径</span><input name="restartLogPath" value="${escapeHtml(current?.restartLogPath ?? "")}" /></label>
    <label><span>冷却时间（秒）</span><input name="cooldownSeconds" type="number" value="${escapeHtml(current?.cooldownSeconds ?? 60)}" /></label>
    <label><span>重启窗口（秒）</span><input name="restartWindowSeconds" type="number" value="${escapeHtml(current?.restartWindowSeconds ?? 300)}" /></label>
    <label><span>窗口内最大重启数</span><input name="maxRestartsInWindow" type="number" value="${escapeHtml(current?.maxRestartsInWindow ?? 3)}" /></label>
    <label><span>验证延迟（秒）</span><input name="verifyDelaySeconds" type="number" value="${escapeHtml(current?.verifyDelaySeconds ?? dashboard.runtimeSettings.defaultVerifyDelaySeconds)}" /></label>
    <label><span><input name="enabled" type="checkbox" ${current ? (current.enabled ? "checked" : "") : "checked"} /> 启用直播流</span></label>
  `;

  if (user.role === "super_admin") {
    const select = qs('#streamForm [name="tenantId"]');
    if (select) select.value = tenantId;
  }
}

function renderWorkspaceForm(dashboard) {
  const current = (dashboard.tenants ?? []).find((item) => item.id === state.draft.workspaceId) ?? null;
  qs("#workspaceForm").innerHTML = `
    <label><span>客户空间名称</span><input name="name" value="${escapeHtml(current?.name ?? "")}" /></label>
    <label><span>客户空间标识</span><input name="slug" value="${escapeHtml(current?.slug ?? "")}" /></label>
    <label><span>状态</span><select name="status"><option value="active">active</option><option value="disabled">disabled</option><option value="expired">expired</option></select></label>
    <label><span>到期时间</span><input name="expiresAt" value="${escapeHtml(current?.expiresAt ?? "")}" placeholder="2026-12-31T23:59:59Z" /></label>
    <label><span>最大账号数</span><input name="maxUsers" type="number" value="${escapeHtml(current?.maxUsers ?? 1)}" /></label>
    <label><span>最大服务器数</span><input name="maxServers" type="number" value="${escapeHtml(current?.maxServers ?? 20)}" /></label>
    <label><span>最大直播流数</span><input name="maxStreams" type="number" value="${escapeHtml(current?.maxStreams ?? 200)}" /></label>
    <label><span>备注</span><textarea name="notes">${escapeHtml(current?.notes ?? "")}</textarea></label>
  `;
  if (current?.status) qs('#workspaceForm [name="status"]').value = current.status;
}

function renderUserForm(dashboard) {
  qs("#userForm").innerHTML = `
    <label><span>登录账号</span><input name="username" /></label>
    <label><span>登录密码</span><input name="password" type="password" minlength="8" /></label>
    <label><span>角色</span><select name="role"><option value="tenant_admin">客户管理员</option><option value="operator">操作员</option></select></label>
    <label><span>所属客户空间</span><select name="tenantId"><option value="">请选择客户空间</option>${workspaceOptions(dashboard)}</select></label>
  `;
}

function renderRedeemCodeForm() {
  qs("#redeemCodeForm").innerHTML = `
    <label><span>自定义 CDK</span><input name="code" placeholder="仅单个生成时可填写" /></label>
    <label><span>生成数量</span><input name="quantity" type="number" min="1" max="100" value="1" /></label>
    <label><span>套餐名称</span><input name="label" value="VIP Standard" /></label>
    <label><span>有效天数</span><input name="durationDays" type="number" value="30" /></label>
    <label><span>最大账号数</span><input name="maxUsers" type="number" value="1" /></label>
    <label><span>最大服务器数</span><input name="maxServers" type="number" value="20" /></label>
    <label><span>最大直播流数</span><input name="maxStreams" type="number" value="200" /></label>
    <label><span>备注</span><textarea name="notes"></textarea></label>
  `;
}

function renderProblemLists(dashboard) {
  const badServers = dashboard.servers.filter((server) => server.enabled && server.connectionStatus !== "up");
  const badStreams = dashboard.streams.filter((stream) => stream.enabled && stream.status !== "healthy");

  qs("#problemServers").innerHTML = badServers.length === 0
    ? '<div class="empty">当前没有异常服务器。</div>'
    : badServers.map((server) => `
      <article class="list-row">
        <div class="status-pill ${statusClass(server.connectionStatus)}">${escapeHtml(statusLabel(server.connectionStatus))}</div>
        <div class="title">${escapeHtml(server.label)}</div>
        <div class="subtle">${escapeHtml(server.groupName)} · ${escapeHtml(server.host)}</div>
        <div class="subtle">${escapeHtml(server.lastError ?? "需要人工检查")}</div>
        <div class="card-actions"><button class="button ghost" data-action="edit-server" data-id="${escapeHtml(server.id)}">查看服务器</button></div>
      </article>
    `).join("");

  qs("#problemStreams").innerHTML = badStreams.length === 0
    ? '<div class="empty">当前没有异常直播流。</div>'
    : badStreams.map((stream) => `
      <article class="list-row">
        <div class="status-pill ${statusClass(stream.status)}">${escapeHtml(statusLabel(stream.status))}</div>
        <div class="title">${escapeHtml(stream.label)}</div>
        <div class="subtle">${escapeHtml(stream.serverLabel ?? "")}</div>
        ${streamIdentityHtml(stream)}
        <div class="subtle">${escapeHtml(stream.lastError ?? "需要优先恢复")}</div>
        <div class="card-actions">
          <button class="button ghost" data-action="recover-stream" data-id="${escapeHtml(stream.id)}">立即恢复</button>
          <button class="button ghost" data-action="edit-stream" data-id="${escapeHtml(stream.id)}">查看直播流</button>
        </div>
      </article>
    `).join("");
}

function renderServerList(dashboard) {
  qs("#serverCountBadge").textContent = `${dashboard.servers.length} 台服务器`;
  qs("#serverList").innerHTML = dashboard.servers.length === 0
    ? '<div class="empty">当前没有服务器配置。</div>'
    : dashboard.servers.map((server) => {
      const streams = dashboard.streams.filter((stream) => stream.serverId === server.id);
      const liveCount = streams.filter((stream) => stream.status === "healthy").length;
      return `
        <article class="list-row">
          <div class="status-pill ${statusClass(server.connectionStatus)}">${escapeHtml(statusLabel(server.connectionStatus))}</div>
          <div class="title">${escapeHtml(server.label)}</div>
          <div class="subtle">${escapeHtml(server.groupName)} · ${escapeHtml(server.host)}:${escapeHtml(server.port)} · ${escapeHtml(server.username)}</div>
          <div class="subtle">正在播 ${liveCount} / ${streams.length} · 最后巡检 ${escapeHtml(formatTime(server.lastCheckedAt))}</div>
          <div class="card-actions">
            <button class="button secondary" data-action="discover-server-streams" data-id="${escapeHtml(server.id)}">识别推流</button>
            <button class="button ghost" data-action="edit-server" data-id="${escapeHtml(server.id)}">编辑</button>
            <button class="button ghost" data-action="delete-server" data-id="${escapeHtml(server.id)}">删除</button>
          </div>
        </article>
      `;
    }).join("");
}

function renderStreamViews(dashboard) {
  const streams = filteredStreams(dashboard);
  qs("#streamCountBadge").textContent = `${streams.length} / ${dashboard.streams.length} 路直播流`;
  qs("#streamListBadge").textContent = state.filters.status === "all" && !state.filters.query ? "当前显示全部直播流" : "当前显示筛选结果";

  qs("#streamList").innerHTML = streams.length === 0
    ? '<div class="empty">没有符合筛选条件的直播流。</div>'
    : streams.map((stream) => `
      <article class="list-row">
        <div class="status-pill ${statusClass(stream.status)}">${escapeHtml(statusLabel(stream.status))}</div>
        <div class="title">${escapeHtml(stream.label)}</div>
        <div class="subtle">${escapeHtml(stream.serverLabel ?? "")} · 最近发现 ${escapeHtml(formatTime(stream.lastSeenAt))}</div>
        ${streamIdentityHtml(stream)}
        <div class="card-actions">
          <button class="button ghost" data-action="recover-stream" data-id="${escapeHtml(stream.id)}">恢复</button>
          <button class="button ghost" data-action="edit-stream" data-id="${escapeHtml(stream.id)}">编辑</button>
          <button class="button ghost" data-action="delete-stream" data-id="${escapeHtml(stream.id)}">删除</button>
        </div>
      </article>
    `).join("");

  qs("#streamMatrix").innerHTML = streams.length === 0
    ? '<div class="empty">没有符合筛选条件的直播流。</div>'
    : streams.map((stream) => `
      <article class="stream-card">
        <div class="status-pill ${statusClass(stream.status)}">${escapeHtml(statusLabel(stream.status))}</div>
        <div class="title">${escapeHtml(stream.label)}</div>
        <div class="subtle">${escapeHtml(stream.serverLabel ?? "")}</div>
        <div class="subtle">最后发现：${escapeHtml(formatTime(stream.lastSeenAt))}</div>
        ${streamIdentityHtml(stream)}
        <div class="card-actions">
          <button class="button ghost" data-action="recover-stream" data-id="${escapeHtml(stream.id)}">恢复</button>
          <button class="button ghost" data-action="edit-stream" data-id="${escapeHtml(stream.id)}">编辑</button>
        </div>
      </article>
    `).join("");
}

function buildExplorerGroups(dashboard) {
  const visibleStreams = filteredStreams(dashboard);
  const visibleStreamIds = new Set(visibleStreams.map((stream) => stream.id));
  const query = state.filters.query.trim().toLowerCase();
  const groups = new Map();

  for (const group of dashboard.groups ?? []) {
    groups.set(explorerGroupKey(group), { ...group, name: normalizeGroupName(group.name), servers: [] });
  }

  for (const server of dashboard.servers) {
    const allStreams = dashboard.streams.filter((stream) => stream.serverId === server.id);
    const matchedStreams = allStreams.filter((stream) => visibleStreamIds.has(stream.id));
    const serverMatchesQuery = !query || [
      server.label,
      server.host,
      server.groupName,
      ...allStreams.map((stream) => stream.label)
    ].join(" ").toLowerCase().includes(query);

    if ((query || state.filters.status !== "all") && !serverMatchesQuery && matchedStreams.length === 0) {
      continue;
    }

    const key = explorerGroupKey({ tenantId: server.tenantId, name: server.groupName });
    if (!groups.has(key)) {
      groups.set(key, {
        id: null,
        tenantId: server.tenantId,
        name: normalizeGroupName(server.groupName),
        notes: "",
        serverCount: 0,
        streamCount: 0,
        healthyStreamCount: 0,
        servers: []
      });
    }

    const group = groups.get(key);
    group.servers.push({
      ...server,
      allStreams,
      streams: (query || state.filters.status !== "all") ? matchedStreams : allStreams,
      healthyCount: allStreams.filter((stream) => stream.status === "healthy").length
    });
  }

  return [...groups.values()]
    .filter((group) => group.servers.length > 0 || (!query && state.filters.status === "all"))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

function renderExplorerToolbar(groups) {
  const buttons = [
    ["0", "仅分组"],
    ["1", "分组 + 服务器"],
    ["2", "完整展开"]
  ];
  qs("#explorerLevelToolbar").innerHTML = `
    <span class="badge">${groups.length} 个分组</span>
    ${buttons.map(([value, label]) => `
      <button class="toggle-chip" type="button" data-action="set-explorer-level" data-level="${value}" data-active="${String(Number(value) === state.explorerLevel)}">${label}</button>
    `).join("")}
  `;
}

function renderGroupExplorer(dashboard) {
  const groups = buildExplorerGroups(dashboard);
  renderExplorerToolbar(groups);
  qs("#groupExplorer").innerHTML = groups.length === 0
    ? '<div class="empty">当前没有分组数据。</div>'
    : groups.map((group) => {
      const groupKey = explorerGroupKey(group);
      const groupCollapsed = Boolean(state.collapsedGroups[groupKey]);
      const showServers = state.explorerLevel >= 1 && !groupCollapsed;
      return `
        <article class="explorer-group">
          <div class="explorer-head">
            <div class="explorer-main">
              <button class="toggle-icon" type="button" data-action="toggle-group" data-key="${escapeHtml(groupKey)}">${groupCollapsed ? "＋" : "－"}</button>
              <div>
                <div class="title">${escapeHtml(group.name)}</div>
                <div class="subtle">
                  ${group.servers.length} 台服务器 · ${group.healthyStreamCount}/${group.streamCount} 路正常直播流
                  ${group.notes ? `· ${escapeHtml(group.notes)}` : ""}
                </div>
              </div>
            </div>
            <div class="card-actions">
              ${state.session.role === "super_admin" ? `<span class="badge">${escapeHtml(tenantNameById(dashboard, group.tenantId) || "默认空间")}</span>` : ""}
              ${group.id ? `<button class="button ghost" data-action="edit-group" data-id="${escapeHtml(group.id)}">编辑分组</button>` : ""}
            </div>
          </div>
          ${state.explorerLevel < 1 ? "" : `
            <div class="explorer-body ${showServers ? "" : "hidden"}">
              ${group.servers.length === 0 ? '<div class="empty">该分组下暂无服务器。</div>' : group.servers.map((server) => {
                const serverCollapsed = Boolean(state.collapsedServers[server.id]);
                const showStreams = state.explorerLevel >= 2 && !serverCollapsed;
                return `
                  <article class="explorer-server">
                    <div class="explorer-head explorer-head-nested">
                      <div class="explorer-main">
                        <button class="toggle-icon" type="button" data-action="toggle-server" data-id="${escapeHtml(server.id)}">${serverCollapsed ? "＋" : "－"}</button>
                        <div>
                          <div class="title">${escapeHtml(server.label)}</div>
                          <div class="subtle">${escapeHtml(server.host)} · 正在播 ${server.healthyCount} / ${server.allStreams.length}</div>
                        </div>
                      </div>
                      <div class="card-actions">
                        <span class="status-pill ${statusClass(server.connectionStatus)}">${escapeHtml(statusLabel(server.connectionStatus))}</span>
                        <button class="button ghost" data-action="edit-server" data-id="${escapeHtml(server.id)}">查看服务器</button>
                      </div>
                    </div>
                    ${state.explorerLevel < 2 ? "" : `
                      <div class="explorer-body ${showStreams ? "" : "hidden"}">
                        ${server.streams.length === 0 ? '<div class="empty">该服务器下暂无符合条件的直播流。</div>' : server.streams.map((stream) => `
                          <article class="explorer-stream">
                            <div>
                              <div class="status-pill ${statusClass(stream.status)}">${escapeHtml(statusLabel(stream.status))}</div>
                              <div class="title">${escapeHtml(stream.label)}</div>
                              <div class="subtle">最后发现 ${escapeHtml(formatTime(stream.lastSeenAt))}</div>
                              ${streamIdentityHtml(stream)}
                            </div>
                            <div class="card-actions">
                              <button class="button ghost" data-action="recover-stream" data-id="${escapeHtml(stream.id)}">恢复</button>
                              <button class="button ghost" data-action="edit-stream" data-id="${escapeHtml(stream.id)}">编辑</button>
                            </div>
                          </article>
                        `).join("")}
                      </div>
                    `}
                  </article>
                `;
              }).join("")}
            </div>
          `}
        </article>
      `;
    }).join("");
}

function renderEvents(dashboard) {
  qs("#eventFeed").innerHTML = dashboard.events.length === 0
    ? '<div class="empty">最近没有事件记录。</div>'
    : dashboard.events.map((event) => `
      <article class="event-row">
        <div class="event-time">${escapeHtml(formatTime(event.at))}</div>
        <div class="status-pill ${statusClass(event.level === "info" ? "healthy" : event.level === "warn" ? "restarting" : "failed")}">${escapeHtml(event.type)}</div>
        <div class="subtle">${escapeHtml(event.message)}</div>
      </article>
    `).join("");
}

function renderSuperAdmin(dashboard, user) {
  const visible = user.role === "super_admin";
  if (!visible) return;

  renderRuntimeForm(dashboard.runtimeSettings);
  renderEmailForm(dashboard.emailSettings);
  renderWorkspaceForm(dashboard);
  renderUserForm(dashboard);
  renderRedeemCodeForm();

  qs("#workspaceList").innerHTML = (dashboard.tenants ?? []).length === 0
    ? '<div class="empty">当前没有客户空间。</div>'
    : (dashboard.tenants ?? []).map((item) => `
      <article class="list-row">
        <div class="status-pill ${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</div>
        <div class="title">${escapeHtml(item.name)}</div>
        <div class="subtle">${escapeHtml(item.slug)} · ${daysUntil(item.expiresAt)}</div>
        ${usageBars(item)}
        <div class="card-actions">
          <button class="button ghost" data-action="edit-workspace" data-id="${escapeHtml(item.id)}">编辑</button>
          <button class="button ghost" data-action="delete-workspace" data-id="${escapeHtml(item.id)}">删除</button>
        </div>
      </article>
    `).join("");

  qs("#userList").innerHTML = (dashboard.users ?? []).length === 0
    ? '<div class="empty">当前没有客户账号。</div>'
    : (dashboard.users ?? []).map((item) => `
      <article class="list-row">
        <div class="status-pill status-healthy">${escapeHtml(roleLabel(item.role))}</div>
        <div class="title">${escapeHtml(item.username)}</div>
        <div class="subtle">${escapeHtml(item.tenantName || "平台管理员")} · 最近登录 ${escapeHtml(formatTime(item.lastLoginAt))}</div>
        <div class="card-actions"><button class="button ghost" data-action="delete-user" data-id="${escapeHtml(item.id)}">删除</button></div>
      </article>
    `).join("");

  qs("#redeemCodeList").innerHTML = (dashboard.redeemCodes ?? []).length === 0
    ? '<div class="empty">当前没有 CDK。</div>'
    : (dashboard.redeemCodes ?? []).map((item) => `
      <article class="list-row">
        <div class="status-pill ${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</div>
        <div class="title">${escapeHtml(item.code)}</div>
        <div class="subtle">${escapeHtml(item.label)} · ${item.durationDays} 天 · ${escapeHtml(item.tenantName || "未使用")}</div>
      </article>
    `).join("");
}

function renderDashboard(payload) {
  state.session = payload.user;
  state.dashboard = payload.dashboard;
  const isSuper = payload.user.role === "super_admin";
  state.page = normalizePageForRole(payload.user.role, parseAppPage(payload.user.role));
  syncAppRoute(payload.user.role, state.page, true);

  setView("app", isSuper ? "super_admin" : "customer");
  qs("#authShell").classList.add("hidden");
  qs("#appShell").classList.remove("hidden");
  qs("#currentRoleBadge").textContent = roleLabel(payload.user.role);
  qs("#currentUserLabel").textContent = payload.user.username;
  qs("#heroEyebrow").textContent = isSuper ? "PLATFORM CONTROL" : "LIVE OPERATIONS";
  qs("#heroModeLabel").textContent = isSuper ? "PLATFORM ADMIN" : "CUSTOMER OPS";
  qs("#heroTitle").textContent = isSuper ? "平台总控制台" : `${payload.dashboard.workspace?.name ?? "客户空间"}运营台`;
  qs("#panelTitle").textContent = isSuper ? payload.dashboard.runtimeSettings.panelTitle : `${payload.dashboard.workspace?.name ?? "客户空间"}直播控制台`;
  qs("#heroSubtitle").textContent = isSuper
    ? "你只需要维护平台、CDK、客户空间和恢复策略，普通用户只会看到自己的分组数据。"
    : "先看异常列表，再按分组逐级展开服务器和直播流。";

  renderWorkspaceSnapshot(payload.dashboard, payload.user);
  renderMetrics(payload.dashboard, payload.user);
  renderRuntimeMetrics(payload.dashboard, payload.user);
  renderGroupForm(payload.dashboard, payload.user);
  renderGroupList(payload.dashboard, payload.user);
  renderServerForm(payload.dashboard, payload.user);
  renderStreamForm(payload.dashboard, payload.user);
  renderProblemLists(payload.dashboard);
  renderServerList(payload.dashboard);
  renderStreamViews(payload.dashboard);
  renderGroupExplorer(payload.dashboard);
  renderEvents(payload.dashboard);
  renderSuperAdmin(payload.dashboard, payload.user);
  renderSidebarNavigation(payload.user);
  applyPageVisibility(payload.user);
}

async function refreshAdmin() {
  renderDashboard(await api("/api/admin/state"));
}

function resetDrafts(type = "all") {
  if (type === "all" || type === "server") {
    state.draft.serverId = null;
    state.draft.serverTenantId = "";
  }
  if (type === "all" || type === "stream") {
    state.draft.streamId = null;
    state.draft.streamTenantId = "";
  }
  if (type === "all" || type === "workspace") {
    state.draft.workspaceId = null;
  }
  if (type === "all" || type === "group") {
    state.draft.groupId = null;
    state.draft.groupTenantId = "";
  }
}

async function initializeSession() {
  const session = await api("/api/auth/session");
  if (session.setup.setupRequired) return renderAuth(true);
  if (!session.authenticated) return renderAuth(false);
  await refreshAdmin();
}

async function submitLogin(form, mode) {
  const result = await api("/api/auth/login", { method: "POST", body: serializeForm(form) });
  const isSuper = result.user.role === "super_admin";
  if (mode === "admin" && !isSuper) {
    await api("/api/auth/logout", { method: "POST" });
    throw new Error("该账号不是超级管理员，请从普通用户入口登录。");
  }
  if (mode === "customer" && isSuper) {
    await api("/api/auth/logout", { method: "POST" });
    throw new Error("超级管理员请从管理入口登录。");
  }
  await refreshAdmin();
}

async function onActionClick(event) {
  const button = event.target instanceof Element ? event.target.closest("button[data-action]") : null;
  if (!button) return;
  const { action, id, key, level } = button.dataset;

  try {
    if (action === "edit-group") {
      const group = state.dashboard.groups.find((item) => item.id === id);
      if (!group) return;
      state.draft.groupId = id;
      state.draft.groupTenantId = group.tenantId ?? "";
      state.page = "groups";
      syncAppRoute(state.session.role, state.page);
      renderSidebarNavigation(state.session);
      applyPageVisibility(state.session);
      renderGroupForm(state.dashboard, state.session);
      return;
    }
    if (action === "delete-group") {
      await api(`/api/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
      resetDrafts("group");
      await refreshAdmin();
      return showToast("分组已删除");
    }
    if (action === "edit-server") {
      const server = state.dashboard.servers.find((item) => item.id === id);
      if (!server) return;
      state.draft.serverId = id;
      state.draft.serverTenantId = server.tenantId ?? "";
      state.page = "servers";
      syncAppRoute(state.session.role, state.page);
      renderSidebarNavigation(state.session);
      applyPageVisibility(state.session);
      renderServerForm(state.dashboard, state.session);
      return;
    }
    if (action === "delete-server") {
      await api(`/api/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
      resetDrafts("server");
      await refreshAdmin();
      return showToast("服务器已删除");
    }
    if (action === "discover-server-streams") {
      const result = await api(`/api/servers/${encodeURIComponent(id)}/import-live-streams`, { method: "POST" });
      state.page = "streams";
      syncAppRoute(state.session.role, state.page);
      await refreshAdmin();
      return showToast(result.message ?? "已完成推流识别");
    }
    if (action === "edit-stream") {
      const stream = state.dashboard.streams.find((item) => item.id === id);
      if (!stream) return;
      state.draft.streamId = id;
      state.draft.streamTenantId = stream.tenantId ?? "";
      state.page = "streams";
      syncAppRoute(state.session.role, state.page);
      renderSidebarNavigation(state.session);
      applyPageVisibility(state.session);
      renderStreamForm(state.dashboard, state.session);
      return;
    }
    if (action === "delete-stream") {
      await api(`/api/streams/${encodeURIComponent(id)}`, { method: "DELETE" });
      resetDrafts("stream");
      await refreshAdmin();
      return showToast("直播流已删除");
    }
    if (action === "recover-stream") {
      const result = await api(`/api/streams/${encodeURIComponent(id)}/recover`, { method: "POST" });
      await refreshAdmin();
      return showToast(result.message ?? "恢复请求已提交");
    }
    if (action === "edit-workspace") {
      state.draft.workspaceId = id;
      state.page = "workspaces";
      syncAppRoute(state.session.role, state.page);
      renderSidebarNavigation(state.session);
      applyPageVisibility(state.session);
      renderWorkspaceForm(state.dashboard);
      return;
    }
    if (action === "delete-workspace") {
      await api(`/api/tenants/${encodeURIComponent(id)}`, { method: "DELETE" });
      resetDrafts("workspace");
      await refreshAdmin();
      return showToast("客户空间已删除");
    }
    if (action === "delete-user") {
      await api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshAdmin();
      return showToast("账号已删除");
    }
    if (action === "toggle-group") {
      state.collapsedGroups[key] = !state.collapsedGroups[key];
      renderGroupExplorer(state.dashboard);
      return;
    }
    if (action === "toggle-server") {
      state.collapsedServers[id] = !state.collapsedServers[id];
      renderGroupExplorer(state.dashboard);
      return;
    }
    if (action === "set-explorer-level") {
      state.explorerLevel = Number(level);
      renderGroupExplorer(state.dashboard);
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindEvents() {
  document.addEventListener("click", onActionClick);
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-page-nav]") : null;
    if (!(target instanceof HTMLElement) || !state.session) return;
    const nextPage = normalizePageForRole(state.session.role, target.dataset.pageNav);
    state.page = nextPage;
    syncAppRoute(state.session.role, nextPage);
    renderSidebarNavigation(state.session);
    applyPageVisibility(state.session);
  });

  qs("#setupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/setup/bootstrap", { method: "POST", body: serializeForm(event.currentTarget) });
      event.currentTarget.reset();
      renderAuth(false);
      showToast("初始化完成，请从超级管理员入口登录");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  qs("#adminLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitLogin(event.currentTarget, "admin");
      showToast("已进入平台控制台");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  qs("#customerLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await submitLogin(event.currentTarget, "customer");
      showToast("已进入直播运营台");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  qs("#redeemForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/redeem", { method: "POST", body: serializeForm(event.currentTarget) });
      event.currentTarget.reset();
      showToast("开通成功，请从普通用户入口登录");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  qs("#logoutButton").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.session = null;
    state.dashboard = null;
    state.filters = { query: "", status: "all" };
    resetDrafts();
    renderAuth(false);
  });

  qs("#scanButton").addEventListener("click", async () => {
    try {
      const result = await api("/api/run-once", { method: "POST" });
      await refreshAdmin();
      showToast(result.message ?? "巡检已完成");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  qs("#passwordForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/account/password", { method: "POST", body: serializeForm(event.currentTarget) });
      event.currentTarget.reset();
      showToast("密码已更新");
    } catch (error) {
      showToast(error.message, true);
    }
  });

  qs("#matrixSearch").addEventListener("input", (event) => {
    state.filters.query = event.currentTarget.value;
    if (state.dashboard) {
      renderStreamViews(state.dashboard);
      renderGroupExplorer(state.dashboard);
    }
  });

  qs("#matrixStatusFilter").addEventListener("change", (event) => {
    state.filters.status = event.currentTarget.value;
    if (state.dashboard) {
      renderStreamViews(state.dashboard);
      renderGroupExplorer(state.dashboard);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !state.dashboard || !state.session) return;

    if (target.matches('#serverForm [name="tenantId"]')) {
      state.draft.serverTenantId = target.value;
      renderServerForm(state.dashboard, state.session);
    }
    if (target.matches('#streamForm [name="tenantId"]')) {
      state.draft.streamTenantId = target.value;
      renderStreamForm(state.dashboard, state.session);
    }
    if (target.matches('#groupForm [name="tenantId"]')) {
      state.draft.groupTenantId = target.value;
      renderGroupForm(state.dashboard, state.session);
    }
  });

  qs("#appShell").addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    try {
      if (target.id === "saveRuntimeButton") {
        await api("/api/settings/runtime", { method: "PUT", body: serializeForm(qs("#runtimeForm")) });
        await refreshAdmin();
        return showToast("平台设置已保存");
      }
      if (target.id === "saveEmailButton") {
        const form = qs("#emailForm");
        await api("/api/settings/email", {
          method: "PUT",
          body: {
            ...serializeForm(form),
            enabled: checkboxValue(form, "enabled"),
            smtpSecure: checkboxValue(form, "smtpSecure"),
            toAddresses: textareaLines(form, "toAddresses"),
            smtpPass: form.querySelector('[name="smtpPass"]').value
          }
        });
        await refreshAdmin();
        return showToast("邮件配置已保存");
      }
      if (target.id === "testEmailButton") {
        await api("/api/settings/email/test", { method: "POST" });
        return showToast("测试邮件已发送");
      }
      if (target.id === "saveGroupButton") {
        const form = qs("#groupForm");
        const path = state.draft.groupId ? `/api/groups/${encodeURIComponent(state.draft.groupId)}` : "/api/groups";
        await api(path, { method: state.draft.groupId ? "PUT" : "POST", body: serializeForm(form) });
        resetDrafts("group");
        await refreshAdmin();
        return showToast("分组已保存");
      }
      if (target.id === "resetGroupButton") {
        resetDrafts("group");
        renderGroupForm(state.dashboard, state.session);
        return;
      }
      if (target.id === "saveServerButton") {
        const form = qs("#serverForm");
        const path = state.draft.serverId ? `/api/servers/${encodeURIComponent(state.draft.serverId)}` : "/api/servers";
        await api(path, { method: state.draft.serverId ? "PUT" : "POST", body: { ...serializeForm(form), enabled: checkboxValue(form, "enabled") } });
        resetDrafts("server");
        await refreshAdmin();
        return showToast("服务器已保存");
      }
      if (target.id === "discoverServerStreamsButton") {
        const serverId = target.dataset.serverId || state.draft.serverId;
        if (!serverId) {
          throw new Error("请先保存服务器，再执行 SSH 识别。");
        }
        const result = await api(`/api/servers/${encodeURIComponent(serverId)}/import-live-streams`, { method: "POST" });
        state.page = "streams";
        syncAppRoute(state.session.role, state.page);
        await refreshAdmin();
        return showToast(result.message ?? "已完成推流识别");
      }
      if (target.id === "resetServerButton") {
        resetDrafts("server");
        renderServerForm(state.dashboard, state.session);
        return;
      }
      if (target.id === "saveStreamButton") {
        return showToast(await saveStreamFromForm());
      }
      if (target.id === "saveAndStartStreamButton") {
        return showToast(await saveStreamFromForm({ startAfterSave: true }));
      }
      if (target.id === "resetStreamButton") {
        resetDrafts("stream");
        renderStreamForm(state.dashboard, state.session);
        return;
      }
      if (target.id === "saveWorkspaceButton") {
        const path = state.draft.workspaceId ? `/api/tenants/${encodeURIComponent(state.draft.workspaceId)}` : "/api/tenants";
        await api(path, { method: state.draft.workspaceId ? "PUT" : "POST", body: serializeForm(qs("#workspaceForm")) });
        resetDrafts("workspace");
        await refreshAdmin();
        return showToast("客户空间已保存");
      }
      if (target.id === "resetWorkspaceButton") {
        resetDrafts("workspace");
        renderWorkspaceForm(state.dashboard);
        return;
      }
      if (target.id === "saveUserButton") {
        await api("/api/users", { method: "POST", body: serializeForm(qs("#userForm")) });
        qs("#userForm").reset();
        await refreshAdmin();
        return showToast("客户账号已创建");
      }
      if (target.id === "saveRedeemCodeButton") {
        const result = await api("/api/redeem-codes", { method: "POST", body: serializeForm(qs("#redeemCodeForm")) });
        qs("#redeemCodeForm").reset();
        await refreshAdmin();
        return showToast(`已生成 ${result.redeemCodes?.length ?? 0} 个 CDK`);
      }
    } catch (error) {
      showToast(error.message, true);
    }
  });

  window.addEventListener("popstate", () => {
    if (!state.session) return;
    state.page = normalizePageForRole(state.session.role, parseAppPage(state.session.role));
    renderSidebarNavigation(state.session);
    applyPageVisibility(state.session);
  });
}

bindEvents();
initializeSession().catch((error) => showToast(error.message, true));
setInterval(() => {
  if (state.session) {
    refreshAdmin().catch(console.error);
  }
}, 15000);
