// ==UserScript==
// @name         Support Intercom Interface
// @namespace    https://app.intercom.com
// @version      2.0.0
// @description  Personal queue health dashboard
// @author       joao@hipp.health, guilherme@hipp.health
// @match        https://app.intercom.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.intercom.io

// @updateURL    https://raw.githubusercontent.com/joao-hipp/intercom-support-tools/main/support-interface.meta.js
// @downloadURL  https://raw.githubusercontent.com/joao-hipp/intercom-support-tools/main/support-interface.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const STORAGE_TOKEN      = 'sii_token';
  const STORAGE_ADMIN_ID   = 'sii_admin_id';
  const STORAGE_ADMIN_NAME = 'sii_admin_name';
  const STORAGE_DISMISSED  = 'sii_dismissed';
  const STORAGE_REFRESH    = 'sii_refresh_mins';
  const DEFAULT_REFRESH_MINS = 30;
  const TWO_HOURS_S = 7200;
  const NOW_S = () => Math.floor(Date.now() / 1000);

  const TODAY_START_S = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  const WEEK_START_S = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return Math.floor(d.getTime() / 1000);
  })();

  const F_BACKLOG          = 'backlog';
  const F_SLA_BREACHED     = 'slaBreached';
  const F_SLA_WARNING      = 'slaWarning';
  const F_ASSIGNED_TODAY   = 'assignedToday';
  const F_ASSIGNED_WEEK    = 'assignedThisWeek';
  const F_REPLIED_TODAY    = 'repliedToday';
  const F_REPLIED_WEEK     = 'repliedThisWeek';
  const F_CLOSED_WEEK      = 'closedThisWeek';

  // Filters that support the dismiss feature
  const DISMISSABLE_FILTERS = new Set([F_BACKLOG, F_SLA_BREACHED, F_SLA_WARNING]);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const datasets = {
    [F_BACKLOG]: [], [F_ASSIGNED_TODAY]: [], [F_ASSIGNED_WEEK]: [],
    [F_REPLIED_TODAY]: [], [F_REPLIED_WEEK]: [], [F_CLOSED_WEEK]: [],
  };

  // Dismissed conversation IDs — persisted in localStorage so they survive modal close.
  // Cleared on every refresh so they re-enter normal filtering.
  let dismissedIds = new Set(JSON.parse(localStorage.getItem(STORAGE_DISMISSED) || '[]'));

  let currentAdminId   = localStorage.getItem(STORAGE_ADMIN_ID)   || null;
  let currentAdminName = localStorage.getItem(STORAGE_ADMIN_NAME) || null;
  let activeFilter  = F_BACKLOG;
  let sortMode      = 'sla_asc';
  let isLoading     = false;
  let lastLoadedAt  = 0;
  let debugMode     = false;

  function getRefreshMins() {
    const v = parseInt(localStorage.getItem(STORAGE_REFRESH), 10);
    return (v && v >= 1) ? v : DEFAULT_REFRESH_MINS;
  }

  function getStaleSecs() { return getRefreshMins() * 60; }

  function saveDismissed() {
    localStorage.setItem(STORAGE_DISMISSED, JSON.stringify([...dismissedIds]));
  }

  function clearDismissed() {
    dismissedIds = new Set();
    localStorage.removeItem(STORAGE_DISMISSED);
  }

  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  function getToken() { return localStorage.getItem(STORAGE_TOKEN) || ''; }

  function saveToken(t) {
    const v = t.trim();
    localStorage.setItem(STORAGE_TOKEN, v);
    return v;
  }

  function tryTokenFromStorage() {
    try {
      const raw = localStorage.getItem('ember_simple_auth-session');
      if (raw) {
        const d = JSON.parse(raw)?.authenticated;
        const t = d?.access_token || d?.token;
        if (t) return saveToken(t);
      }
    } catch (_) {}
    try {
      for (const k of ['intercom-access-token', 'access_token', 'intercom_token']) {
        const v = localStorage.getItem(k);
        if (v && v.length >= 20 && !v.startsWith('{')) return saveToken(v);
      }
    } catch (_) {}
    return null;
  }

  function setupTokenCapture() {
    try {
      const win = unsafeWindow;
      const origSetHeader = win.XMLHttpRequest.prototype.setRequestHeader;
      win.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (!getToken() && name.toLowerCase() === 'authorization' && value?.startsWith('Bearer ')) {
          saveToken(value.slice(7));
          onTokenCaptured();
        }
        return origSetHeader.apply(this, arguments);
      };
      const origFetch = win.fetch;
      win.fetch = function (input, init) {
        if (!getToken() && init?.headers) {
          const h = init.headers;
          const auth = typeof h.get === 'function'
            ? (h.get('authorization') || h.get('Authorization'))
            : (h['authorization'] || h['Authorization']);
          if (auth?.startsWith('Bearer ')) { saveToken(auth.slice(7)); onTokenCaptured(); }
        }
        return Reflect.apply(origFetch, this, arguments);
      };
    } catch (e) { console.warn('[SII] Could not set up token capture:', e); }
  }

  function onTokenCaptured() {
    if (document.getElementById('sii-waiting')) handleRefresh();
    document.getElementById('sii-btn')?.classList.add('ready');
  }

  // ---------------------------------------------------------------------------
  // Intercom API
  // ---------------------------------------------------------------------------

  function apiRequest({ method = 'GET', path, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: `https://api.intercom.io${path}`,
        headers: {
          Authorization: `Bearer ${getToken()}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Intercom-Version': '2.11',
        },
        data: body ? JSON.stringify(body) : undefined,
        onload(resp) {
          try {
            const data = JSON.parse(resp.responseText);
            if (resp.status >= 400) reject(new Error(data.errors?.[0]?.message || `HTTP ${resp.status}`));
            else resolve(data);
          } catch { reject(new Error('Failed to parse API response')); }
        },
        onerror() { reject(new Error('Network error')); },
      });
    });
  }

  async function ensureAdminInfo() {
    if (currentAdminId) return;
    const me = await apiRequest({ path: '/me' });
    currentAdminId   = String(me.id);
    currentAdminName = me.name || me.email || 'You';
    localStorage.setItem(STORAGE_ADMIN_ID,   currentAdminId);
    localStorage.setItem(STORAGE_ADMIN_NAME, currentAdminName);
  }

  async function fetchAllConvs(conditions) {
    const results = [];
    let cursor = null;
    const query = conditions.length === 1 ? conditions[0] : { operator: 'AND', value: conditions };
    do {
      const body = { query, pagination: { per_page: 150, ...(cursor ? { starting_after: cursor } : {}) } };
      const resp = await apiRequest({ method: 'POST', path: '/conversations/search', body });
      results.push(...(resp.data ?? resp.conversations ?? []));
      cursor = resp.pages?.next?.starting_after ?? null;
    } while (cursor);
    return results;
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  async function loadAllDatasets() {
    const adminId = parseInt(currentAdminId, 10);
    const [backlog, assignedThisWeek, repliedThisWeek, closedThisWeek] = await Promise.all([
      fetchAllConvs([
        { field: 'state', operator: '=', value: 'open' },
        { field: 'admin_assignee_id', operator: '=', value: adminId },
      ]),
      fetchAllConvs([
        { field: 'admin_assignee_id', operator: '=', value: adminId },
        { field: 'statistics.last_assignment_at', operator: '>=', value: WEEK_START_S },
      ]),
      fetchAllConvs([
        { field: 'admin_assignee_id', operator: '=', value: adminId },
        { field: 'statistics.last_admin_reply_at', operator: '>=', value: WEEK_START_S },
      ]),
      fetchAllConvs([
        { field: 'state', operator: '=', value: 'closed' },
        { field: 'admin_assignee_id', operator: '=', value: adminId },
        { field: 'statistics.last_close_at', operator: '>=', value: WEEK_START_S },
      ]),
    ]);
    datasets[F_BACKLOG]        = backlog;
    datasets[F_ASSIGNED_WEEK]  = assignedThisWeek;
    datasets[F_ASSIGNED_TODAY] = assignedThisWeek.filter(c => (c.statistics?.last_assignment_at ?? 0) >= TODAY_START_S);
    datasets[F_CLOSED_WEEK]    = closedThisWeek;
    datasets[F_REPLIED_WEEK]   = repliedThisWeek;
    datasets[F_REPLIED_TODAY]  = repliedThisWeek.filter(c => (c.statistics?.last_admin_reply_at ?? 0) >= TODAY_START_S);

    // Clear dismissed on refresh — fresh data means fresh state
    clearDismissed();

    if (debugMode) {
      console.group('[SII Debug] Dataset load complete');
      Object.entries(datasets).forEach(([k, v]) => console.log(`${k}: ${v.length}`));
      console.groupEnd();
    }
  }

  // ---------------------------------------------------------------------------
  // Active conversations & stats
  // ---------------------------------------------------------------------------

  function getActiveConversations() {
    const now = NOW_S();
    let convs;
    if (activeFilter === F_SLA_WARNING) {
      convs = datasets[F_BACKLOG].filter(c => {
        const sla = c.sla_applied;
        if (!sla || sla.sla_status !== 'active') return false;
        const rem = sla.next_breach_at - now;
        return rem > 0 && rem <= TWO_HOURS_S;
      });
    } else if (activeFilter === F_SLA_BREACHED) {
      convs = datasets[F_BACKLOG].filter(c => c.sla_applied?.sla_status === 'missed');
    } else {
      convs = datasets[activeFilter] ?? datasets[F_BACKLOG];
    }
    return sortConvs(convs);
  }

  function sortConvs(convs) {
    const now = NOW_S();
    return convs.slice().sort((a, b) => {
      if (sortMode === 'created_asc')  return a.created_at - b.created_at;
      if (sortMode === 'created_desc') return b.created_at - a.created_at;
      if (sortMode === 'updated_asc')  return (a.updated_at ?? 0) - (b.updated_at ?? 0);
      if (sortMode === 'updated_desc') return (b.updated_at ?? 0) - (a.updated_at ?? 0);
      const slaOrd = c => {
        const sla = c.sla_applied;
        if (!sla) return Infinity;
        if (sla.sla_status === 'missed') return -Infinity;
        return sla.next_breach_at ? sla.next_breach_at - now : Infinity;
      };
      const diff = slaOrd(a) - slaOrd(b);
      return sortMode === 'sla_desc' ? -diff : diff;
    });
  }

  function getStats() {
    const now = NOW_S(), backlog = datasets[F_BACKLOG];
    return {
      [F_BACKLOG]: backlog.length,
      [F_SLA_BREACHED]: backlog.filter(c => c.sla_applied?.sla_status === 'missed').length,
      [F_SLA_WARNING]: backlog.filter(c => {
        const sla = c.sla_applied;
        if (!sla || sla.sla_status !== 'active') return false;
        return (sla.next_breach_at - now) > 0 && (sla.next_breach_at - now) <= TWO_HOURS_S;
      }).length,
      [F_ASSIGNED_TODAY]: datasets[F_ASSIGNED_TODAY].length,
      [F_ASSIGNED_WEEK]:  datasets[F_ASSIGNED_WEEK].length,
      [F_REPLIED_TODAY]:  datasets[F_REPLIED_TODAY].length,
      [F_REPLIED_WEEK]:   datasets[F_REPLIED_WEEK].length,
      [F_CLOSED_WEEK]:    datasets[F_CLOSED_WEEK].length,
    };
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function fmtSla(conv) {
    const sla = conv.sla_applied, now = NOW_S();
    if (!sla) return { label: 'No SLA', cls: 'none' };
    if (sla.sla_status === 'missed') {
      const over = sla.next_breach_at ? fmtDur(now - sla.next_breach_at) : null;
      return { label: over ? `Breached ${over} ago` : 'Breached', cls: 'breached' };
    }
    if (sla.sla_status === 'hit')       return { label: 'Met', cls: 'ok' };
    if (sla.sla_status === 'cancelled') return { label: 'Cancelled', cls: 'none' };
    if (sla.next_breach_at) {
      const rem = sla.next_breach_at - now;
      if (rem <= 0) return { label: 'Breached', cls: 'breached' };
      return { label: fmtDur(rem), cls: rem <= TWO_HOURS_S ? 'warning' : 'ok' };
    }
    return { label: 'Active', cls: 'ok' };
  }

  function fmtDur(s) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  function getSubject(conv) {
    return conv.source?.subject || conv.source?.body?.replace(/<[^>]+>/g, '').trim().slice(0, 80) || '(no subject)';
  }

  function filterLabel(key) {
    const labels = {
      [F_BACKLOG]: 'Backlog', [F_SLA_BREACHED]: 'SLA Breached', [F_SLA_WARNING]: 'SLA Warning',
      [F_ASSIGNED_TODAY]: 'Assigned to Me Today', [F_ASSIGNED_WEEK]: 'Assigned to Me This Week',
      [F_REPLIED_TODAY]: 'Replied Today', [F_REPLIED_WEEK]: 'Replied This Week',
      [F_CLOSED_WEEK]: 'Closed This Week',
    };
    return labels[key] || key;
  }

  // ---------------------------------------------------------------------------
  // DOM helper
  // ---------------------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
    #sii-btn {
      position: fixed; bottom: 10%; right: 1.5em; z-index: 99998;
      background: #1f73b7; color: #fff; border: none; border-radius: 7px;
      padding: 7px 13px; font-size: 12px; font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      display: flex; align-items: center; gap: 6px;
      transition: background 0.15s;
    }
    #sii-btn:hover { background: #1a5f9a; }
    #sii-btn .sii-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #f59e0b;
      flex-shrink: 0; position: absolute; top: 4px; right: 4px;
    }
    #sii-btn.ready .sii-dot { background: #4caf50; }

    #sii-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    #sii-modal {
      background: #fff; border-radius: 12px;
      width: 94vw; max-width: 1100px; max-height: 88vh;
      display: flex; flex-direction: column;
      box-shadow: 0 24px 64px rgba(0,0,0,0.22); overflow: hidden;
    }

    #sii-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 15px 22px; border-bottom: 1px solid #e8eaed; flex-shrink: 0;
    }
    .sii-title { display: flex; align-items: center; gap: 10px; }
    .sii-title h2 { margin: 0; font-size: 15px; font-weight: 700; color: #1a1a1a; }
    .sii-admin-chip {
      background: #edf4fb; color: #1f73b7; border-radius: 99px;
      padding: 2px 9px; font-size: 11px; font-weight: 600;
    }
    .sii-header-right { display: flex; align-items: center; gap: 6px; }
    .sii-icon-btn {
      background: none; border: 1px solid #e0e0e0; border-radius: 6px;
      padding: 5px 10px; cursor: pointer; font-size: 12px; color: #555;
      transition: all 0.1s;
    }
    .sii-icon-btn:hover { background: #f4f5f7; border-color: #bbb; }

    #sii-stats {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
      padding: 16px 22px; border-bottom: 1px solid #e8eaed; flex-shrink: 0;
    }
    .sii-stat-card {
      background: #f8f9fb; border-radius: 9px; padding: 11px 14px;
      cursor: pointer; border: 2px solid transparent;
      transition: border-color 0.15s, background 0.15s;
    }
    .sii-stat-card:hover  { border-color: #d0dce8; }
    .sii-stat-card.active { border-color: #1f73b7; background: #f0f7ff; }
    .sii-stat-card.warning               { background: #fff8e6; }
    .sii-stat-card.warning.active        { background: #fff3d0; border-color: #f59e0b; }
    .sii-stat-card.danger                { background: #fef0f0; }
    .sii-stat-card.danger.active         { background: #fde0e0; border-color: #e53e3e; }
    .sii-stat-card.info                  { background: #e8f4fd; }
    .sii-stat-card.info.active           { background: #d8ecfa; border-color: #1f73b7; }
    .sii-stat-card.green                 { background: #e8f5e9; }
    .sii-stat-card.green.active          { background: #d4edda; border-color: #2e7d32; }
    .sii-stat-card.purple                { background: #f3e8fd; }
    .sii-stat-card.purple.active         { background: #e8d5fa; border-color: #7b1fa2; }
    .sii-stat-label { font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
    .sii-stat-value { font-size: 26px; font-weight: 700; color: #1a1a1a; line-height: 1; }
    .sii-stat-card.warning .sii-stat-value { color: #b76e00; }
    .sii-stat-card.danger  .sii-stat-value { color: #c0392b; }
    .sii-stat-card.info    .sii-stat-value { color: #1565c0; }
    .sii-stat-card.green   .sii-stat-value { color: #2e7d32; }
    .sii-stat-card.purple  .sii-stat-value { color: #7b1fa2; }
    .sii-stat-sub { font-size: 10px; color: #bbb; margin-top: 3px; }

    .sii-stat-card.sii-loading { position: relative; overflow: hidden; pointer-events: none; }
    .sii-stat-card.sii-loading::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 40%, rgba(255,255,255,0.5) 60%, transparent 100%);
      animation: sii-shimmer 1.5s ease-in-out infinite;
    }
    @keyframes sii-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    .sii-stat-card.sii-loading .sii-stat-value { color: #ccc !important; }

    #sii-controls {
      display: flex; align-items: center; gap: 8px; padding: 10px 22px;
      border-bottom: 1px solid #e8eaed; flex-shrink: 0; flex-wrap: wrap;
    }
    .sii-ctrl-label { font-size: 11px; color: #999; font-weight: 600; }
    .sii-tab-group  { display: flex; gap: 3px; }
    .sii-tab {
      background: none; border: 1px solid #e0e0e0; border-radius: 5px;
      padding: 4px 10px; font-size: 12px; font-weight: 500; color: #555;
      cursor: pointer; transition: all 0.1s;
    }
    .sii-tab:hover  { background: #f4f5f7; }
    .sii-tab.active { background: #1f73b7; color: #fff; border-color: #1f73b7; }
    .sii-sep { width: 1px; height: 18px; background: #e0e0e0; margin: 0 4px; }
    #sii-active-label {
      font-size: 11px; color: #1f73b7; font-weight: 600;
      background: #edf4fb; border-radius: 4px; padding: 3px 9px;
    }

    #sii-body { overflow-y: auto; flex: 1; min-height: 0; }

    .sii-table { width: 100%; border-collapse: collapse; }
    .sii-table thead th {
      position: sticky; top: 0; background: #f8f9fb; padding: 9px 15px;
      text-align: left; font-size: 10px; font-weight: 700; color: #999;
      text-transform: uppercase; letter-spacing: 0.5px;
      border-bottom: 1px solid #e8eaed; white-space: nowrap;
    }
    .sii-row { border-bottom: 1px solid #f2f2f2; cursor: pointer; transition: background 0.08s; }
    .sii-row:hover { background: #f8f9fb; }
    .sii-row td { padding: 10px 15px; font-size: 13px; color: #333; vertical-align: middle; }
    .sii-conv-id { font-family: monospace; font-size: 11px; color: #1f73b7; text-decoration: none; font-weight: 700; }
    .sii-conv-id:hover { text-decoration: underline; }
    .sii-subject { color: #666; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; font-size: 12px; }
    .sii-badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 700; white-space: nowrap; }
    .sii-badge.ok       { background: #e8f5e9; color: #2e7d32; }
    .sii-badge.warning  { background: #fff8e6; color: #b76e00; }
    .sii-badge.breached { background: #fef0f0; color: #c0392b; }
    .sii-badge.none     { background: #f0f0f0; color: #aaa; }
    .sii-ts { font-size: 11px; color: #aaa; white-space: nowrap; }

    /* Dismiss button */
    .sii-dismiss-btn {
      background: none; border: 1px solid #e0e0e0; border-radius: 5px;
      padding: 3px 8px; font-size: 11px; color: #999; cursor: pointer;
      transition: all 0.1s; white-space: nowrap;
    }
    .sii-dismiss-btn:hover { background: #f4f5f7; border-color: #bbb; color: #555; }

    /* Restore button in dismissed section */
    .sii-restore-btn {
      background: none; border: 1px solid #d0dce8; border-radius: 5px;
      padding: 3px 8px; font-size: 11px; color: #1f73b7; cursor: pointer;
      transition: all 0.1s; white-space: nowrap;
    }
    .sii-restore-btn:hover { background: #edf4fb; border-color: #1f73b7; }

    /* Dismissed section */
    .sii-dismissed-header {
      padding: 10px 15px; font-size: 11px; font-weight: 700; color: #bbb;
      text-transform: uppercase; letter-spacing: 0.5px;
      background: #fafafa; border-top: 2px solid #e8eaed;
      border-bottom: 1px solid #e8eaed;
    }
    .sii-row.dismissed td { color: #ccc; }
    .sii-row.dismissed .sii-conv-id { color: #bbb; }
    .sii-row.dismissed .sii-subject { color: #ccc; }
    .sii-row.dismissed .sii-badge { opacity: 0.4; }
    .sii-row.dismissed .sii-ts { color: #ddd; }
    .sii-row.dismissed:hover { background: #fcfcfc; }

    #sii-empty, #sii-loading, #sii-waiting {
      padding: 44px; text-align: center; color: #aaa; font-size: 13px;
      display: flex; flex-direction: column; align-items: center; gap: 10px;
    }
    .sii-spinner { width: 26px; height: 26px; border: 3px solid #e0e0e0; border-top-color: #1f73b7; border-radius: 50%; animation: sii-spin 0.7s linear infinite; }
    @keyframes sii-spin { to { transform: rotate(360deg); } }
    .sii-waiting-hint { font-size: 12px; color: #bbb; }
    .sii-loading-sub  { font-size: 11px; color: #ccc; }

    #sii-settings { padding: 24px 22px; display: flex; flex-direction: column; gap: 12px; max-width: 480px; }
    #sii-settings h3 { margin: 0; font-size: 14px; font-weight: 700; color: #1a1a1a; }
    #sii-settings p  { margin: 0; font-size: 12px; color: #777; line-height: 1.6; }
    #sii-settings input {
      padding: 8px 11px; border: 1px solid #d0d0d0; border-radius: 6px;
      font-size: 13px; font-family: monospace; box-sizing: border-box; outline: none; width: 100%;
    }
    #sii-settings input:focus { border-color: #1f73b7; }
    .sii-save-btn { background: #1f73b7; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; align-self: flex-start; }
    .sii-save-btn:hover { background: #1a5f9a; }
    .sii-danger-btn { background: none; border: 1px solid #e0e0e0; border-radius: 6px; padding: 8px 16px; font-size: 12px; color: #c0392b; cursor: pointer; }
    .sii-danger-btn:hover { background: #fef0f0; }

    #sii-footer { padding: 8px 22px; border-top: 1px solid #e8eaed; font-size: 11px; color: #ccc; text-align: right; flex-shrink: 0; }
  `;

  // ---------------------------------------------------------------------------
  // Render — stats
  // ---------------------------------------------------------------------------

  function renderStats(stats, loading = false) {
    const container = document.getElementById('sii-stats');
    if (!container) return;
    container.innerHTML = '';
    const first = currentAdminName ? currentAdminName.split(' ')[0] : null;
    const cards = [
      { key: F_BACKLOG, label: first ? `${first}'s Backlog` : 'Backlog', sub: 'open conversations', cls: '' },
      { key: F_SLA_BREACHED, label: 'SLA Breached', sub: 'past deadline', cls: 'danger' },
      { key: F_SLA_WARNING, label: 'SLA Warning', sub: '< 2h remaining', cls: 'warning' },
      { key: F_ASSIGNED_TODAY, label: 'Assigned Today', sub: 'new assignments', cls: 'info' },
      { key: F_ASSIGNED_WEEK, label: 'Assigned This Week', sub: 'since Sunday', cls: 'info' },
      { key: F_REPLIED_TODAY, label: 'Replied Today', sub: 'my replies only', cls: 'green' },
      { key: F_REPLIED_WEEK, label: 'Replied This Week', sub: 'since Sunday', cls: 'green' },
      { key: F_CLOSED_WEEK, label: 'Closed This Week', sub: 'since Sunday', cls: 'purple' },
    ];
    for (const c of cards) {
      const isActive = activeFilter === c.key;
      const card = el('div', {
        className: `sii-stat-card ${c.cls}${isActive ? ' active' : ''}${loading ? ' sii-loading' : ''}`,
        onClick: () => setActiveFilter(c.key),
      },
        el('div', { className: 'sii-stat-label' }, c.label),
        el('div', { className: 'sii-stat-value' }, loading ? '…' : String(stats[c.key] ?? 0)),
        el('div', { className: 'sii-stat-sub' }, c.sub),
      );
      card.dataset.statKey = c.key;
      container.append(card);
    }
  }

  function setActiveFilter(key) {
    activeFilter = key;
    document.querySelectorAll('.sii-stat-card').forEach(c => c.classList.toggle('active', c.dataset.statKey === key));
    const label = document.getElementById('sii-active-label');
    if (label) label.textContent = filterLabel(key);
    const convs = getActiveConversations();
    renderList(convs);
    renderFooter(convs);
  }

  // ---------------------------------------------------------------------------
  // Render — list (with dismiss/restore support)
  // ---------------------------------------------------------------------------

  function buildRow(conv, isDismissed) {
    const sla = fmtSla(conv);
    const href = `https://app.intercom.com/a/inbox/_/inbox/conversation/${conv.id}`;
    const canDismiss = DISMISSABLE_FILTERS.has(activeFilter);

    const actionCell = el('td', {});
    if (canDismiss && !isDismissed) {
      actionCell.append(el('button', {
        className: 'sii-dismiss-btn',
        onClick(e) {
          e.stopPropagation();
          dismissedIds.add(String(conv.id));
          saveDismissed();
          const convs = getActiveConversations();
          renderList(convs);
          renderFooter(convs);
        },
      }, '✓ Done'));
    } else if (canDismiss && isDismissed) {
      actionCell.append(el('button', {
        className: 'sii-restore-btn',
        onClick(e) {
          e.stopPropagation();
          dismissedIds.delete(String(conv.id));
          saveDismissed();
          const convs = getActiveConversations();
          renderList(convs);
          renderFooter(convs);
        },
      }, '↩ Restore'));
    }

    return el('tr', {
      className: `sii-row${isDismissed ? ' dismissed' : ''}`,
      onClick() { window.open(href, '_blank'); },
    },
      el('td', {}, el('a', { className: 'sii-conv-id', href, target: '_blank', onClick: e => e.stopPropagation() }, `#${conv.id}`)),
      el('td', {}, el('span', { className: 'sii-subject' }, getSubject(conv))),
      el('td', {}, el('span', { className: `sii-badge ${sla.cls}` }, sla.label)),
      el('td', {}, el('span', { className: 'sii-ts' }, fmtDate(conv.created_at))),
      el('td', {}, el('span', { className: 'sii-ts' }, fmtDate(conv.updated_at))),
      actionCell,
    );
  }

  function renderList(convs) {
    const body = document.getElementById('sii-body');
    if (!body) return;
    body.innerHTML = '';
    if (isLoading) {
      body.append(el('div', { id: 'sii-loading' }, el('div', { className: 'sii-spinner' }), 'Loading conversations…', el('span', { className: 'sii-loading-sub' }, 'Fetching all datasets in parallel…')));
      return;
    }
    if (!getToken()) {
      body.append(el('div', { id: 'sii-waiting' }, el('div', { className: 'sii-spinner' }), 'Waiting for Intercom session to be detected…', el('span', { className: 'sii-waiting-hint' }, 'Navigate around Intercom — an API call will be intercepted automatically.'), el('button', { className: 'sii-icon-btn', onClick: showSettings }, 'Enter token manually instead')));
      return;
    }

    const canDismiss = DISMISSABLE_FILTERS.has(activeFilter);
    const active    = canDismiss ? convs.filter(c => !dismissedIds.has(String(c.id))) : convs;
    const dismissed = canDismiss ? convs.filter(c => dismissedIds.has(String(c.id)))  : [];

    if (!active.length && !dismissed.length) {
      body.append(el('div', { id: 'sii-empty' }, `No conversations in ${filterLabel(activeFilter)}.`));
      return;
    }

    const table = el('table', { className: 'sii-table' });
    const thead = el('thead');
    thead.innerHTML = canDismiss
      ? '<tr><th>#</th><th>Subject / Preview</th><th>SLA</th><th>Created</th><th>Updated</th><th></th></tr>'
      : '<tr><th>#</th><th>Subject / Preview</th><th>SLA</th><th>Created</th><th>Updated</th></tr>';
    table.append(thead);

    const tbody = el('tbody');
    for (const conv of active) {
      tbody.append(buildRow(conv, false));
    }

    // Dismissed section
    if (dismissed.length > 0) {
      const dividerRow = el('tr');
      const dividerCell = el('td', {
        className: 'sii-dismissed-header',
        colspan: canDismiss ? '6' : '5',
      }, `Dismissed (${dismissed.length})`);
      dividerRow.append(dividerCell);
      tbody.append(dividerRow);

      for (const conv of dismissed) {
        tbody.append(buildRow(conv, true));
      }
    }

    table.append(tbody);
    body.append(table);
  }

  function renderFooter(convs) {
    const f = document.getElementById('sii-footer');
    if (!f) return;
    const canDismiss = DISMISSABLE_FILTERS.has(activeFilter);
    const dismissedCount = canDismiss ? convs.filter(c => dismissedIds.has(String(c.id))).length : 0;
    const activeCount = convs.length - dismissedCount;
    const dismissedText = dismissedCount > 0 ? ` · ${dismissedCount} dismissed` : '';
    f.textContent = `${filterLabel(activeFilter)} · ${activeCount} active${dismissedText} · Refreshed ${new Date().toLocaleTimeString()}`;
  }

  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  let settingsVisible = false;

  function showSettings() {
    if (settingsVisible) return;
    settingsVisible = true;
    const modal = document.getElementById('sii-modal');
    if (!modal) return;
    ['sii-stats', 'sii-controls', 'sii-body', 'sii-footer'].forEach(id => {
      const node = document.getElementById(id);
      if (node) node.style.display = 'none';
    });

    const tokenInput = document.createElement('input');
    tokenInput.type = 'text';
    tokenInput.value = getToken();
    tokenInput.placeholder = 'Paste your Intercom API token…';

    const refreshInput = document.createElement('input');
    refreshInput.type = 'number';
    refreshInput.min = '1';
    refreshInput.max = '120';
    refreshInput.value = String(getRefreshMins());
    refreshInput.placeholder = '30';
    refreshInput.style.width = '80px';
    refreshInput.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const panel = el('div', { id: 'sii-settings' },
      el('h3', {}, 'Manual Token Setup'),
      el('p', {}, 'Normally the token is captured automatically from Intercom\'s API calls. If that didn\'t work, paste your token below. Generate one at Settings → Developers → API Keys.'),
      tokenInput,
      el('h3', { style: { marginTop: '16px' } }, 'Auto-Refresh Interval'),
      el('p', {}, 'How often the dashboard fetches fresh data in the background (in minutes).'),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        refreshInput,
        el('span', { style: { fontSize: '12px', color: '#777' } }, 'minutes'),
      ),
      el('div', { style: { display: 'flex', gap: '8px', marginTop: '12px' } },
        el('button', { className: 'sii-save-btn', onClick() {
          saveToken(tokenInput.value);
          const mins = parseInt(refreshInput.value, 10);
          if (mins && mins >= 1) localStorage.setItem(STORAGE_REFRESH, String(mins));
          currentAdminId = null;
          hideSettings();
          handleRefresh();
        }}, 'Save & Load'),
        el('button', { className: 'sii-danger-btn', onClick() {
          [STORAGE_TOKEN, STORAGE_ADMIN_ID, STORAGE_ADMIN_NAME, STORAGE_DISMISSED, STORAGE_REFRESH].forEach(k => localStorage.removeItem(k));
          currentAdminId = null; currentAdminName = null;
          clearDismissed();
          hideSettings();
        }}, 'Clear saved data'),
      ),
      el('div', { style: { marginTop: '20px', paddingTop: '16px', borderTop: '1px solid #e8eaed' } },
        el('p', { style: { fontSize: '11px', color: '#bbb', margin: '0' } },
          'Maintained by joao@hipp.health & guilherme@hipp.health'),
      ),
    );
    modal.insertBefore(panel, document.getElementById('sii-footer') || null);
  }

  function hideSettings() {
    settingsVisible = false;
    document.getElementById('sii-settings')?.remove();
    ['sii-stats', 'sii-controls', 'sii-body', 'sii-footer'].forEach(id => {
      const node = document.getElementById(id);
      if (node) node.style.removeProperty('display');
    });
  }

  // ---------------------------------------------------------------------------
  // Modal
  // ---------------------------------------------------------------------------

  function buildModal() {
    const overlay = el('div', { id: 'sii-overlay' });
    overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

    const modal = el('div', { id: 'sii-modal' },
      el('div', { id: 'sii-header' },
        el('div', { className: 'sii-title' },
          el('h2', {}, '🎧 Queue Health'),
          el('span', { className: 'sii-admin-chip', id: 'sii-admin-chip' },
            currentAdminName ? `👤 ${currentAdminName}` : '…'),
        ),
        el('div', { className: 'sii-header-right' },
          el('button', { className: 'sii-icon-btn', onClick: handleRefresh }, '↻ Refresh'),
          el('button', { className: 'sii-icon-btn', onClick: showSettings }, '⚙ Settings'),
          el('button', { className: 'sii-icon-btn', onClick: closeModal }, '✕'),
        ),
      ),
      el('div', { id: 'sii-stats' }),
      el('div', { id: 'sii-controls' },
        el('span', { className: 'sii-ctrl-label' }, 'Sort:'),
        buildSortButtons(),
        el('div', { className: 'sii-sep' }),
        el('span', { id: 'sii-active-label' }, filterLabel(activeFilter)),
      ),
      el('div', { id: 'sii-body' }),
      el('div', { id: 'sii-footer' }, ''),
    );

    overlay.append(modal);
    return overlay;
  }

  const SORT_CATS = [
    { key: 'sla', label: 'SLA', defaultDir: 'asc' },
    { key: 'created', label: 'Created', defaultDir: 'desc' },
    { key: 'updated', label: 'Last Updated', defaultDir: 'desc' },
  ];

  function parseSortMode() {
    const i = sortMode.lastIndexOf('_');
    return { key: sortMode.slice(0, i), dir: sortMode.slice(i + 1) };
  }

  function buildSortButtons() {
    const group = el('div', { className: 'sii-tab-group', id: 'sii-sort-group' });
    for (const cat of SORT_CATS) {
      const btn = el('button', { className: 'sii-tab', onClick() {
        const { key, dir } = parseSortMode();
        sortMode = cat.key === key ? `${cat.key}_${dir === 'asc' ? 'desc' : 'asc'}` : `${cat.key}_${cat.defaultDir}`;
        refreshSortButtons();
        const convs = getActiveConversations();
        renderList(convs); renderFooter(convs);
      }});
      btn.dataset.sortCat = cat.key;
      group.append(btn);
    }
    refreshSortButtons(group);
    return group;
  }

  function refreshSortButtons(group) {
    const container = group || document.getElementById('sii-sort-group');
    if (!container) return;
    const { key: activeKey, dir: activeDir } = parseSortMode();
    for (const btn of container.querySelectorAll('[data-sort-cat]')) {
      const cat = SORT_CATS.find(c => c.key === btn.dataset.sortCat);
      if (!cat) continue;
      const isActive = cat.key === activeKey;
      btn.className = `sii-tab${isActive ? ' active' : ''}`;
      btn.textContent = isActive ? `${cat.label} ${activeDir === 'asc' ? '↑' : '↓'}` : cat.label;
    }
  }

  function openModal() {
    if (document.getElementById('sii-overlay')) return;
    document.body.append(buildModal());
    const hasData = lastLoadedAt > 0;
    const isFresh = hasData && (NOW_S() - lastLoadedAt < getStaleSecs());
    if (isFresh) {
      renderStats(getStats());
      renderList(getActiveConversations());
      renderFooter(getActiveConversations());
    } else {
      renderStats(hasData ? getStats() : {}, true);
      handleRefresh();
    }
  }

  function closeModal() {
    document.getElementById('sii-overlay')?.remove();
    settingsVisible = false;
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  async function handleRefresh() {
    if (isLoading) return;
    if (!getToken()) { renderList([]); return; }

    isLoading = true;
    document.querySelectorAll('.sii-stat-card').forEach(c => c.classList.add('sii-loading'));
    const body = document.getElementById('sii-body');
    if (body) {
      body.innerHTML = '';
      body.append(el('div', { id: 'sii-loading' }, el('div', { className: 'sii-spinner' }), 'Loading all datasets…', el('span', { className: 'sii-loading-sub' }, 'Fetching backlog, assignments, replies, and closed in parallel…')));
    }

    try {
      await ensureAdminInfo();
      const chip = document.getElementById('sii-admin-chip');
      if (chip && currentAdminName) chip.textContent = `👤 ${currentAdminName}`;
      await loadAllDatasets();
      lastLoadedAt = NOW_S();
      isLoading = false;
      const stats = getStats(), convs = getActiveConversations();
      renderStats(stats); renderList(convs); renderFooter(convs);
    } catch (err) {
      const body = document.getElementById('sii-body');
      if (body) { body.innerHTML = ''; body.append(el('div', { id: 'sii-empty' }, `⚠️ ${err.message}. Try refreshing or check your token in ⚙ Settings.`)); }
    } finally {
      isLoading = false;
      document.querySelectorAll('.sii-stat-card').forEach(c => c.classList.remove('sii-loading'));
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    if (!getToken()) tryTokenFromStorage();
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    document.body.append(el('button', {
      id: 'sii-btn', className: getToken() ? 'ready' : '', onClick: openModal,
    }, '☰', el('span', { className: 'sii-dot' })));

    setInterval(async () => {
      if (!getToken() || isLoading) return;
      if (NOW_S() - lastLoadedAt < getStaleSecs()) return;
      try {
        await ensureAdminInfo();
        await loadAllDatasets();
        lastLoadedAt = NOW_S();
        if (document.getElementById('sii-overlay') && !settingsVisible) {
          const stats = getStats(), convs = getActiveConversations();
          renderStats(stats); renderList(convs); renderFooter(convs);
        }
      } catch (_) {}
    }, 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  setupTokenCapture();

  // Debug tools
  try {
    unsafeWindow.siiDebug = (on) => {
      debugMode = (on === undefined) ? !debugMode : !!on;
      console.log(`[SII] Debug mode ${debugMode ? 'ON' : 'OFF'}`);
      return debugMode;
    };
    unsafeWindow.siiInspect = async (...ids) => {
      if (!ids.length) { console.log('[SII] Usage: siiInspect(123456, 789012)'); return; }
      const adminIdStr = String(currentAdminId);
      console.log(`[SII] Inspecting ${ids.length} conversation(s)… Admin ID: ${adminIdStr}`);
      for (const id of ids) {
        try {
          const detail = await apiRequest({ path: `/conversations/${id}` });
          const parts = detail.conversation_parts?.conversation_parts ?? [];
          console.group(`[SII Inspect] Conversation #${id} — ${parts.length} parts`);
          console.log('Statistics:', detail.statistics);
          console.log(`last_admin_reply_at: ${detail.statistics?.last_admin_reply_at ? new Date(detail.statistics.last_admin_reply_at * 1000).toISOString() : 'null'}`);
          parts.forEach((p, idx) => {
            const isAdmin = p.author?.type === 'admin' && String(p.author?.id) === adminIdStr;
            const ts = p.created_at ? new Date(p.created_at * 1000).toISOString() : 'no timestamp';
            console.log(`  [${idx}] ${isAdmin ? '✅ YOURS' : '—'} | type="${p.part_type}" | author.type="${p.author?.type}" author.id="${p.author?.id}" author.name="${p.author?.name}" | created=${ts}`);
          });
          console.groupEnd();
        } catch (err) { console.error(`[SII Inspect] Failed to fetch #${id}:`, err); }
      }
    };
  } catch (_) {}

})();
})();
