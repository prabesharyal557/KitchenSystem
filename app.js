// @ts-check
(() => {
  "use strict";
  const app = document.getElementById("app"),
    workspace = document.body.dataset.role;
  const isAndroidApp = Boolean(window.Capacitor?.isNativePlatform?.());
  let apiBase = isAndroidApp ? (localStorage.getItem("sajilo-server-url") || "").replace(/\/$/, "") : "";
  // The tab stores only a selector; the authentication token remains HttpOnly.
  const newSessionScope = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  let sessionScope =
    sessionStorage.getItem("sajilo-session-scope") || newSessionScope();
  sessionStorage.setItem("sajilo-session-scope", sessionScope);
  const money = (n) =>
    "Rs. " +
    Number(n || 0).toLocaleString("en-NP", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const day = (date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kathmandu",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(date));
  const today = () => day(new Date()),
    month = () => today().slice(0, 7);
  const stamp = (value) =>
    new Date(value).toLocaleString("en-GB", {
      timeZone: "Asia/Kathmandu",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  let db,
    view =
      location.hash.slice(1) ||
      (workspace === "manager" ? "dashboard" : "tables");
  let period = "day",
    reportDate = today(),
    staffMonth = month(),
    category = "All",
    sort = "rank",
    cart = [],
    activeTable = null,
    busy = false,
    online = true,
    renderedDay = today(),
    generation = 0;
  let seenAlerts = new Set(),
    alertStorageKey = "",
    audioContext,
    latestAlertState;
  const orderAlerts = new Map();
  function initOrderAlerts() {
    if (!["waiter", "manager"].includes(workspace)) return;
    alertStorageKey = `sajilo-alerts:${db.user.id}:${workspace}`;
    try {
      seenAlerts = new Set(
        JSON.parse(sessionStorage.getItem(alertStorageKey) || "[]"),
      );
    } catch {
      seenAlerts = new Set();
    }
    const region = document.createElement("aside");
    region.className = "order-alerts";
    region.setAttribute("aria-label", "Order notifications");
    region.innerHTML = `<div class="alert-controls">${button("Enable sound & desktop alerts", "enable-alerts", "", true)}</div><div class="order-alert-list" aria-live="polite" aria-relevant="additions"></div>`;
    document.body.append(region);
    syncOrderAlerts(db, true);
  }
  async function enableOrderAlerts() {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) {
        audioContext ||= new Audio();
        await audioContext.resume();
      }
      if ("Notification" in window && Notification.permission === "default")
        await Notification.requestPermission();
      const sound = audioContext?.state === "running";
      const desktop =
        "Notification" in window && Notification.permission === "granted";
      toast(
        `${sound ? "Sound enabled. " : ""}${desktop ? "Desktop alerts enabled." : "Order notifications will appear inside the app."}`,
      );
      const control = document.querySelector('[data-action="enable-alerts"]');
      if (control)
        control.textContent = sound
          ? "Sound on · Enable desktop alerts"
          : "Enable sound & desktop alerts";
      if (control && sound && desktop)
        control.textContent = "Sound & desktop alerts on";
    } catch {
      toast(
        "Order notifications are active inside the app. Browser alerts could not be enabled.",
      );
    }
  }
  function chime() {
    if (audioContext?.state !== "running") return;
    try {
      const start = audioContext.currentTime;
      [660, 880].forEach((frequency, index) => {
        const tone = audioContext.createOscillator(),
          volume = audioContext.createGain();
        tone.frequency.value = frequency;
        volume.gain.setValueAtTime(0, start + index * 0.18);
        volume.gain.linearRampToValueAtTime(0.12, start + index * 0.18 + 0.02);
        volume.gain.exponentialRampToValueAtTime(
          0.001,
          start + index * 0.18 + 0.16,
        );
        tone.connect(volume);
        volume.connect(audioContext.destination);
        tone.start(start + index * 0.18);
        tone.stop(start + index * 0.18 + 0.17);
      });
    } catch {
      /* Visual alerts remain available when audio is blocked. */
    }
  }
  function syncOrderAlerts(state, initial = false) {
    if (!alertStorageKey) return;
    latestAlertState = state;
    // Completed bills from before sign-in are history, not new notifications.
    // Later polls still catch an order served and paid between two updates.
    if (initial) {
      for (const order of state.orders) {
        if (order.paid && order.status === "served")
          seenAlerts.add(`${order.id}:served`);
      }
    }
    const relevant = state.orders.filter((o) =>
      workspace === "manager"
        ? !o.paid && o.status === "new"
        : (!o.paid && o.status === "ready") ||
          (o.status === "served" &&
            o.servedAt &&
            Date.now() - Date.parse(o.servedAt) < 12 * 60 * 60 * 1000 &&
            o.servedById !== state.user.id),
    );
    const current = new Set(relevant.map((o) => `${o.id}:${o.status}`));
    for (const [key, alert] of orderAlerts) {
      if (!current.has(key)) {
        alert.element.remove();
        alert.desktop?.close();
        orderAlerts.delete(key);
      }
    }
    let added = false;
    for (const order of relevant) {
      const key = `${order.id}:${order.status}`;
      if (seenAlerts.has(key)) continue;
      seenAlerts.add(key);
      added = true;
      const title =
        workspace === "manager"
          ? "New order received"
          : order.status === "served"
            ? "Order marked served"
            : "Order ready to serve";
      const detail = `Table ${order.table} · #${order.id.slice(0, 6)} · ${order.items.map((i) => `${i.qty}× ${i.name}`).join(", ")}`;
      const element = document.createElement("section");
      element.className = "order-alert";
      element.innerHTML = `<strong>${title}</strong><p>${esc(detail)}</p><div class="actions">${button("View order", "alert-view", `data-key="${key}"`, true)}${button("Dismiss", "alert-dismiss", `data-key="${key}"`, true)}</div>`;
      document.querySelector(".order-alert-list").append(element);
      const alert = { element, order, desktop: null };
      orderAlerts.set(key, alert);
      if (
        document.hidden &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        try {
          alert.desktop = new Notification(title, { body: detail, tag: key });
          alert.desktop.onclick = () => {
            window.focus();
            openOrderAlert(key);
          };
        } catch {
          /* Some mobile browsers only support service-worker notifications. */
        }
      }
    }
    if (added) {
      chime();
      // Retain recent keys across reloads, scoped to this signed-in staff member.
      seenAlerts = new Set([...seenAlerts].slice(-2000));
      try {
        sessionStorage.setItem(
          alertStorageKey,
          JSON.stringify([...seenAlerts]),
        );
      } catch {}
    }
  }
  function dismissOrderAlert(key) {
    const alert = orderAlerts.get(key);
    alert?.element.remove();
    alert?.desktop?.close();
    orderAlerts.delete(key);
  }
  function openOrderAlert(key) {
    if (!orderAlerts.has(key)) return;
    db = latestAlertState;
    document.querySelector("dialog[open]")?.close();
    navigate(
      orderAlerts.get(key).order.status === "served" ? "history" : "orders",
    );
    dismissOrderAlert(key);
  }
  async function api(path, payload) {
    // A fresh login gets a new slot even when this tab was duplicated from another tab.
    const signingIn = path === "login";
    const scope = signingIn ? newSessionScope() : sessionScope;
    const response = await fetch(
      apiBase + "/api/" + path,
      payload === undefined
        ? {
            headers: { "X-Sajilo-Session": scope },
            credentials: isAndroidApp ? "include" : "same-origin",
          }
        : {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Sajilo-Session": scope,
            },
            credentials: isAndroidApp ? "include" : "same-origin",
            body: JSON.stringify(payload),
          },
    );
    const result = await response.json();
    if (!response.ok) {
      if (workspace && [401, 403].includes(response.status))
        location.href = "/?message=" + encodeURIComponent(result.error);
      throw new Error(result.error);
    }
    if (signingIn) {
      sessionScope = scope;
      sessionStorage.setItem("sajilo-session-scope", scope);
    }
    return result;
  }
  function toast(message) {
    document.querySelector(".toast")?.remove();
    const e = document.createElement("div");
    e.className = "toast";
    e.setAttribute("role", "status");
    e.textContent = message;
    document.body.append(e);
    setTimeout(() => e.remove(), 4500);
  }
  const button = (label, action, extra = "", light = false) =>
    `<button type="button" class="button ${light ? "light" : ""}" data-action="${action}" ${extra}>${label}</button>`;
  function field(label, name, value = "", type = "text", attrs = "") {
    return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
  }
  function select(label, name, options, value) {
    return `<label>${label}<select name="${name}" aria-label="${esc(label)}">${options
      .map((o) => {
        const [v, t] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(t)}</option>`;
      })
      .join("")}</select></label>`;
  }
  function metric(label, value, detail, target) {
    return `<button class="metric" data-action="navigate" data-view="${target}"><span class="label">${label}<span>↗</span></span><strong class="value">${value}</strong><span class="trend">${detail}</span></button>`;
  }
  function empty(message) {
    return `<div class="empty"><span>◇</span><p>${message}</p></div>`;
  }
  function page(title, subtitle, content, actions = "") {
    return `<main class="content"><section class="hero"><div><div class="eyebrow">${workspace === "manager" ? "RESTAURANT MANAGEMENT" : "SERVICE WORKSPACE"}</div><h1>${title}</h1><p class="sub">${subtitle}</p></div><div class="actions">${actions}</div></section>${content}</main>`;
  }
  function card(title, content, aside = "") {
    return `<section class="card"><div class="card-head"><h2>${title}</h2>${aside}</div><div class="card-body">${content}</div></section>`;
  }
  function nav() {
    const links =
      workspace === "manager"
        ? [
            ["dashboard", "◈", "Overview"],
            ["online", "◎", "Online orders"],
            ["tables", "▦", "Tables"],
            ["orders", "♨", "Active orders"],
            ["menu", "☷", "Food menu"],
            ["staff", "♙", "Staff & payroll"],
            ["sales", "↗", "Sales reports"],
            ["settings", "⚙", "Settings"],
          ]
        : [
            ["tables", "▦", "Tables"],
            ["order", "+", "Take order"],
            ["orders", "✓", "Ready to serve"],
            ["history", "◷", "Order history"],
          ];
    return `<aside class="sidebar"><a class="brand" href="#${workspace === "manager" ? "dashboard" : "tables"}">sajilo<span>●</span></a><div class="rest"><div class="restaurant-icon">H</div><div><b>${esc(db.settings.name)}</b><small>${esc(workspace)} workspace</small></div></div><div class="nav-label">WORKSPACE</div><nav>${links.map(([v, icon, label]) => `<button data-action="navigate" data-view="${v}" class="${view === v || (view === "completed" && v === "sales") ? "active" : ""}" ${view === v ? 'aria-current="page"' : ""} title="${label}" aria-label="${label}"><i>${icon}</i><span>${label}</span>${v === "online" ? "<small>SOON</small>" : ""}</button>`).join("")}</nav><div class="side-foot"><div class="open-state ${db.settings.open ? "" : "closed"}">● Restaurant ${db.settings.open ? "open" : "closed"}</div><div class="profile"><div class="avatar">${esc(db.user.name.charAt(0))}</div><div><b>${esc(db.user.name)}</b><small>${esc(db.user.role)}</small></div></div>${button("↪ Sign out", "logout", "", true)}</div></aside>`;
  }
  function render() {
    if (!db) return;
    renderedDay = today();
    const pages =
      workspace === "manager"
        ? {
            dashboard,
            tables,
            orders,
            menu: menuView,
            staff,
            sales,
            completed: sales,
            settings,
            online: onlinePage,
            order,
            history,
          }
        : { tables, order, history, orders };
    if (!pages[view]) view = workspace === "manager" ? "dashboard" : "tables";
    app.innerHTML = `<div class="app">${nav()}<div class="main"><header class="topbar"><span>Workspace <span class="slash">/</span> <b>${esc(view === "dashboard" ? "Overview" : view.charAt(0).toUpperCase() + view.slice(1))}</b></span><div class="top-actions"><span class="connection ${online ? "" : "offline"}">● ${online ? "Live · syncs every 4s" : "Connection lost · retrying"}</span><time>${new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Kathmandu", day: "numeric", month: "short", year: "numeric" })}</time></div></header>${pages[view]()}</div></div>`;
  }
  function salesFor(date) {
    return db.sales.filter((s) => day(s.createdAt) === date);
  }
  const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
  function topItems(rows) {
    const items = new Map();
    rows.forEach((s) =>
      s.items.forEach((i) => {
        const item = items.get(i.id) || { name: i.name, qty: 0, revenue: 0 };
        item.qty += i.qty;
        item.revenue += i.qty * i.price;
        items.set(i.id, item);
      }),
    );
    const best = [...items.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
    return best.length
      ? best
          .map(
            (i, index) =>
              `<div class="sale-row"><span class="rank">0${index + 1}</span><div class="grow"><b>${esc(i.name)}</b><small>${i.qty} sold</small></div><b>${money(i.revenue)}</b></div>`,
          )
          .join("")
      : empty("Best sellers appear after your first paid bill.");
  }
  function dashboard() {
    const rows = salesFor(today()),
      active = db.orders.filter((o) => !o.paid && o.status !== "served");
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today() + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 6 + i);
      return d.toISOString().slice(0, 10);
    });
    const values = days.map((d) => sum(salesFor(d), "total")),
      max = Math.max(...values, 1);
    return page(
      "Your restaurant, at a glance.",
      "Today’s service, sales and team — all in one place.",
      `<section class="metrics">${metric("TOTAL SALES · TODAY", money(sum(rows, "total")), "Explore day, week, month & year", "sales")}${metric("ACTIVE TABLES", `${db.tables.filter((t) => t.status === "busy").length}<em> / ${db.tables.length}</em>`, `${db.tables.filter((t) => t.status === "pending").length} reserved · Live floor status`, "tables")}${metric("ACTIVE ORDERS", active.length, "Track new, ready and served orders", "orders")}${metric("COMPLETED SALES", rows.length, "Paid bills · View period breakdown", "completed")}</section><div class="grid">${card("Sales over the last 7 days", `<div class="chart-total">${money(values.reduce((a, b) => a + b, 0))}<small>Total collected · includes tax</small></div><div class="chart">${values.map((v, i) => `<div class="chart-column"><span>${v ? money(v) : "—"}</span><svg class="chart-bar" viewBox="0 0 48 130" role="img" aria-label="${days[i]}: ${money(v)}"><rect x="10" y="0" width="28" height="130" rx="5" fill="#f1f5ea"/><rect x="10" y="${130 - Math.max(2, (v / max) * 130)}" width="28" height="${Math.max(2, (v / max) * 130)}" rx="4" fill="${i === 6 ? "#315f43" : "#bfd39f"}"/></svg><small>${new Date(days[i] + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })}</small></div>`).join("")}</div>`, '<span class="tag">LAST 7 DAYS</span>')}${card("Most selling items", topItems(rows), '<span class="tag">TODAY</span>')}</div><div class="grid lower">${card(
        "Live service",
        active
          .slice(0, 5)
          .map(
            (o) =>
              `<div class="sale-row"><div class="grow"><b>Table ${o.table}</b><small>#${o.id.slice(0, 6)} · ${stamp(o.createdAt)}</small></div><span class="status ${o.status}">${o.status}</span></div>`,
          )
          .join("") || empty("No active orders. Ready for the next guest."),
        button("View orders →", "navigate", 'data-view="orders"', true),
      )}${card("Team & operations", `<div class="sale-row"><span>Active staff accounts</span><b>${db.staff.filter((s) => s.active && s.role !== "kitchen").length}</b></div><div class="sale-row"><span>Tax on new bills</span><b>${db.settings.taxRate}%</b></div><div class="sale-row"><span>Restaurant status</span><span class="tag">${db.settings.open ? "OPEN" : "CLOSED"}</span></div>`, button("Settings", "navigate", 'data-view="settings"', true))}</div>`,
      button("+ Take an order", "start-order"),
    );
  }
  function range() {
    const date = new Date(reportDate + "T00:00:00Z");
    let start = new Date(date),
      end = new Date(date);
    if (period === "week") {
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
    }
    if (period === "month") {
      start.setUTCDate(1);
      end = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
      );
    }
    if (period === "year") {
      start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
      end = new Date(Date.UTC(date.getUTCFullYear(), 11, 31));
    }
    return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
  }
  function sales() {
    const [start, end] = range();
    const rows = db.sales.filter((s) => {
      const d = day(s.createdAt);
      return d >= start && d <= end;
    });
    const revenue = sum(rows, "subtotal"),
      cost = sum(rows, "cost");
    return page(
      view === "completed" ? "Completed sales" : "Sales & performance",
      "Every paid bill, connected to your restaurant. Reporting timezone: Nepal.",
      `<div class="filterbar"><div class="segments">${["day", "week", "month", "year"].map((p) => `<button data-action="period" data-period="${p}" class="${p === period ? "selected" : ""}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</div>${field("Period containing", "reportDate", reportDate, "date", "required")}<span class="sub">${start} → ${end}</span></div><section class="metrics">${metric("TOTAL COLLECTED", money(sum(rows, "total")), "Includes " + money(sum(rows, "tax")) + " tax", "sales")}${metric("NET SALES", money(revenue), "Sales excluding tax", "sales")}${metric("EST. GROSS PROFIT", money(revenue - cost), "Net sales minus recorded ingredient costs", "sales")}${metric("COMPLETED BILLS", rows.length, "Average bill " + money(rows.length ? sum(rows, "total") / rows.length : 0), "completed")}</section><div class="notice">Gross profit excludes salaries, rent and other expenses. Add accurate ingredient costs in Food menu; zero costs will overstate profit. Weeks start Monday.</div><div class="grid">${card("Payment history", rows.length ? `<div class="table-scroll"><table><thead><tr><th>Bill / time</th><th>Table</th><th>Method</th><th>Collected</th></tr></thead><tbody>${rows.map((s) => `<tr><td><b>#${s.id.slice(0, 8)}</b><small>${stamp(s.createdAt)}</small></td><td>${s.table}</td><td>${s.method}</td><td><b>${money(s.total)}</b></td></tr>`).join("")}</tbody></table></div>` : empty("No paid bills in this period."))}${card("Most selling items", topItems(rows))}</div>`,
    );
  }
  function tables() {
    return page(
      "A place for every guest.",
      "Available, busy or reserved — keep your dining room in sync.",
      `<div class="legend"><span>● ${db.tables.filter((t) => t.status === "available").length} Available</span><span>● ${db.tables.filter((t) => t.status === "busy").length} Busy</span><span>● ${db.tables.filter((t) => t.status === "pending").length} Pending / reserved</span></div><div class="table-grid">${db.tables.map((t) => `<article class="table ${t.status}"><div class="table-top"><span class="table-symbol">▦</span><span class="status ${t.status}">${t.status === "pending" ? "Reserved" : t.status}</span></div><h2>Table ${t.n}</h2><p class="sub">${t.seats} seats · Main floor</p><div class="table-actions">${workspace === "manager" ? button("Manage", "table-edit", `data-id="${t.n}"`, true) : ""}${button("Open table →", "table-open", `data-id="${t.n}"`, true)}</div></article>`).join("") || empty("Add your first table to start service.")}</div>`,
      workspace === "manager" ? button("+ Add table", "table-add") : "",
    );
  }
  function menuView() {
    const categories = [...new Set(db.menu.map((i) => i.category))].sort();
    const items = db.menu
      .filter((i) => category === "All" || i.category === category)
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : sort === "price"
            ? a.price - b.price
            : a.rank - b.rank || a.name.localeCompare(b.name),
      );
    const groups = [...new Set(items.map((i) => i.category))];
    return page(
      "Good food starts here.",
      "Organize categories, pricing, ingredient costs and availability.",
      `<div class="filterbar">${select("Category", "category", ["All", ...categories], category)}${select(
        "Sort items",
        "sort",
        [
          ["rank", "Custom position"],
          ["name", "Name A–Z"],
          ["price", "Price: low to high"],
        ],
        sort,
      )}<span class="sub">${items.length} items</span></div>${
        groups
          .map((group) =>
            card(
              esc(group),
              `<div class="menu-grid">${items
                .filter((i) => i.category === group)
                .map(
                  (i) =>
                    `<article class="menu-item"><div class="food-icon">${esc(group.charAt(0))}</div><div class="grow"><b>${esc(i.name)}</b><small>Cost ${money(i.cost)} · Position ${i.rank}</small><span class="status ${i.available ? "available" : "pending"}">${i.available ? "Available" : "Unavailable"}</span></div><div class="item-end"><b>${money(i.price)}</b>${button("Edit", "menu-edit", `data-id="${i.id}"`, true)}</div></article>`,
                )
                .join("")}</div>`,
            ),
          )
          .join("") || empty("No items in this category.")
      }`,
      button("+ Add menu item", "menu-add"),
    );
  }
  function staff() {
    return page(
      "Your team, taken care of.",
      "Manage access and record every salary payment or advance.",
      `<div class="filterbar">${field("Salary month", "staffMonth", staffMonth, "month", "required")}<span class="sub">Payments are allocated to the selected salary month.</span></div><div class="staff-grid">${db.staff
        .map((s) => {
          const paid = db.payments.filter(
              (p) => p.staffId === s.id && p.month === staffMonth,
            ),
            total = sum(paid, "amount"),
            advance = sum(
              paid.filter((p) => p.kind === "Advance"),
              "amount",
            );
          return `<article class="card staff-card"><div class="staff-heading"><div class="avatar">${esc(s.name.charAt(0))}</div><div class="grow"><h2>${esc(s.name)}</h2><small>${esc(s.role)} · @${esc(s.username)}</small></div><span class="status ${s.active ? "available" : "pending"}">${s.role === "kitchen" ? "Access removed" : s.active ? (!db.settings.open && s.role !== "manager" ? "Closed" : "Active") : "Suspended"}</span></div><div class="pay-summary"><div><small>Monthly salary</small><b>${money(s.salary)}</b></div><div><small>Paid (incl. advances)</small><b>${money(total)}</b></div><div><small>Advance included</small><b>${money(advance)}</b></div><div><small>${total > s.salary ? "Overpaid / credit" : "Remaining"}</small><b>${money(Math.abs(s.salary - total))}</b></div></div><div class="actions">${button("Manage access", "staff-edit", `data-id="${s.id}"`, true)}${button("Record payment", "staff-pay", `data-id="${s.id}"`)}</div></article>`;
        })
        .join(
          "",
        )}</div><div class="notice">Balances use the current monthly salary; salary changes affect displayed balances. Payment history retains its original amount and salary month. Passwords are never displayed; managers can set a new password.</div>${card(
        "Payment ledger · " + esc(staffMonth),
        db.payments
          .filter((p) => p.month === staffMonth)
          .map(
            (p) =>
              `<div class="sale-row"><div class="grow"><b>${esc(db.staff.find((s) => s.id === p.staffId)?.name || "Staff")} <span class="tag">${p.kind}</span></b><small>${stamp(p.createdAt)} · ${esc(p.note || "No note")}</small></div><b>${money(p.amount)}</b></div>`,
          )
          .join("") || empty("No salary payments recorded for this month."),
      )}`,
      button("+ Add staff", "staff-add"),
    );
  }
  function settings() {
    return page(
      "Make it yours.",
      "Manage restaurant access and the tax applied to unsettled bills.",
      card(
        "Restaurant settings",
        `<form data-form="settings" class="form-grid">${field("Restaurant name", "name", db.settings.name, "text", 'required maxlength="100"')}${field("Tax rate (%)", "taxRate", db.settings.taxRate, "number", 'required min="0" max="100" step="0.01"')}${select(
          "Restaurant access",
          "open",
          [
            ["true", "Open — staff can sign in"],
            ["false", "Closed — suspend staff sessions"],
          ],
          String(db.settings.open),
        )}<p class="sub">Closing signs out waiters. Managers keep access and can reopen the restaurant. Existing paid bills retain their original tax.</p><div class="form-error" role="alert"></div><button class="button" type="submit">Save settings</button></form>`,
      ),
    );
  }
  function onlinePage() {
    return page(
      "Online orders",
      "A new way to welcome your guests.",
      `<section class="coming-soon"><div class="coming-icon">◎</div><span class="tag">COMING SOON</span><h2>Your next table could be anywhere.</h2><p>Online ordering is on its way. For now, keep every in-house order running smoothly from your workspace.</p>${button("Back to overview", "navigate", 'data-view="dashboard"')}</section>`,
    );
  }
  function orders() {
    const statuses = workspace === "waiter" ? ["ready"] : ["new", "ready"];
    const awaiting = [
      ...new Set(
        db.orders
          .filter((o) => !o.paid && o.status === "served")
          .map((o) => o.table),
      ),
    ];
    return page(
      workspace === "waiter" ? "Ready to serve" : "Orders",
      workspace === "waiter"
        ? "Food is ready. Deliver it to the table, then mark it served."
        : "View incoming orders, mark them ready, then mark them served. Waiters are notified automatically.",
      '<div class="kitchen-orders simple-board">' +
        statuses
          .map((status) => {
            const rows = db.orders
              .filter(
                (o) =>
                  !o.paid &&
                  (status === "new"
                    ? ["new", "preparing"].includes(o.status)
                    : o.status === "ready"),
              )
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            return (
              '<section class="kanban stage-' +
              status +
              '"><div class="stage-heading"><div><span class="eyebrow">' +
              (status === "new" ? "01 · NEW ORDERS" : "02 · PICKUP") +
              "</span><h2>" +
              (status === "new" ? "New orders" : "Ready to serve") +
              '</h2></div><span class="stage-count">' +
              rows.length +
              '</span></div><div class="stage-tickets">' +
              (rows
                .map((o) => {
                  const action =
                    status === "new"
                      ? button(
                          "Mark ready to serve →",
                          "advance",
                          'data-id="' +
                            o.id +
                            '" data-status="' +
                            o.status +
                            '"',
                        )
                      : workspace === "waiter"
                        ? button(
                            "✓ Mark served",
                            "advance",
                            'data-id="' + o.id + '" data-status="ready"',
                          )
                        : '<div class="pickup-note">✓ Waiter notified · Awaiting service</div>';
                  return (
                    '<article class="korder ' +
                    status +
                    '"><div class="top"><div><b>Table ' +
                    o.table +
                    "</b><small>Order #" +
                    o.id.slice(0, 6) +
                    '</small></div><span class="status ' +
                    status +
                    '">' +
                    (status === "new" ? "To prepare" : "Ready") +
                    '</span></div><div class="body"><small>Ordered ' +
                    stamp(o.createdAt) +
                    "</small><ul>" +
                    o.items
                      .map(
                        (i) =>
                          "<li><b>" + i.qty + "×</b> " + esc(i.name) + "</li>",
                      )
                      .join("") +
                    "</ul>" +
                    action +
                    "</div></article>"
                  );
                })
                .join("") ||
                empty(
                  status === "new"
                    ? "No new orders. Incoming tickets will appear here."
                    : "No orders ready yet.",
                )) +
              "</div></section>"
            );
          })
          .join("") +
        "</div>" +
        (workspace === "manager" && awaiting.length
          ? card(
              "Served · collect payment",
              awaiting
                .map(
                  (n) =>
                    '<div class="sale-row"><b>Table ' +
                    n +
                    "</b>" +
                    button("View bill", "bill", 'data-id="' + n + '"', true) +
                    "</div>",
                )
                .join(""),
            )
          : ""),
    );
  }
  function history() {
    return page(
      "Order history",
      "All recorded tickets and their current status.",
      card(
        "Tickets",
        db.orders
          .map(
            (o) =>
              `<div class="sale-row"><div><b>Table ${o.table} · #${o.id.slice(0, 6)}</b><small>${stamp(o.createdAt)} · ${o.items.map((i) => esc(i.name) + " × " + i.qty).join(", ")}</small></div><span class="status">${o.paid ? "Paid" : o.status}</span></div>`,
          )
          .join("") || empty("No orders yet."),
      ),
    );
  }
  function order() {
    if (!activeTable)
      return page(
        "Take an order",
        "Select a table to begin.",
        button("Choose table", "navigate", 'data-view="tables"'),
      );
    const items = db.menu
      .filter((i) => i.available)
      .sort((a, b) => a.category.localeCompare(b.category) || a.rank - b.rank);
    return page(
      "Table " + activeTable,
      "Add items and send the order to your manager.",
      `<div class="order-layout">${card("Food & drinks", `<label>Find an item<input type="search" name="menuSearch" placeholder="Search food or category"></label><div class="items">${items.map((i) => `<button class="item" data-action="cart-add" data-id="${i.id}" data-search="${esc((i.name + " " + i.category).toLowerCase())}"><span><b>${esc(i.name)}</b><small>${esc(i.category)} · ${money(i.price)}</small></span><span class="plus">+</span></button>`).join("")}</div>`)}${card("Current batch", cart.map((i) => `<div class="ticket-row"><div class="grow"><b>${esc(i.name)}</b><small>${money(i.price)}</small></div><div class="qty">${button("−", "cart-minus", `data-id="${i.id}"`, true)}<b>${i.qty}</b>${button("+", "cart-add", `data-id="${i.id}"`, true)}</div></div>`).join("") + `<div class="sale-row"><b>Batch subtotal</b><b>${money(cart.reduce((a, i) => a + i.price * i.qty, 0))}</b></div><div class="stack">${button("Place order →", "send-order")}${button("View full table bill", "bill", `data-id="${activeTable}"`, true)}</div>`)}</div>`,
      button("Change table", "navigate", 'data-view="tables"', true),
    );
  }
  function modal(title, content) {
    document.querySelector("dialog")?.remove();
    const d = document.createElement("dialog");
    d.innerHTML = `<div class="modal-head"><h2>${title}</h2><button data-action="close" aria-label="Close dialog">×</button></div>${content}`;
    document.body.append(d);
    d.showModal();
  }
  function form(title, type, content, attrs = "", footer = "") {
    modal(
      title,
      `<form data-form="${type}" ${attrs} class="form-grid">${content}<div class="form-error" role="alert"></div><div class="actions"><button class="button" type="submit">Save</button>${button("Cancel", "close", "", true)}${footer}</div></form>`,
    );
  }
  function bill(n, selectedMethod = "") {
    const items = db.orders
      .filter((o) => o.table === n && !o.paid)
      .flatMap((o) => o.items);
    const subtotal =
        Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100,
      tax =
        Math.round(
          ((subtotal * db.settings.taxRate) / 100 + Number.EPSILON) * 100,
        ) / 100,
      total = Math.round((subtotal + tax) * 100) / 100;
    modal(
      "Table " + n + " · Bill",
      `<p class="sub">${esc(db.settings.name)} · All unpaid orders</p>${items.map((i) => `<div class="sale-row"><span>${i.qty}× ${esc(i.name)}</span><b>${money(i.price * i.qty)}</b></div>`).join("") || empty("No unpaid items.")}<div class="sale-row"><span>Subtotal</span><b>${money(subtotal)}</b></div><div class="sale-row"><span>Tax (${db.settings.taxRate}%)</span><b>${money(tax)}</b></div><div class="sale-row bill-total"><b>Total due</b><b>${money(total)}</b></div><p class="sub">Record payment only after collecting it. All orders must be served.</p><div class="methods">${["Cash", "QR", "Card"].map((method) => button(method, "payment-select", `data-id="${n}" data-method="${method}" data-total="${total}" ${items.length ? "" : "disabled"} aria-pressed="${selectedMethod === method}"`)).join("")}</div><div class="form-error" role="alert"></div>${selectedMethod ? `<section class="payment-confirm"><span class="eyebrow">CONFIRM PAYMENT</span><h3>${money(total)} <small>via ${selectedMethod}</small></h3><p>Confirm only after receiving the full amount from the guest.</p><div class="actions">${button("Confirm payment", "pay", `data-id="${n}" data-method="${selectedMethod}" data-total="${total}` + `"`)}${button("Back to bill", "bill", `data-id="${n}"`, true)}</div></section>` : ""}`,
    );
  }
  function menuForm(item = {}) {
    form(
      item.id ? "Edit menu item" : "Add menu item",
      "menu",
      `${field("Item name", "name", item.name, "text", 'required maxlength="100"')}${field("Category (e.g. Momo)", "category", item.category, "text", 'required maxlength="100" list="categories"')}<datalist id="categories">${[...new Set(db.menu.map((i) => i.category))].map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist><div class="form-pair">${field("Selling price (Rs.)", "price", item.price ?? "", "number", 'required min="0" step="0.01"')}${field("Ingredient cost (Rs.)", "cost", item.cost ?? "", "number", 'required min="0" step="0.01"')}</div>${field("Sort position", "rank", item.rank ?? db.menu.length, "number", 'required min="0" max="9999"')}${select(
        "Availability",
        "available",
        [
          ["true", "Available"],
          ["false", "Unavailable"],
        ],
        String(item.available ?? true),
      )}`,
      `data-id="${item.id || ""}"`,
      item.id
        ? button("Delete", "menu-delete", `data-id="${item.id}"`, true)
        : "",
    );
  }
  function staffForm(s = {}) {
    form(
      s.id ? "Manage staff account" : "Add staff account",
      "staff",
      `${field("Full name", "name", s.name, "text", 'required maxlength="100"')}${field("Username", "username", s.username, "text", 'required maxlength="40" autocomplete="off"')}${field(s.id ? "New password (leave blank to keep)" : "Password (12+ characters)", "password", "", "password", `${s.id ? "" : "required"} minlength="12" maxlength="128" autocomplete="new-password"`)}${select("Role", "role", ["waiter", "manager"], s.role === "manager" ? "manager" : "waiter")}${field("Monthly salary (Rs.)", "salary", s.salary ?? 0, "number", 'required min="0" step="0.01"')}${select(
        "Account status",
        "active",
        [
          ["true", "Active"],
          ["false", "Suspended"],
        ],
        String(s.active ?? true),
      )}`,
      `data-id="${s.id || ""}"`,
    );
  }
  async function act(action, payload, close = true) {
    if (busy) return false;
    busy = true;
    generation++;
    document
      .querySelectorAll("dialog button, form button")
      .forEach((b) => (b.disabled = true));
    try {
      db = await api("action", { action, payload });
      syncOrderAlerts(db);
      if (close) document.querySelector("dialog")?.close();
      render();
      toast("Saved successfully");
      return true;
    } finally {
      busy = false;
      document
        .querySelectorAll("dialog button, form button")
        .forEach((b) => (b.disabled = false));
    }
  }
  function navigate(v) {
    view = v;
    location.hash = v;
    render();
  }
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || busy) return;
    const { action, id } = el.dataset;
    try {
      if (action === "enable-alerts") await enableOrderAlerts();
      else if (action === "change-server") {
        localStorage.removeItem("sajilo-server-url");
        apiBase = "";
        location.reload();
      }
      else if (action === "alert-dismiss") dismissOrderAlert(el.dataset.key);
      else if (action === "alert-view") openOrderAlert(el.dataset.key);
      else if (action === "navigate") navigate(el.dataset.view);
      else if (action === "logout") {
        await api("logout", {});
        location.href = "/";
      } else if (action === "close") document.querySelector("dialog")?.close();
      else if (action === "period") {
        period = el.dataset.period;
        render();
      } else if (action === "start-order") navigate("tables");
      else if (action === "table-add")
        form(
          "Add a table",
          "table-add",
          field(
            "Table number",
            "n",
            Math.max(0, ...db.tables.map((t) => t.n)) + 1,
            "number",
            'required min="1" max="999" step="1"',
          ) +
            field(
              "Seats",
              "seats",
              4,
              "number",
              'required min="1" max="50" step="1"',
            ),
        );
      else if (action === "table-edit") {
        const t = db.tables.find((t) => t.n === Number(id));
        form(
          "Manage table " + id,
          "table-edit",
          select(
            "Table status",
            "status",
            [
              ["available", "Available"],
              ["busy", "Busy"],
              ["pending", "Pending / reserved for guests"],
            ],
            t.status,
          ),
          `data-id="${id}"`,
          button("Delete table", "table-delete", `data-id="${id}"`, true),
        );
      } else if (action === "table-delete") {
        if (confirm("Delete this table?"))
          await act("table.delete", { n: Number(id) });
      } else if (action === "table-open") {
        if (
          cart.length &&
          activeTable !== Number(id) &&
          !confirm("Discard the unsent items and switch tables?")
        )
          return;
        if (activeTable !== Number(id)) cart = [];
        activeTable = Number(id);
        navigate("order");
      } else if (action === "menu-add") menuForm();
      else if (action === "menu-edit")
        menuForm(db.menu.find((i) => i.id === id));
      else if (action === "menu-delete") {
        if (
          confirm(
            "Remove this item from the menu? Previous orders and sales will stay intact.",
          )
        )
          await act("menu.delete", { id });
      } else if (action === "staff-add") staffForm();
      else if (action === "staff-edit")
        staffForm(db.staff.find((s) => s.id === id));
      else if (action === "staff-pay")
        form(
          "Record payment · " + esc(db.staff.find((s) => s.id === id).name),
          "staff-pay",
          field(
            "Amount paid (Rs.)",
            "amount",
            "",
            "number",
            'required min="0.01" step="0.01"',
          ) +
            field(
              "Allocate to salary month",
              "month",
              staffMonth,
              "month",
              "required",
            ) +
            select("Payment type", "kind", ["Salary", "Advance"], "Salary") +
            field("Note / reference", "note", "", "text", 'maxlength="300"'),
          `data-id="${id}"`,
        );
      else if (action === "advance")
        await act("order.advance", { id, status: el.dataset.status });
      else if (action === "cart-add") {
        const i = db.menu.find((i) => i.id === id && i.available);
        if (!i) throw new Error("Item is no longer available.");
        const line = cart.find((i) => i.id === id);
        if (line) line.qty = Math.min(100, line.qty + 1);
        else cart.push({ ...i, qty: 1 });
        render();
      } else if (action === "cart-minus") {
        const i = cart.find((i) => i.id === id);
        i.qty--;
        cart = cart.filter((i) => i.qty > 0);
        render();
      } else if (action === "send-order") {
        if (!cart.length) throw new Error("Add items first.");
        if (
          await act("order.create", {
            table: activeTable,
            items: cart.map((i) => ({ id: i.id, qty: i.qty })),
          })
        ) {
          cart = [];
          render();
        }
      } else if (action === "bill") bill(Number(id));
      else if (action === "payment-select") bill(Number(id), el.dataset.method);
      else if (action === "pay") {
        await act("sale.pay", {
          table: Number(id),
          method: el.dataset.method,
          expectedTotal: Number(el.dataset.total),
        });
      }
    } catch (error) {
      const errorBox = document.querySelector("dialog[open] .form-error");
      if (errorBox) errorBox.textContent = error.message;
      else toast(error.message);
    }
  });
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (el.closest("form") || !el.value) return;
    if (el.name === "reportDate") reportDate = el.value;
    else if (el.name === "staffMonth") staffMonth = el.value;
    else if (el.name === "category") category = el.value;
    else if (el.name === "sort") sort = el.value;
    else return;
    render();
  });
  document.addEventListener("input", (e) => {
    if (e.target.name === "menuSearch")
      document
        .querySelectorAll("[data-search]")
        .forEach(
          (el) =>
            (el.hidden = !el.dataset.search.includes(
              e.target.value.toLowerCase(),
            )),
        );
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (!f.dataset.form) return;
    e.preventDefault();
    if (busy) return;
    const p = Object.fromEntries(new FormData(f));
    const type = f.dataset.form,
      id = f.dataset.id,
      errorBox = f.querySelector(".form-error");
    errorBox.textContent = "";
    try {
    if (type === "server") {
      try {
        const url = new URL(String(p.server));
        if (!/^https?:$/.test(url.protocol)) throw new Error("Use an http:// or https:// address.");
        apiBase = url.origin;
        await api("bootstrap");
        localStorage.setItem("sajilo-server-url", apiBase);
        location.reload();
      } catch (error) {
        apiBase = "";
        errorBox.textContent = error.message === "Failed to fetch" ? "Could not reach this server. Check the Wi‑Fi address and make sure npm run dev:lan is running." : error.message;
      }
    } else if (type === "login") {
        busy = true;
        f.querySelector('button[type="submit"]').disabled = true;
        try {
          const r = await api(type, p);
          location.href = "/" + r.user.role + ".html";
        } finally {
          busy = false;
          f.querySelector('button[type="submit"]').disabled = false;
        }
      } else if (type === "table-add")
        await act("table.add", { n: Number(p.n), seats: Number(p.seats) });
      else if (type === "table-edit")
        await act("table.update", { n: Number(id), status: p.status });
      else if (type === "menu")
        await act("menu.save", {
          ...p,
          id,
          price: Number(p.price),
          cost: Number(p.cost),
          rank: Number(p.rank),
          available: p.available === "true",
        });
      else if (type === "staff")
        await act("staff.save", {
          ...p,
          id,
          salary: Number(p.salary),
          active: p.active === "true",
        });
      else if (type === "staff-pay")
        await act("staff.payment", {
          ...p,
          staffId: id,
          amount: Number(p.amount),
        });
      else if (type === "settings")
        await act("settings.save", {
          ...p,
          open: p.open === "true",
          taxRate: Number(p.taxRate),
        });
    } catch (error) {
      errorBox.textContent = error.message;
    }
  });
  window.addEventListener("hashchange", () => {
    if (db) {
      view = location.hash.slice(1);
      render();
    }
  });
  async function init() {
    try {
      if (!workspace) {
        if (isAndroidApp && !apiBase) {
          app.innerHTML = `<main class="login-shell"><section class="login-intro"><div class="brand">sajilo<span>●</span></div><span class="eyebrow">RESTAURANT CONNECTION</span><h1>Connect your<br>restaurant.</h1><p>Enter the address of the computer running Sajilo on your restaurant Wi‑Fi.</p></section><section class="login-card"><span class="eyebrow">FIRST-TIME SETUP</span><h1>Where is your server?</h1><p class="sub">Example: <code>http://192.168.1.10:3000</code></p><form class="form-grid" data-form="server"><label>Restaurant server address<input name="server" type="url" inputmode="url" placeholder="http://192.168.1.10:3000" required></label><div class="form-error" role="alert"></div><button class="button" type="submit">Connect →</button></form><small>Your phone and restaurant computer must use the same Wi‑Fi.</small></section></main>`;
          return;
        }
        await api("bootstrap");
        app.innerHTML = `<main class="login-shell"><section class="login-intro"><div class="brand">sajilo<span>●</span></div><span class="eyebrow">A LITTLE SIMPLER. A LOT SMOOTHER.</span><h1>Great service<br>starts here.</h1><p>Your tables, team and orders.<br>One connected restaurant.</p><div class="login-art">▦ <span>♨</span> ◈</div></section><section class="login-card"><span class="eyebrow">YOUR RESTAURANT WORKSPACE</span><h1>Welcome back.</h1><p class="sub">Sign in with your individual staff account.</p><form class="form-grid" data-form="login">${field("Username", "username", "", "text", 'required autocomplete="username"')}${field("Password", "password", "", "password", 'required autocomplete="current-password" maxlength="128"')}<div class="form-error" role="alert">${esc(new URLSearchParams(location.search).get("message") || "")}</div><button class="button" type="submit">Sign in to workspace →</button></form><small>Need access or a password reset? Ask your manager.${isAndroidApp ? '<br><button type="button" class="link-button" data-action="change-server">Change restaurant server</button>' : ''}</small></section></main>`;
        return;
      }
      db = await api("state");
      if (db.user.role !== workspace) {
        location.href = "/" + db.user.role + ".html";
        return;
      }
      render();
      initOrderAlerts();
      setInterval(async () => {
        if (busy) return;
        const started = generation;
        try {
          const fresh = await api("state");
          if (started !== generation || busy) return;
          // Alerts must arrive even while staff type an order or keep a bill open.
          syncOrderAlerts(fresh);
          const changed = JSON.stringify(fresh) !== JSON.stringify(db),
            wasOffline = !online;
          online = true;
          if (
            document.querySelector("dialog[open]") ||
            ["INPUT", "SELECT", "TEXTAREA"].includes(
              document.activeElement?.tagName,
            )
          )
            return;
          db = fresh;
          if (changed || wasOffline || renderedDay !== today()) render();
        } catch {
          online = false;
          const c = document.querySelector(".connection");
          if (c) {
            c.textContent = "● Connection lost · retrying";
            c.classList.add("offline");
          }
        }
      }, 4000);
    } catch (error) {
      app.innerHTML = `<div class="startup-error"><h1>Unable to connect</h1><p>${esc(error.message)}</p><p>Start the Sajilo server with <code>npm start</code>, then open its address.</p></div>`;
    }
  }
  init();
})();
