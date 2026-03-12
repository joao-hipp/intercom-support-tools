// ==UserScript==
// @name         Support Intercom Interface
// @namespace    https://app.intercom.com
// @version      1.0.0
// @description  Personal queue health dashboard — dataset-per-metric architecture
// @match        https://app.intercom.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.intercom.io
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const STORAGE_TOKEN      = 'sii_token';
  const STORAGE_ADMIN_ID   = 'sii_admin_id';
  const STORAGE_ADMIN_NAME = 'sii_admin_name';
  const TWO_HOURS_S = 7200;
  const NOW_S = () => Math.floor(Date.now() / 1000);

  const TODAY_START_S = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();

  const WEEK_START_S = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay()); // back to Sunday
    return Math.floor(d.getTime() / 1000);
  })();

  // Filter/dataset keys — used as both stat card identifiers and dataset map keys
  const F_BACKLOG          = 'backlog';
  const F_SLA_BREACHED     = 'slaBreached';
  const F_SLA_WARNING      = 'slaWarning';
  const F_ASSIGNED_TODAY   = 'assignedToday';
  const F_ASSIGNED_WEEK    = 'assignedThisWeek';
  const F_REPLIED_TODAY    = 'repliedToday';
  const F_REPLIED_WEEK     = 'repliedThisWeek';

  // Intercom part types that are system/internal events — NOT customer-facing replies
  const SYSTEM_PART_TYPES = new Set([
    'note', 'assignment', 'open', 'close', 'snoozed',
    'away_mode_assignment', 'admin_initiated_message', 'conversation_rating_changed',
  ]);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  // Each metric owns its own dataset. Stats and list both read from the same dataset
  // so counts always match what's shown in the list.
  const datasets = {
    [F_BACKLOG]:        [],
    [F_ASSIGNED_TODAY]: [],
    [F_ASSIGNED_WEEK]:  [],
    [F_REPLIED_TODAY]:  [],
    [F_REPLIED_WEEK]:   [],
    // SLA Warning and SLA Breached are derived from backlog at render time — no separate array needed
  };

  let currentAdminId   = localStorage.getItem(STORAGE_ADMIN_ID)   || null;
  let currentAdminName = localStorage.getItem(STORAGE_ADMIN_NAME) || null;
  let activeFilter  = F_BACKLOG;
  let sortMode      = 'sla_asc';
  let isLoading     = false;
  let lastLoadedAt  = 0; // epoch seconds of last successful full data load

  // ---------------------------------------------------------------------------
  // Token management — auto-capture from page session, manual fallback
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
          if (auth?.startsWith('Bearer ')) {
            saveToken(auth.slice(7));
            onTokenCaptured();
          }
        }
        return Reflect.apply(origFetch, this, arguments);
      };
    } catch (e) {
      console.warn('[SII] Could not set up token capture:', e);
    }
  }

  function onTokenCaptured() {
    if (document.getElementById('sii-waiting')) handleRefresh();
    document.getElementById('sii-btn')?.classList.add('ready');
  }

  // ---------------------------------------------------------------------------
  // API
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

  // Paginate through ALL results for a given search query
  async function fetchAllConvs(conditions) {
    const results = [];
    let cursor = null;
    const query = conditions.length === 1
      ? conditions[0]
      : { operator: 'AND', value: conditions };
    do {
      const body = {
        query,
        pagination: { per_page: 150, ...(cursor ? { starting_after: cursor } : {}) },
      };
      const resp = await apiRequest({ method: 'POST', path: '/conversations/search', body });
      results.push(...(resp.data ?? resp.conversations ?? []));
      cursor = resp.pages?.next?.starting_after ?? null;
    } while (cursor);
    return results;
  }

  // ---------------------------------------------------------------------------
  // Data loading — each metric owns its dataset
  // ---------------------------------------------------------------------------

  async function loadAllDatasets() {
    const adminId    = parseInt(currentAdminId, 10);
    const adminIdStr = String(currentAdminId);

    // Three parallel searches.
    // weekCandidates has no assignee filter — it catches conversations this admin replied
    // to but that were subsequently closed or reassigned (Mon/Tue replies missed otherwise).
    // Classification is still narrowed to THIS admin's parts inside buildRepliedDatasets.
    const [backlog, assignedThisWeek, weekCandidates] = await Promise.all([
      fetchAllConvs([
        { field: 'state',             operator: '=',  value: 'open'       },
        { field: 'admin_assignee_id', operator: '=',  value: adminId      },
      ]),
      fetchAllConvs([
        { field: 'admin_assignee_id',             operator: '=',  value: adminId     },
        { field: 'statistics.last_assignment_at', operator: '>=', value: WEEK_START_S },
      ]),
      // All conversations with any admin reply since Sunday — no assignee/state filter so
      // Mon/Tue replies that are now closed or reassigned are still caught.
      fetchAllConvs([
        { field: 'statistics.last_admin_reply_at', operator: '>=', value: WEEK_START_S },
      ]),
    ]);

    datasets[F_BACKLOG]        = backlog;
    datasets[F_ASSIGNED_WEEK]  = assignedThisWeek;
    datasets[F_ASSIGNED_TODAY] = assignedThisWeek.filter(
      c => (c.statistics?.last_assignment_at ?? 0) >= TODAY_START_S
    );

    // Reply candidates = deduplicated union. weekCandidates is the authoritative source;
    // backlog/assignedThisWeek are included as a safety net for conversations where
    // last_admin_reply_at may be delayed or not yet indexed.
    const seen = new Set();
    const replyCandidates = [...backlog, ...assignedThisWeek, ...weekCandidates].filter(c => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return (c.statistics?.last_admin_reply_at ?? 0) >= WEEK_START_S;
    });

    const { repliedThisWeek, repliedToday } =
      await buildRepliedDatasets(replyCandidates, adminIdStr);
    datasets[F_REPLIED_WEEK]  = repliedThisWeek;
    datasets[F_REPLIED_TODAY] = repliedToday;
  }

  // Fetch full conversation (includes parts) for each candidate and classify by
  // whether THIS admin sent a customer-facing reply this week / today.
  //
  // We intentionally allow any part_type that is NOT a system/internal event so we
  // catch all reply variants (e.g. 'comment', 'reply', ticket-specific types) rather
  // than hard-coding a single string that might miss some.
  //
  // Batched to 8 concurrent requests to avoid hammering the API.
  async function buildRepliedDatasets(candidates, adminIdStr) {
    const repliedThisWeek = [];
    const repliedToday    = [];
    const BATCH = 8;

    for (let i = 0; i < candidates.length; i += BATCH) {
      const results = await Promise.all(
        candidates.slice(i, i + BATCH).map(async conv => {
          try {
            const detail = await apiRequest({ path: `/conversations/${conv.id}` });
            const parts  = detail.conversation_parts?.conversation_parts ?? [];
            // Any non-system part authored by this admin counts as a customer-facing reply.
            // This handles 'comment', 'reply', and any ticket-specific part types.
            const mine = parts.filter(p =>
              !SYSTEM_PART_TYPES.has(p.part_type) &&
              p.author?.type === 'admin' &&
              String(p.author?.id) === adminIdStr
            );
            return {
              conv,
              hasThisWeek: mine.some(p => p.created_at >= WEEK_START_S),
              hasToday:    mine.some(p => p.created_at >= TODAY_START_S),
            };
          } catch {
            return { conv, hasThisWeek: false, hasToday: false };
          }
        })
      );
      for (const { conv, hasThisWeek, hasToday } of results) {
        if (hasThisWeek) repliedThisWeek.push(conv);
        if (hasToday)    repliedToday.push(conv);
      }
    }

    return { repliedThisWeek, repliedToday };
  }

  // ---------------------------------------------------------------------------
  // Active conversations — derived from activeFilter + sort
  // ---------------------------------------------------------------------------

  function getActiveConversations() {
    const now = NOW_S();
    let convs;

    // SLA views are computed from the backlog dataset
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
      // Guard: if no dataset exists for this key, fall back to backlog
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
      // sla_asc / sla_desc: breached first (asc) or last (desc), then by time remaining
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

  // Stat counts come from the same datasets the list uses — they always match
  function getStats() {
    const now    = NOW_S();
    const backlog = datasets[F_BACKLOG];
    return {
      [F_BACKLOG]:        backlog.length,
      [F_SLA_BREACHED]:   backlog.filter(c => c.sla_applied?.sla_status === 'missed').length,
      [F_SLA_WARNING]:    backlog.filter(c => {
        const sla = c.sla_applied;
        if (!sla || sla.sla_status !== 'active') return false;
        const rem = sla.next_breach_at - now;
        return rem > 0 && rem <= TWO_HOURS_S;
      }).length,
      [F_ASSIGNED_TODAY]: datasets[F_ASSIGNED_TODAY].length,
      [F_ASSIGNED_WEEK]:  datasets[F_ASSIGNED_WEEK].length,
      [F_REPLIED_TODAY]:  datasets[F_REPLIED_TODAY].length,
      [F_REPLIED_WEEK]:   datasets[F_REPLIED_WEEK].length,
    };
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function fmtSla(conv) {
    const sla = conv.sla_applied;
    const now = NOW_S();
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

  // Company name from the conversation.
  // Priority: conversation custom attributes (ticket/conversation attribute panel) →
  //           contact's linked company → source.author as last resort.
  // Custom attribute key names vary per workspace; we try exact matches then a
  // case-insensitive fuzzy scan for anything containing "company" / "account" / "client".
  const COMPANY_ATTR_KEYS = [
    'Company', 'company', 'Company name', 'company_name', 'Company Name',
    'Account', 'account', 'Client', 'client', 'Organization', 'organization',
  ];

  function getCompanyName(conv) {
    // 1. Ticket/conversation attribute panel data.
    //    Tickets store attributes in `ticket_attributes`; regular conversations use
    //    `custom_attributes`. We check both, preferring ticket_attributes.
    const attrSources = [conv.ticket_attributes, conv.custom_attributes].filter(Boolean);
    for (const attrs of attrSources) {
      // Exact key match first
      for (const key of COMPANY_ATTR_KEYS) {
        const val = attrs[key];
        if (val && typeof val === 'string' && val.trim()) return val.trim();
      }
      // Fuzzy fallback: any key whose name contains "company", "account", or "client"
      for (const [key, val] of Object.entries(attrs)) {
        if (!val || typeof val !== 'string' || !val.trim()) continue;
        const k = key.toLowerCase();
        if (k.includes('company') || k.includes('account') || k.includes('client')) {
          return val.trim();
        }
      }
    }

    // 2. Contact's linked company record
    const c = conv.contacts?.contacts?.[0];
    if (c?.company?.name) return c.company.name;

    // 3. source.author — reliably populated in search results; skip admins
    const author = conv.source?.author;
    if (author && author.type !== 'admin') {
      if (author.name) return author.name;
      if (author.email?.includes('@')) return author.email.split('@')[1];
    }

    return '—';
  }

  function getSubject(conv) {
    return conv.source?.subject ||
      conv.source?.body?.replace(/<[^>]+>/g, '').trim().slice(0, 80) ||
      '(no subject)';
  }

  function filterLabel(key) {
    switch (key) {
      case F_BACKLOG:        return 'Backlog';
      case F_SLA_BREACHED:   return 'SLA Breached';
      case F_SLA_WARNING:    return 'SLA Warning';
      case F_ASSIGNED_TODAY: return 'Assigned to Me Today';
      case F_ASSIGNED_WEEK:  return 'Assigned to Me This Week';
      case F_REPLIED_TODAY:  return 'Replied Today';
      case F_REPLIED_WEEK:   return 'Replied This Week';
      default:               return key;
    }
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
      position: fixed;
      top: 14px; right: 14px;
      z-index: 99998;
      background: #1f73b7; color: #fff;
      border: none; border-radius: 7px;
      padding: 7px 13px;
      font-size: 12px; font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      display: flex; align-items: center; gap: 6px;
      transition: background 0.15s;
    }
    #sii-btn:hover { background: #1a5f9a; }
    #sii-btn .sii-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #f59e0b; flex-shrink: 0;
    }
    #sii-btn.ready .sii-dot { background: #4caf50; }

    #sii-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 99999;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    #sii-modal {
      background: #fff; border-radius: 12px;
      width: 94vw; max-width: 1100px; max-height: 88vh;
      display: flex; flex-direction: column;
      box-shadow: 0 24px 64px rgba(0,0,0,0.22);
      overflow: hidden;
    }

    /* Header */
    #sii-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 15px 22px;
      border-bottom: 1px solid #e8eaed;
      flex-shrink: 0;
    }
    .sii-title { display: flex; align-items: center; gap: 10px; }
    .sii-title h2 { margin: 0; font-size: 15px; font-weight: 700; color: #1a1a1a; }
    .sii-admin-chip {
      background: #edf4fb; color: #1f73b7;
      border-radius: 99px; padding: 2px 9px;
      font-size: 11px; font-weight: 600;
    }
    .sii-header-right { display: flex; align-items: center; gap: 6px; }
    .sii-icon-btn {
      background: none; border: 1px solid #e0e0e0; border-radius: 6px;
      padding: 5px 10px; cursor: pointer; font-size: 12px; color: #555;
      transition: all 0.1s;
    }
    .sii-icon-btn:hover { background: #f4f5f7; border-color: #bbb; }

    /* Stats — 4-column grid, 2 rows for 7 cards */
    #sii-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      padding: 16px 22px;
      border-bottom: 1px solid #e8eaed;
      flex-shrink: 0;
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
    .sii-stat-label { font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
    .sii-stat-value { font-size: 26px; font-weight: 700; color: #1a1a1a; line-height: 1; }
    .sii-stat-card.warning .sii-stat-value { color: #b76e00; }
    .sii-stat-card.danger  .sii-stat-value { color: #c0392b; }
    .sii-stat-card.info    .sii-stat-value { color: #1565c0; }
    .sii-stat-card.green   .sii-stat-value { color: #2e7d32; }
    .sii-stat-sub { font-size: 10px; color: #bbb; margin-top: 3px; }
    .sii-stat-loading { color: #ccc !important; }

    /* Controls */
    #sii-controls {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 22px;
      border-bottom: 1px solid #e8eaed;
      flex-shrink: 0; flex-wrap: wrap;
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

    /* Body */
    #sii-body { overflow-y: auto; flex: 1; min-height: 0; }

    /* Table */
    .sii-table { width: 100%; border-collapse: collapse; }
    .sii-table thead th {
      position: sticky; top: 0;
      background: #f8f9fb; padding: 9px 15px;
      text-align: left; font-size: 10px; font-weight: 700;
      color: #999; text-transform: uppercase; letter-spacing: 0.5px;
      border-bottom: 1px solid #e8eaed; white-space: nowrap;
    }
    .sii-row {
      border-bottom: 1px solid #f2f2f2;
      cursor: pointer; transition: background 0.08s;
    }
    .sii-row:hover { background: #f8f9fb; }
    .sii-row td { padding: 10px 15px; font-size: 13px; color: #333; vertical-align: middle; }
    .sii-conv-id {
      font-family: monospace; font-size: 11px;
      color: #1f73b7; text-decoration: none; font-weight: 700;
    }
    .sii-conv-id:hover { text-decoration: underline; }
    .sii-company { font-weight: 600; font-size: 12px; }
    .sii-subject {
      color: #666; max-width: 220px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      display: block; font-size: 12px;
    }
    .sii-badge {
      display: inline-block; padding: 2px 8px;
      border-radius: 99px; font-size: 11px; font-weight: 700; white-space: nowrap;
    }
    .sii-badge.ok       { background: #e8f5e9; color: #2e7d32; }
    .sii-badge.warning  { background: #fff8e6; color: #b76e00; }
    .sii-badge.breached { background: #fef0f0; color: #c0392b; }
    .sii-badge.none     { background: #f0f0f0; color: #aaa; }
    .sii-ts { font-size: 11px; color: #aaa; white-space: nowrap; }

    /* States */
    #sii-empty, #sii-loading, #sii-waiting {
      padding: 44px; text-align: center; color: #aaa; font-size: 13px;
      display: flex; flex-direction: column; align-items: center; gap: 10px;
    }
    .sii-spinner {
      width: 26px; height: 26px;
      border: 3px solid #e0e0e0; border-top-color: #1f73b7;
      border-radius: 50%;
      animation: sii-spin 0.7s linear infinite;
    }
    @keyframes sii-spin { to { transform: rotate(360deg); } }
    .sii-waiting-hint { font-size: 12px; color: #bbb; }
    .sii-loading-sub  { font-size: 11px; color: #ccc; }

    /* Settings */
    #sii-settings {
      padding: 24px 22px; display: flex; flex-direction: column; gap: 12px;
      max-width: 480px;
    }
    #sii-settings h3 { margin: 0; font-size: 14px; font-weight: 700; color: #1a1a1a; }
    #sii-settings p  { margin: 0; font-size: 12px; color: #777; line-height: 1.6; }
    #sii-settings input {
      padding: 8px 11px; border: 1px solid #d0d0d0; border-radius: 6px;
      font-size: 13px; font-family: monospace;
      box-sizing: border-box; outline: none; width: 100%;
    }
    #sii-settings input:focus { border-color: #1f73b7; }
    .sii-save-btn {
      background: #1f73b7; color: #fff; border: none; border-radius: 6px;
      padding: 8px 16px; font-size: 13px; font-weight: 600;
      cursor: pointer; align-self: flex-start;
    }
    .sii-save-btn:hover { background: #1a5f9a; }
    .sii-danger-btn {
      background: none; border: 1px solid #e0e0e0; border-radius: 6px;
      padding: 8px 16px; font-size: 12px; color: #c0392b; cursor: pointer;
    }
    .sii-danger-btn:hover { background: #fef0f0; }

    /* Footer */
    #sii-footer {
      padding: 8px 22px; border-top: 1px solid #e8eaed;
      font-size: 11px; color: #ccc; text-align: right; flex-shrink: 0;
    }
  `;

  // ---------------------------------------------------------------------------
  // Render — stats
  // ---------------------------------------------------------------------------

  // loading=true shows '…' placeholders so the cards are visible immediately on open
  function renderStats(stats, loading = false) {
    const container = document.getElementById('sii-stats');
    if (!container) return;
    container.innerHTML = '';

    const first = currentAdminName ? currentAdminName.split(' ')[0] : null;

    // 7 cards in a 4-column grid — ordered by urgency / relevance
    const cards = [
      { key: F_BACKLOG,        label: first ? `${first}'s Backlog` : 'Backlog',       sub: 'open conversations',       cls: '' },
      { key: F_SLA_BREACHED,   label: 'SLA Breached',                                  sub: 'past deadline',            cls: 'danger' },
      { key: F_SLA_WARNING,    label: 'SLA Warning',                                   sub: '< 2h remaining',           cls: 'warning' },
      { key: F_ASSIGNED_TODAY, label: 'Assigned Today',                                sub: 'new assignments',          cls: 'info' },
      { key: F_ASSIGNED_WEEK,  label: 'Assigned This Week',                            sub: 'since Sunday',             cls: 'info' },
      { key: F_REPLIED_TODAY,  label: 'Replied Today',                                  sub: 'my replies only',          cls: 'green' },
      { key: F_REPLIED_WEEK,   label: 'Replied This Week',                              sub: 'since Sunday',             cls: 'green' },
    ];

    for (const c of cards) {
      const isActive = activeFilter === c.key;
      const card = el('div',
        { className: `sii-stat-card ${c.cls}${isActive ? ' active' : ''}`, onClick: () => setActiveFilter(c.key) },
        el('div', { className: 'sii-stat-label' }, c.label),
        el('div', { className: `sii-stat-value${loading ? ' sii-stat-loading' : ''}` },
          loading ? '…' : String(stats[c.key] ?? 0)),
        el('div', { className: 'sii-stat-sub' }, c.sub),
      );
      card.dataset.statKey = c.key;
      container.append(card);
    }
  }

  function setActiveFilter(key) {
    activeFilter = key;

    // Update card highlight
    document.querySelectorAll('.sii-stat-card').forEach(c => {
      c.classList.toggle('active', c.dataset.statKey === key);
    });

    // Update active label
    const label = document.getElementById('sii-active-label');
    if (label) label.textContent = filterLabel(key);

    const convs = getActiveConversations();
    renderList(convs);
    renderFooter(convs);
  }

  // ---------------------------------------------------------------------------
  // Render — list
  // ---------------------------------------------------------------------------

  function renderList(convs) {
    const body = document.getElementById('sii-body');
    if (!body) return;
    body.innerHTML = '';

    if (isLoading) {
      body.append(
        el('div', { id: 'sii-loading' },
          el('div', { className: 'sii-spinner' }),
          'Loading conversations…',
          el('span', { className: 'sii-loading-sub' }, 'Fetching all datasets in parallel…'),
        )
      );
      return;
    }

    if (!getToken()) {
      body.append(
        el('div', { id: 'sii-waiting' },
          el('div', { className: 'sii-spinner' }),
          'Waiting for Intercom session to be detected…',
          el('span', { className: 'sii-waiting-hint' }, 'Navigate around Intercom — an API call will be intercepted automatically.'),
          el('button', { className: 'sii-icon-btn', onClick: showSettings }, 'Enter token manually instead'),
        )
      );
      return;
    }

    if (!convs.length) {
      body.append(el('div', { id: 'sii-empty' }, `No conversations in ${filterLabel(activeFilter)}.`));
      return;
    }

    const table = el('table', { className: 'sii-table' });
    const thead = el('thead');
    thead.innerHTML = `<tr>
      <th>#</th><th>Company</th><th>Subject / Preview</th><th>SLA</th><th>Created</th><th>Updated</th>
    </tr>`;
    table.append(thead);

    const tbody = el('tbody');
    for (const conv of convs) {
      const sla  = fmtSla(conv);
      const href = `https://app.intercom.com/a/inbox/_/inbox/conversation/${conv.id}`;

      tbody.append(
        el('tr', {
          className: 'sii-row',
          // Clicking the row opens the conversation; the #ID link also works independently
          onClick() { window.open(href, '_blank'); },
        },
          el('td', {}, el('a', { className: 'sii-conv-id', href, target: '_blank', onClick: e => e.stopPropagation() }, `#${conv.id}`)),
          el('td', {}, el('span', { className: 'sii-company' }, getCompanyName(conv))),
          el('td', {}, el('span', { className: 'sii-subject' }, getSubject(conv))),
          el('td', {}, el('span', { className: `sii-badge ${sla.cls}` }, sla.label)),
          el('td', {}, el('span', { className: 'sii-ts' }, fmtDate(conv.created_at))),
          el('td', {}, el('span', { className: 'sii-ts' }, fmtDate(conv.updated_at))),
        )
      );
    }

    table.append(tbody);
    body.append(table);
  }

  function renderFooter(convs) {
    const f = document.getElementById('sii-footer');
    if (f) f.textContent = `${filterLabel(activeFilter)} · ${convs.length} conversation${convs.length !== 1 ? 's' : ''} · Refreshed ${new Date().toLocaleTimeString()}`;
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
    tokenInput.type        = 'text';
    tokenInput.value       = getToken();
    tokenInput.placeholder = 'Paste your Intercom API token…';

    const panel = el('div', { id: 'sii-settings' },
      el('h3', {}, 'Manual Token Setup'),
      el('p', {}, 'Normally the token is captured automatically from Intercom\'s API calls. If that didn\'t work, paste your token below. Generate one at Settings → Developers → API Keys.'),
      tokenInput,
      el('div', { style: { display: 'flex', gap: '8px' } },
        el('button', {
          className: 'sii-save-btn',
          onClick() {
            saveToken(tokenInput.value);
            currentAdminId = null; // force re-fetch
            hideSettings();
            handleRefresh();
          },
        }, 'Save & Load'),
        el('button', {
          className: 'sii-danger-btn',
          onClick() {
            [STORAGE_TOKEN, STORAGE_ADMIN_ID, STORAGE_ADMIN_NAME].forEach(k => localStorage.removeItem(k));
            currentAdminId = null;
            currentAdminName = null;
            hideSettings();
          },
        }, 'Clear saved token'),
      )
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
      // Header
      el('div', { id: 'sii-header' },
        el('div', { className: 'sii-title' },
          el('h2', {}, '🎧 Queue Health'),
          el('span', { className: 'sii-admin-chip', id: 'sii-admin-chip' },
            currentAdminName ? `👤 ${currentAdminName}` : '…'
          ),
        ),
        el('div', { className: 'sii-header-right' },
          el('button', { className: 'sii-icon-btn', onClick: handleRefresh }, '↻ Refresh'),
          el('button', { className: 'sii-icon-btn', onClick: showSettings },  '⚙ Settings'),
          el('button', { className: 'sii-icon-btn', onClick: closeModal },    '✕'),
        ),
      ),
      // Stats grid — populated immediately by openModal (loading placeholders or real data)
      el('div', { id: 'sii-stats' }),
      // Sort controls + active filter label
      el('div', { id: 'sii-controls' },
        el('span', { className: 'sii-ctrl-label' }, 'Sort:'),
        buildSortButtons(),
        el('div', { className: 'sii-sep' }),
        el('span', { id: 'sii-active-label' }, filterLabel(activeFilter)),
      ),
      // Body — populated by openModal
      el('div', { id: 'sii-body' }),
      // Footer
      el('div', { id: 'sii-footer' }, ''),
    );

    overlay.append(modal);
    return overlay;
  }

  // Sort categories — one toggle button each; clicking the active button flips direction
  const SORT_CATS = [
    { key: 'sla',     label: 'SLA',          defaultDir: 'asc'  },
    { key: 'created', label: 'Created',       defaultDir: 'desc' },
    { key: 'updated', label: 'Last Updated',  defaultDir: 'desc' },
  ];

  // Returns { key, dir } by splitting on the last underscore
  function parseSortMode() {
    const i = sortMode.lastIndexOf('_');
    return { key: sortMode.slice(0, i), dir: sortMode.slice(i + 1) };
  }

  function buildSortButtons() {
    const group = el('div', { className: 'sii-tab-group', id: 'sii-sort-group' });
    for (const cat of SORT_CATS) {
      const btn = el('button', {
        className: 'sii-tab',
        onClick() {
          const { key, dir } = parseSortMode();
          sortMode = cat.key === key
            ? `${cat.key}_${dir === 'asc' ? 'desc' : 'asc'}`  // toggle direction
            : `${cat.key}_${cat.defaultDir}`;                   // activate with default
          refreshSortButtons();
          const convs = getActiveConversations();
          renderList(convs);
          renderFooter(convs);
        },
      });
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
      btn.textContent = isActive
        ? `${cat.label} ${activeDir === 'asc' ? '↑' : '↓'}`
        : cat.label;
    }
  }

  const STALE_SECS = 30 * 60; // 30 minutes

  function openModal() {
    if (document.getElementById('sii-overlay')) return;
    document.body.append(buildModal());

    const hasData  = lastLoadedAt > 0;
    const isFresh  = hasData && (NOW_S() - lastLoadedAt < STALE_SECS);

    if (isFresh) {
      // Render immediately from cache — no network call needed
      renderStats(getStats());
      renderList(getActiveConversations());
      renderFooter(getActiveConversations());
    } else {
      // Show stat cards with placeholders right away, then fetch in background
      renderStats(hasData ? getStats() : {}, /* loading= */ true);
      handleRefresh();
    }
  }

  function closeModal() {
    document.getElementById('sii-overlay')?.remove();
    settingsVisible = false;
  }

  // ---------------------------------------------------------------------------
  // Refresh — loads all datasets then re-renders
  // ---------------------------------------------------------------------------

  async function handleRefresh() {
    if (isLoading) return;

    if (!getToken()) {
      renderList([]); // shows waiting state
      return;
    }

    isLoading = true;
    const body = document.getElementById('sii-body');
    if (body) {
      body.innerHTML = '';
      body.append(
        el('div', { id: 'sii-loading' },
          el('div', { className: 'sii-spinner' }),
          'Loading all datasets…',
          el('span', { className: 'sii-loading-sub' }, 'Fetching backlog, assignments, and today\'s replies in parallel…'),
        )
      );
    }

    try {
      await ensureAdminInfo();

      const chip = document.getElementById('sii-admin-chip');
      if (chip && currentAdminName) chip.textContent = `👤 ${currentAdminName}`;

      await loadAllDatasets();
      lastLoadedAt = NOW_S();
      isLoading = false; // clear before rendering so renderList doesn't show the spinner

      const stats = getStats();
      const convs = getActiveConversations();

      renderStats(stats);
      renderList(convs);
      renderFooter(convs);
    } catch (err) {
      const body = document.getElementById('sii-body');
      if (body) {
        body.innerHTML = '';
        body.append(el('div', { id: 'sii-empty' }, `⚠️ ${err.message}. Try refreshing or check your token in ⚙ Settings.`));
      }
    } finally {
      isLoading = false;
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

    document.body.append(
      el('button', {
        id: 'sii-btn',
        className: getToken() ? 'ready' : '',
        onClick: openModal,
      },
        '🎧 Queue',
        el('span', { className: 'sii-dot' }),
      )
    );

    // Background auto-refresh every 30 minutes.
    // Silently re-fetches data; re-renders the modal only if it happens to be open.
    setInterval(async () => {
      if (!getToken() || isLoading) return;
      if (NOW_S() - lastLoadedAt < STALE_SECS) return; // not stale yet
      try {
        await ensureAdminInfo();
        await loadAllDatasets();
        lastLoadedAt = NOW_S();
        if (document.getElementById('sii-overlay') && !settingsVisible) {
          const stats = getStats();
          const convs = getActiveConversations();
          renderStats(stats);
          renderList(convs);
          renderFooter(convs);
        }
      } catch (_) { /* silent — user can manually refresh */ }
    }, 60 * 1000); // checks every minute, only fires when stale
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Token capture runs at document-start, before DOMContentLoaded
  setupTokenCapture();
})();
