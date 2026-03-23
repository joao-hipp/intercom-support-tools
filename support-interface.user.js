// ==UserScript==
// @name         Support Intercom Interface
// @namespace    https://app.intercom.com
// @version      2.6.1
// @description  Personal queue health dashboard
// @author       joao@hipp.health, guilherme@hipp.health
// @match        https://app.intercom.com/*
// @grant        GM_xmlhttpRequest
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
  const STORAGE_COLUMNS    = 'sii_columns';
  const STORAGE_FILTERS    = 'sii_filters';
  const STORAGE_CACHE      = 'sii_cache';
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
  const F_UNASSIGNED       = 'unassigned';

  // Filters that support the dismiss feature
  const DISMISSABLE_FILTERS = new Set([F_BACKLOG, F_SLA_BREACHED, F_SLA_WARNING]);

  // All filter card definitions (order = default display order)
  const ALL_FILTER_CARDS = [
    { key: F_BACKLOG,        label: null,                  sub: 'open conversations', cls: '',        required: true  },
    { key: F_SLA_BREACHED,   label: 'SLA Breached',        sub: 'past deadline',      cls: 'danger',  required: false },
    { key: F_SLA_WARNING,    label: 'SLA Warning',         sub: '< 2h remaining',     cls: 'warning', required: false },
    { key: F_UNASSIGNED,     label: 'Unassigned',          sub: 'no assignee',        cls: 'teal',    required: false },
    { key: F_ASSIGNED_TODAY, label: 'Assigned Today',      sub: 'new assignments',    cls: 'info',    required: false },
    { key: F_ASSIGNED_WEEK,  label: 'Assigned This Week',  sub: 'since Sunday',       cls: 'info',    required: false },
    { key: F_REPLIED_TODAY,  label: 'Replied Today',       sub: 'my replies only',    cls: 'green',   required: false },
    { key: F_REPLIED_WEEK,   label: 'Replied This Week',   sub: 'since Sunday',       cls: 'green',   required: false },
    { key: F_CLOSED_WEEK,    label: 'Closed This Week',    sub: 'since Sunday',       cls: 'purple',  required: false },
  ];

  // ---------------------------------------------------------------------------
  // Column definitions
  // ---------------------------------------------------------------------------

  const ALL_COLUMNS = [
    { id: 'id',       label: '#',                required: true },
    { id: 'subject',  label: 'Subject / Preview' },
    { id: 'sla',      label: 'SLA' },
    { id: 'urgency',  label: 'Urgency' },
    { id: 'priority', label: 'Priority' },
    { id: 'company',  label: 'Company' },
    { id: 'team',     label: 'Team' },
    { id: 'created',  label: 'Created' },
    { id: 'updated',  label: 'Updated' },
  ];

  const DEFAULT_COL_IDS = ['id', 'subject', 'sla', 'created', 'updated'];

  function loadColumnPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_COLUMNS));
      if (Array.isArray(saved) && saved.length >= 2) {
        const validIds = new Set(ALL_COLUMNS.map(c => c.id));
        const filtered = saved.filter(id => validIds.has(id));
        const required = ALL_COLUMNS.filter(c => c.required).map(c => c.id);
        if (required.every(id => filtered.includes(id))) return filtered;
      }
    } catch (_) {}
    return [...DEFAULT_COL_IDS];
  }

  function saveColumnPrefs(cols) {
    localStorage.setItem(STORAGE_COLUMNS, JSON.stringify(cols));
  }

  function loadFilterPrefs() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_FILTERS));
      if (Array.isArray(saved) && saved.length >= 1) {
        const validKeys = new Set(ALL_FILTER_CARDS.map(c => c.key));
        const filtered = saved.filter(k => validKeys.has(k));
        const required = ALL_FILTER_CARDS.filter(c => c.required).map(c => c.key);
        if (required.every(k => filtered.includes(k))) return filtered;
      }
    } catch (_) {}
    return ALL_FILTER_CARDS.map(c => c.key);
  }

  function saveFilterPrefs(keys) {
    localStorage.setItem(STORAGE_FILTERS, JSON.stringify(keys));
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const datasets = {
    [F_BACKLOG]: [], [F_ASSIGNED_TODAY]: [], [F_ASSIGNED_WEEK]: [],
    [F_REPLIED_TODAY]: [], [F_REPLIED_WEEK]: [], [F_CLOSED_WEEK]: [],
    [F_UNASSIGNED]: [],
  };

  let dismissedIds = new Set(JSON.parse(localStorage.getItem(STORAGE_DISMISSED) || '[]'));

  let currentAdminId   = localStorage.getItem(STORAGE_ADMIN_ID)   || null;
  let currentAdminName = localStorage.getItem(STORAGE_ADMIN_NAME) || null;
  let activeFilter  = F_BACKLOG;
  let sortMode      = 'sla_asc';
  let urgencyFilter = null;
  let companyFilter = null; // null = all, string = company name
  let activeColumns = loadColumnPrefs();
  let colMgrVisible = false;
  let activeFilterCards = loadFilterPrefs();
  let filterMgrVisible = false;
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
  // Data cache (localStorage)
  // ---------------------------------------------------------------------------

  function saveCache() {
    try {
      const payload = {
        ts: NOW_S(),
        datasets: {},
        convCompanyMap,
        teamsMap: teamsMap || {},
      };
      for (const [k, v] of Object.entries(datasets)) payload.datasets[k] = v;
      localStorage.setItem(STORAGE_CACHE, JSON.stringify(payload));
    } catch (_) {}
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(STORAGE_CACHE);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const { ts, datasets: cached } = parsed;
      if (!ts || !cached) return false;
      for (const [k, v] of Object.entries(cached)) {
        if (datasets.hasOwnProperty(k)) datasets[k] = v;
      }
      if (parsed.convCompanyMap) convCompanyMap = parsed.convCompanyMap;
      if (parsed.teamsMap) teamsMap = parsed.teamsMap;
      lastLoadedAt = ts;
      return true;
    } catch (_) { return false; }
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

  let teamsMap = null;      // id → name, loaded once
  let companiesMap = null;  // id → name, loaded once
  let convCompanyMap = {};  // conv_id → company name

  async function ensureTeamsMap() {
    if (teamsMap) return;
    try {
      const resp = await apiRequest({ path: '/teams' });
      const list = resp.teams ?? resp.data ?? [];
      teamsMap = Object.fromEntries(list.map(t => [String(t.id), t.name]));
      if (debugMode) console.log(`[SII] Teams loaded: ${list.length}`, teamsMap);
    } catch (err) {
      if (debugMode) console.warn('[SII] Failed to load teams:', err.message);
      teamsMap = {};
    }
  }

  async function ensureCompaniesMap() {
    if (companiesMap) return;
    try {
      const all = [];
      let page = 1;
      let totalPages = 1;
      do {
        const resp = await apiRequest({ path: `/companies?per_page=60&page=${page}` });
        const list = resp.data ?? resp.companies ?? [];
        all.push(...list);
        totalPages = resp.pages?.total_pages ?? 1;
        page++;
      } while (page <= totalPages);
      companiesMap = Object.fromEntries(all.map(c => [String(c.id), c.name]));
    } catch (_) {
      companiesMap = {};
    }
  }

  async function resolveConvCompanies(allConvs) {
    // Collect unique contact IDs from all conversations
    const contactIds = new Set();
    for (const conv of allConvs) {
      const contacts = conv.contacts?.contacts ?? conv.contacts?.data ?? [];
      for (const c of contacts) if (c.id) contactIds.add(c.id);
    }
    if (!contactIds.size) {
      if (debugMode) console.log('[SII] Company resolution: no contact IDs found in conversations');
      return;
    }

    // Fetch each contact's full profile to read their company associations.
    // GET /contacts/{id} returns { companies: { data: [{ id, name, ... }] } }
    const contactCompany = {}; // contact_id → company_name
    const ids = [...contactIds];
    const CONCURRENCY = 5;
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const batch = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(id => apiRequest({ path: `/contacts/${id}` }))
      );
      results.forEach((result, idx) => {
        if (result.status !== 'fulfilled') return;
        const contact = result.value;
        // Try every known shape the companies field can take
        const companies = contact.companies?.data
          ?? contact.companies?.companies
          ?? (Array.isArray(contact.companies) ? contact.companies : []);
        if (companies.length) {
          const comp = companies[0];
          const name = comp.name || companiesMap?.[String(comp.id)] || null;
          if (name) contactCompany[batch[idx]] = name;
        }
      });
    }

    // Map conv → company via first contact that has a company
    convCompanyMap = {};
    for (const conv of allConvs) {
      const contacts = conv.contacts?.contacts ?? conv.contacts?.data ?? [];
      for (const c of contacts) {
        if (contactCompany[c.id]) {
          convCompanyMap[String(conv.id)] = contactCompany[c.id];
          break;
        }
      }
    }

    if (debugMode) {
      console.log(`[SII] Company resolution: ${contactIds.size} contacts → ${Object.keys(contactCompany).length} with companies → ${Object.keys(convCompanyMap).length} convs mapped`);
      if (!Object.keys(contactCompany).length && ids.length) {
        // Dump a sample contact response to help debug
        try {
          const sample = await apiRequest({ path: `/contacts/${ids[0]}` });
          console.log('[SII] Sample contact response:', JSON.stringify(sample, null, 2));
        } catch (_) {}
      }
    }
  }

  function tryAdminFromSession() {
    // Intercom stores the current admin's info in its Ember session
    try {
      const raw = localStorage.getItem('ember_simple_auth-session');
      if (raw) {
        const auth = JSON.parse(raw)?.authenticated;
        if (auth?.admin_id) {
          currentAdminId = String(auth.admin_id);
          localStorage.setItem(STORAGE_ADMIN_ID, currentAdminId);
          // Name may also be available
          if (auth.name || auth.email) {
            currentAdminName = auth.name || auth.email;
            localStorage.setItem(STORAGE_ADMIN_NAME, currentAdminName);
          }
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  async function ensureAdminInfo() {
    if (currentAdminId) return;
    // Try to get admin ID from Intercom's own session data (no API call)
    if (tryAdminFromSession()) {
      // If we got the ID but not the name, resolve it from the admins list
      if (!currentAdminName) {
        try {
          const resp = await apiRequest({ path: '/admins' });
          const admins = resp.admins ?? resp.data ?? [];
          const me = admins.find(a => String(a.id) === currentAdminId);
          if (me) {
            currentAdminName = me.name || me.email || 'You';
            localStorage.setItem(STORAGE_ADMIN_NAME, currentAdminName);
          }
        } catch (_) {}
      }
      return;
    }
    // Fallback: fetch admins list and match by looking at who's logged in
    // This covers edge cases where the Ember session key format changes
    const resp = await apiRequest({ path: '/admins' });
    const admins = (resp.admins ?? resp.data ?? []).filter(a => a.type === 'admin');
    if (admins.length === 0) throw new Error('No admins found. Check your API token permissions.');
    // If only one admin, use them
    if (admins.length === 1) {
      currentAdminId   = String(admins[0].id);
      currentAdminName = admins[0].name || admins[0].email || 'You';
    } else {
      // Try to match via Intercom's cookie or page context
      const match = tryMatchAdminFromPage(admins);
      if (match) {
        currentAdminId   = String(match.id);
        currentAdminName = match.name || match.email || 'You';
      } else {
        // Last resort: use the first non-bot admin
        const first = admins[0];
        currentAdminId   = String(first.id);
        currentAdminName = first.name || first.email || 'You';
        console.warn('[SII] Could not detect current admin — defaulting to:', currentAdminName);
      }
    }
    localStorage.setItem(STORAGE_ADMIN_ID,   currentAdminId);
    localStorage.setItem(STORAGE_ADMIN_NAME, currentAdminName);
  }

  function tryMatchAdminFromPage(admins) {
    // Try to find the admin's email/name from Intercom's page context
    try {
      const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
      // Intercom sometimes exposes the current admin on the app object
      const appAdmin = win.Intercom?.booted_data?.admin
        || win.__INTERCOM_ADMIN__
        || null;
      if (appAdmin?.id) {
        const m = admins.find(a => String(a.id) === String(appAdmin.id));
        if (m) return m;
      }
      // Match by email from Ember session (even if admin_id wasn't there)
      const raw = localStorage.getItem('ember_simple_auth-session');
      if (raw) {
        const auth = JSON.parse(raw)?.authenticated;
        if (auth?.email) {
          const m = admins.find(a => a.email === auth.email);
          if (m) return m;
        }
      }
    } catch (_) {}
    return null;
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
    await Promise.all([ensureTeamsMap(), ensureCompaniesMap()]);
    const adminId = parseInt(currentAdminId, 10);

    // Unassigned: conversations where the individual assignee is empty
    const unassignedPromise = fetchAllConvs([
      { field: 'state', operator: '=', value: 'open' },
      { field: 'admin_assignee_id', operator: '=', value: 0 },
    ]).catch(() => []);

    const [backlog, assignedThisWeek, repliedThisWeek, closedThisWeek, unassigned] = await Promise.all([
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
      unassignedPromise,
    ]);

    datasets[F_BACKLOG]        = backlog;
    datasets[F_ASSIGNED_WEEK]  = assignedThisWeek;
    datasets[F_ASSIGNED_TODAY] = assignedThisWeek.filter(c => (c.statistics?.last_assignment_at ?? 0) >= TODAY_START_S);
    datasets[F_CLOSED_WEEK]    = closedThisWeek;
    datasets[F_REPLIED_WEEK]   = repliedThisWeek;
    datasets[F_REPLIED_TODAY]  = repliedThisWeek.filter(c => (c.statistics?.last_admin_reply_at ?? 0) >= TODAY_START_S);
    datasets[F_UNASSIGNED]     = unassigned.filter(c => !c.assignee || c.assignee.type === 'nobody');

    // Resolve company names from contacts (non-blocking for cache)
    const allConvs = [...new Map([...backlog, ...assignedThisWeek, ...repliedThisWeek, ...closedThisWeek, ...unassigned].map(c => [c.id, c])).values()];
    await resolveConvCompanies(allConvs);

    clearDismissed();
    urgencyFilter = null;
    companyFilter = null;
    saveCache();

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

    if (urgencyFilter !== null) {
      convs = convs.filter(c => String(getUrgency(c) ?? '') === urgencyFilter);
    }

    if (companyFilter !== null) {
      convs = convs.filter(c => (convCompanyMap[String(c.id)] || '') === companyFilter);
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

      if (sortMode === 'company_asc' || sortMode === 'company_desc') {
        const ca = (convCompanyMap[String(a.id)] || '').toLowerCase();
        const cb = (convCompanyMap[String(b.id)] || '').toLowerCase();
        // Push empty company names to the end regardless of direction
        if (!ca && cb) return 1;
        if (ca && !cb) return -1;
        const diff = ca.localeCompare(cb);
        return sortMode === 'company_desc' ? -diff : diff;
      }

      if (sortMode === 'urgency_asc' || sortMode === 'urgency_desc') {
        const urgOrd = { critical: 0, high: 1, medium: 2, low: 3 };
        const ua = urgOrd[(getUrgency(a) || '').toLowerCase()] ?? 99;
        const ub = urgOrd[(getUrgency(b) || '').toLowerCase()] ?? 99;
        const diff = ua - ub;
        return sortMode === 'urgency_desc' ? -diff : diff;
      }

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
      [F_UNASSIGNED]:     datasets[F_UNASSIGNED].length,
    };
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function getSlaBreachTs(sla) {
    // Try every known field name Intercom uses across API versions
    return sla.next_breach_at || sla.breach_at || sla.sla_breach_at
      || sla.next_breach || sla.due_at || null;
  }

  function fmtSla(conv) {
    // sla_applied can be an object or a 1-element array depending on API version
    let sla = conv.sla_applied;
    if (Array.isArray(sla)) sla = sla[0] ?? null;
    const now = NOW_S();
    if (!sla) return { label: 'No SLA', cls: 'none' };
    const breachTs = getSlaBreachTs(sla);
    const status   = sla.sla_status;

    if (status === 'missed') {
      const over = breachTs ? fmtDur(now - breachTs) : null;
      return { label: over ? `Breached ${over} ago` : 'Breached', cls: 'breached' };
    }
    if (status === 'cancelled') return { label: 'Cancelled', cls: 'none' };
    if (status === 'hit') {
      // Show how far past the deadline it was met, if we have the timestamp
      return { label: breachTs ? `Met (${fmtDur(Math.abs(breachTs - now))})` : 'Met', cls: 'ok' };
    }
    // Active (or unknown status)
    if (breachTs) {
      const rem = breachTs - now;
      if (rem <= 0) return { label: `Breached ${fmtDur(-rem)} ago`, cls: 'breached' };
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

  function getUrgency(conv) {
    // Case-insensitive search across custom_attributes and ticket_attributes
    for (const bag of [conv.custom_attributes, conv.ticket_attributes]) {
      if (!bag || typeof bag !== 'object') continue;
      for (const key of Object.keys(bag)) {
        if (key.toLowerCase() === 'urgency' && bag[key] != null && bag[key] !== '') return bag[key];
      }
    }
    return null;
  }

  function isPriority(conv) {
    return conv.priority === 'priority';
  }

  function urgencyBadgeCls(urgency) {
    if (!urgency) return 'none';
    const u = String(urgency).toLowerCase();
    if (u === 'urgent' || u === 'high' || u === 'critical') return 'breached';
    if (u === 'medium' || u === 'normal' || u === 'moderate') return 'warning';
    return 'ok';
  }

  function filterLabel(key) {
    const labels = {
      [F_BACKLOG]: 'Backlog', [F_SLA_BREACHED]: 'SLA Breached', [F_SLA_WARNING]: 'SLA Warning',
      [F_ASSIGNED_TODAY]: 'Assigned to Me Today', [F_ASSIGNED_WEEK]: 'Assigned to Me This Week',
      [F_REPLIED_TODAY]: 'Replied Today', [F_REPLIED_WEEK]: 'Replied This Week',
      [F_CLOSED_WEEK]: 'Closed This Week', [F_UNASSIGNED]: 'Unassigned',
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
      width: 7px; height: 7px; border-radius: 50%;
      flex-shrink: 0; position: absolute; top: 4px; right: 4px;
      transition: background 0.3s;
    }
    /* No token */
    #sii-btn.st-none .sii-dot     { background: #e53e3e; }
    /* Loading */
    #sii-btn.st-loading .sii-dot  { background: #1f73b7; animation: sii-pulse 1s ease-in-out infinite; }
    @keyframes sii-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.4; transform: scale(1.5); }
    }
    /* Fresh data */
    #sii-btn.st-fresh .sii-dot    { background: #4caf50; }
    /* Stale data */
    #sii-btn.st-stale .sii-dot    { background: #f59e0b; }
    /* Error on last load */
    #sii-btn.st-error .sii-dot    { background: #e53e3e; animation: sii-err-flash 0.6s ease-in-out 3; }
    @keyframes sii-err-flash {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.2; }
    }

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
      position: relative;
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
    .sii-icon-btn.active { background: #edf4fb; border-color: #1f73b7; color: #1f73b7; }

    #sii-stats {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px;
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
    .sii-stat-card.teal                  { background: #e0f2f1; }
    .sii-stat-card.teal.active           { background: #b2dfdb; border-color: #00796b; }
    .sii-stat-label { font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 4px; }
    .sii-stat-value { font-size: 26px; font-weight: 700; color: #1a1a1a; line-height: 1; }
    .sii-stat-card.warning .sii-stat-value { color: #b76e00; }
    .sii-stat-card.danger  .sii-stat-value { color: #c0392b; }
    .sii-stat-card.info    .sii-stat-value { color: #1565c0; }
    .sii-stat-card.green   .sii-stat-value { color: #2e7d32; }
    .sii-stat-card.purple  .sii-stat-value { color: #7b1fa2; }
    .sii-stat-card.teal    .sii-stat-value { color: #00796b; }
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
    #sii-urgency-filter { display: flex; align-items: center; gap: 6px; }

    /* Company filter dropdown */
    #sii-company-filter { display: flex; align-items: center; gap: 6px; }
    .sii-combo { position: relative; min-width: 180px; }
    .sii-combo-input {
      width: 100%; box-sizing: border-box;
      border: 1px solid #e0e0e0; border-radius: 5px; padding: 4px 28px 4px 10px;
      font-size: 12px; font-family: inherit; color: #333; background: #fff;
      outline: none; transition: border-color 0.15s;
    }
    .sii-combo-input:focus { border-color: #1f73b7; }
    .sii-combo-input::placeholder { color: #aaa; }
    .sii-combo-clear {
      position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; color: #999; font-size: 14px;
      padding: 0 2px; line-height: 1; display: none;
    }
    .sii-combo-clear:hover { color: #333; }
    .sii-combo.has-value .sii-combo-clear { display: block; }
    .sii-combo-list {
      position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
      max-height: 200px; overflow-y: auto; background: #fff;
      border: 1px solid #e0e0e0; border-top: none; border-radius: 0 0 5px 5px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: none;
    }
    .sii-combo.open .sii-combo-list { display: block; }
    .sii-combo-opt {
      padding: 5px 10px; font-size: 12px; cursor: pointer; color: #333;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sii-combo-opt:hover, .sii-combo-opt.highlighted { background: #edf4fb; }
    .sii-combo-opt.active { background: #1f73b7; color: #fff; }
    .sii-combo-empty { padding: 8px 10px; font-size: 11px; color: #999; font-style: italic; }

    /* Column manager panel */
    #sii-col-panel {
      border-bottom: 1px solid #e8eaed; padding: 10px 22px;
      background: #fafbfc; flex-shrink: 0;
      display: flex; align-items: flex-start; gap: 14px;
    }
    .sii-col-panel-label {
      font-size: 10px; font-weight: 700; color: #999; text-transform: uppercase;
      letter-spacing: 0.4px; padding-top: 5px; white-space: nowrap; flex-shrink: 0;
    }
    .sii-col-list { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
    .sii-col-item {
      display: flex; align-items: center; gap: 5px;
      background: #fff; border: 1px solid #e0e0e0; border-radius: 6px;
      padding: 4px 9px; font-size: 12px; color: #444;
      user-select: none; transition: border-color 0.1s, box-shadow 0.1s, opacity 0.1s;
    }
    .sii-col-item.draggable { cursor: grab; }
    .sii-col-item.draggable:active { cursor: grabbing; }
    .sii-col-item.inactive { opacity: 0.5; }
    .sii-col-item.required { background: #f0f7ff; border-color: #c5dcf5; cursor: default; }
    .sii-col-item.sii-drag-over { border-color: #1f73b7; box-shadow: 0 0 0 2px #c5dcf5; }
    .sii-col-drag { font-size: 13px; color: #ccc; line-height: 1; width: 10px; }
    .sii-col-item input[type=checkbox] { margin: 0; cursor: pointer; accent-color: #1f73b7; }
    .sii-col-label { white-space: nowrap; }

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
    .sii-badge.priority { background: #fff3cd; color: #856404; }
    .sii-ts { font-size: 11px; color: #aaa; white-space: nowrap; }

    .sii-dismiss-btn {
      background: none; border: 1px solid #e0e0e0; border-radius: 5px;
      padding: 3px 8px; font-size: 11px; color: #999; cursor: pointer;
      transition: all 0.1s; white-space: nowrap;
    }
    .sii-dismiss-btn:hover { background: #f4f5f7; border-color: #bbb; color: #555; }

    .sii-restore-btn {
      background: none; border: 1px solid #d0dce8; border-radius: 5px;
      padding: 3px 8px; font-size: 11px; color: #1f73b7; cursor: pointer;
      transition: all 0.1s; white-space: nowrap;
    }
    .sii-restore-btn:hover { background: #edf4fb; border-color: #1f73b7; }

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
    for (const key of activeFilterCards) {
      const def = ALL_FILTER_CARDS.find(c => c.key === key);
      if (!def) continue;
      const label = (def.key === F_BACKLOG && first) ? `${first}'s Backlog` : (def.label ?? 'Backlog');
      const isActive = activeFilter === key;
      const card = el('div', {
        className: `sii-stat-card ${def.cls}${isActive ? ' active' : ''}${loading ? ' sii-loading' : ''}`,
        onClick: () => setActiveFilter(key),
      },
        el('div', { className: 'sii-stat-label' }, label),
        el('div', { className: 'sii-stat-value' }, loading ? '…' : String(stats[key] ?? 0)),
        el('div', { className: 'sii-stat-sub' }, def.sub),
      );
      card.dataset.statKey = key;
      container.append(card);
    }
  }

  function setActiveFilter(key) {
    activeFilter = key;
    urgencyFilter = null;
    companyFilter = null;
    document.querySelectorAll('.sii-stat-card').forEach(c => c.classList.toggle('active', c.dataset.statKey === key));
    const label = document.getElementById('sii-active-label');
    if (label) label.textContent = filterLabel(key);
    renderCompanyFilter();
    renderUrgencyFilter();
    const convs = getActiveConversations();
    renderList(convs);
    renderFooter(convs);
  }

  // ---------------------------------------------------------------------------
  // Urgency filter
  // ---------------------------------------------------------------------------

  function getUrgencyValues() {
    const now = NOW_S();
    let source;
    if (activeFilter === F_SLA_WARNING) {
      source = datasets[F_BACKLOG].filter(c => {
        const sla = c.sla_applied;
        if (!sla || sla.sla_status !== 'active') return false;
        const rem = sla.next_breach_at - now;
        return rem > 0 && rem <= TWO_HOURS_S;
      });
    } else if (activeFilter === F_SLA_BREACHED) {
      source = datasets[F_BACKLOG].filter(c => c.sla_applied?.sla_status === 'missed');
    } else {
      source = datasets[activeFilter] ?? datasets[F_BACKLOG];
    }
    const vals = new Set();
    for (const c of source) {
      const u = getUrgency(c);
      if (u != null && String(u).trim() !== '') vals.add(String(u));
    }
    return [...vals].sort();
  }

  function renderUrgencyFilter() {
    const container = document.getElementById('sii-urgency-filter');
    const sep = document.getElementById('sii-urgency-sep');
    if (!container) return;
    container.innerHTML = '';

    const vals = getUrgencyValues();
    if (vals.length === 0) {
      if (sep) sep.style.display = 'none';
      return;
    }
    if (sep) sep.style.removeProperty('display');

    const group = el('div', { className: 'sii-tab-group' });

    group.append(el('button', {
      className: `sii-tab${urgencyFilter === null ? ' active' : ''}`,
      onClick() {
        urgencyFilter = null;
        renderUrgencyFilter();
        const convs = getActiveConversations();
        renderList(convs); renderFooter(convs);
      },
    }, 'All'));

    for (const v of vals) {
      group.append(el('button', {
        className: `sii-tab${urgencyFilter === v ? ' active' : ''}`,
        onClick() {
          urgencyFilter = v;
          renderUrgencyFilter();
          const convs = getActiveConversations();
          renderList(convs); renderFooter(convs);
        },
      }, v));
    }

    container.append(el('span', { className: 'sii-ctrl-label' }, 'Urgency:'), group);
  }

  // ---------------------------------------------------------------------------
  // Company filter (searchable dropdown / combobox)
  // ---------------------------------------------------------------------------

  function getCompanyValues() {
    // Collect unique company names from current conversations
    const convs = getActiveConversations();
    const names = new Set();
    for (const c of convs) {
      const name = convCompanyMap[String(c.id)];
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  function renderCompanyFilter() {
    const container = document.getElementById('sii-company-filter');
    const sep = document.getElementById('sii-company-sep');
    if (!container) return;
    container.innerHTML = '';

    const allNames = getCompanyValues();
    if (allNames.length === 0) {
      if (sep) sep.style.display = 'none';
      return;
    }
    if (sep) sep.style.removeProperty('display');

    let highlightIdx = -1;

    const wrapper = el('div', { className: `sii-combo${companyFilter ? ' has-value' : ''}` });
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'sii-combo-input';
    input.placeholder = 'All companies';
    input.value = companyFilter || '';

    const clearBtn = el('button', { className: 'sii-combo-clear', onClick(e) {
      e.stopPropagation();
      companyFilter = null;
      input.value = '';
      wrapper.classList.remove('has-value', 'open');
      const convs = getActiveConversations();
      renderList(convs); renderFooter(convs);
    }}, '×');

    const listBox = el('div', { className: 'sii-combo-list' });

    function buildOptions(filter) {
      listBox.innerHTML = '';
      highlightIdx = -1;
      const q = (filter || '').toLowerCase();
      const filtered = q ? allNames.filter(n => n.toLowerCase().includes(q)) : allNames;
      if (!filtered.length) {
        listBox.append(el('div', { className: 'sii-combo-empty' }, 'No matches'));
        return;
      }
      for (let i = 0; i < filtered.length; i++) {
        const name = filtered[i];
        const isActive = name === companyFilter;
        const opt = el('div', {
          className: `sii-combo-opt${isActive ? ' active' : ''}`,
          'data-idx': i,
          onMousedown(e) {
            e.preventDefault(); // prevent blur
            selectCompany(name);
          },
          onMouseenter() {
            listBox.querySelectorAll('.highlighted').forEach(o => o.classList.remove('highlighted'));
            opt.classList.add('highlighted');
            highlightIdx = i;
          },
        }, name);
        listBox.append(opt);
      }
    }

    function selectCompany(name) {
      companyFilter = name;
      input.value = name;
      wrapper.classList.add('has-value');
      wrapper.classList.remove('open');
      const convs = getActiveConversations();
      renderList(convs); renderFooter(convs);
    }

    input.addEventListener('focus', () => {
      buildOptions(input.value);
      wrapper.classList.add('open');
    });

    input.addEventListener('blur', () => {
      // Small delay to let mousedown on option fire first
      setTimeout(() => wrapper.classList.remove('open'), 150);
    });

    input.addEventListener('input', () => {
      buildOptions(input.value);
      if (!wrapper.classList.contains('open')) wrapper.classList.add('open');
      // If user clears the input, reset the filter
      if (!input.value.trim()) {
        companyFilter = null;
        wrapper.classList.remove('has-value');
        const convs = getActiveConversations();
        renderList(convs); renderFooter(convs);
      }
    });

    input.addEventListener('keydown', (e) => {
      const opts = listBox.querySelectorAll('.sii-combo-opt');
      if (!opts.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightIdx = Math.min(highlightIdx + 1, opts.length - 1);
        opts.forEach(o => o.classList.remove('highlighted'));
        opts[highlightIdx]?.classList.add('highlighted');
        opts[highlightIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightIdx = Math.max(highlightIdx - 1, 0);
        opts.forEach(o => o.classList.remove('highlighted'));
        opts[highlightIdx]?.classList.add('highlighted');
        opts[highlightIdx]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIdx >= 0 && opts[highlightIdx]) {
          selectCompany(opts[highlightIdx].textContent);
        }
      } else if (e.key === 'Escape') {
        wrapper.classList.remove('open');
        input.blur();
      }
    });

    wrapper.append(input, clearBtn, listBox);
    container.append(el('span', { className: 'sii-ctrl-label' }, 'Company:'), wrapper);
  }

  // ---------------------------------------------------------------------------
  // Column manager
  // ---------------------------------------------------------------------------

  function toggleColMgr() {
    colMgrVisible = !colMgrVisible;
    document.getElementById('sii-col-btn')?.classList.toggle('active', colMgrVisible);
    renderColMgr();
  }

  function renderColMgr() {
    document.getElementById('sii-col-panel')?.remove();
    if (!colMgrVisible) return;

    let dragSrcId = null;
    const list = el('div', { className: 'sii-col-list' });

    function makeItem(colId, isActive) {
      const col = ALL_COLUMNS.find(c => c.id === colId);
      if (!col) return null;
      const isRequired = col.required;
      const isDraggable = isActive && !isRequired;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isActive;
      if (isRequired) cb.disabled = true;
      cb.addEventListener('change', () => {
        if (cb.checked && !activeColumns.includes(colId)) {
          activeColumns = [...activeColumns, colId];
        } else if (!cb.checked) {
          activeColumns = activeColumns.filter(id => id !== colId);
        }
        saveColumnPrefs(activeColumns);
        renderColMgr();
        renderList(getActiveConversations());
      });

      const classes = ['sii-col-item'];
      if (isRequired) classes.push('required');
      if (!isActive) classes.push('inactive');
      if (isDraggable) classes.push('draggable');

      const item = el('div', {
        className: classes.join(' '),
        'data-col-id': colId,
      },
        el('span', { className: 'sii-col-drag' }, isDraggable ? '⠿' : ''),
        cb,
        el('span', { className: 'sii-col-label' }, col.label || colId),
      );

      if (isDraggable) {
        item.setAttribute('draggable', 'true');
        item.addEventListener('dragstart', e => {
          dragSrcId = colId;
          e.dataTransfer.effectAllowed = 'move';
          setTimeout(() => item.style.opacity = '0.4', 0);
        });
        item.addEventListener('dragend', () => {
          dragSrcId = null;
          item.style.opacity = '';
          list.querySelectorAll('.sii-drag-over').forEach(i => i.classList.remove('sii-drag-over'));
        });
        item.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          list.querySelectorAll('.sii-drag-over').forEach(i => i.classList.remove('sii-drag-over'));
          if (dragSrcId !== colId) item.classList.add('sii-drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('sii-drag-over'));
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('sii-drag-over');
          if (!dragSrcId || dragSrcId === colId) return;
          const newCols = [...activeColumns];
          const from = newCols.indexOf(dragSrcId);
          const to   = newCols.indexOf(colId);
          if (from < 0 || to < 0) return;
          newCols.splice(from, 1);
          newCols.splice(to, 0, dragSrcId);
          activeColumns = newCols;
          saveColumnPrefs(activeColumns);
          renderColMgr();
          renderList(getActiveConversations());
        });
      }

      return item;
    }

    // Active columns in current order
    for (const colId of activeColumns) {
      const item = makeItem(colId, true);
      if (item) list.append(item);
    }

    // Inactive (unchecked) columns
    for (const col of ALL_COLUMNS) {
      if (activeColumns.includes(col.id) || col.required) continue;
      const item = makeItem(col.id, false);
      if (item) list.append(item);
    }

    const panel = el('div', { id: 'sii-col-panel' },
      el('span', { className: 'sii-col-panel-label' }, 'Drag to reorder'),
      list,
    );

    const controls = document.getElementById('sii-controls');
    if (controls) controls.after(panel);
  }

  // ---------------------------------------------------------------------------
  // Filter manager
  // ---------------------------------------------------------------------------

  function toggleFilterMgr() {
    filterMgrVisible = !filterMgrVisible;
    document.getElementById('sii-filter-btn')?.classList.toggle('active', filterMgrVisible);
    renderFilterMgr();
  }

  function renderFilterMgr() {
    document.getElementById('sii-filter-panel')?.remove();
    if (!filterMgrVisible) return;

    let dragSrcKey = null;
    const list = el('div', { className: 'sii-col-list' });

    function makeItem(key, isActive) {
      const def = ALL_FILTER_CARDS.find(c => c.key === key);
      if (!def) return null;
      const isRequired = def.required;
      const isDraggable = isActive && !isRequired;
      const first = currentAdminName ? currentAdminName.split(' ')[0] : null;
      const label = (def.key === F_BACKLOG && first) ? `${first}'s Backlog` : (def.label ?? 'Backlog');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isActive;
      if (isRequired) cb.disabled = true;
      cb.addEventListener('change', () => {
        if (cb.checked && !activeFilterCards.includes(key)) {
          activeFilterCards = [...activeFilterCards, key];
        } else if (!cb.checked) {
          activeFilterCards = activeFilterCards.filter(k => k !== key);
          if (activeFilter === key) {
            activeFilter = F_BACKLOG;
            document.getElementById('sii-active-label')?.textContent !== undefined &&
              (document.getElementById('sii-active-label').textContent = filterLabel(F_BACKLOG));
          }
        }
        saveFilterPrefs(activeFilterCards);
        renderFilterMgr();
        renderStats(getStats());
      });

      const classes = ['sii-col-item'];
      if (isRequired) classes.push('required');
      if (!isActive) classes.push('inactive');
      if (isDraggable) classes.push('draggable');

      const item = el('div', { className: classes.join(' '), 'data-filter-key': key },
        el('span', { className: 'sii-col-drag' }, isDraggable ? '⠿' : ''),
        cb,
        el('span', { className: 'sii-col-label' }, label),
      );

      if (isDraggable) {
        item.setAttribute('draggable', 'true');
        item.addEventListener('dragstart', e => {
          dragSrcKey = key;
          e.dataTransfer.effectAllowed = 'move';
          setTimeout(() => item.style.opacity = '0.4', 0);
        });
        item.addEventListener('dragend', () => {
          dragSrcKey = null;
          item.style.opacity = '';
          list.querySelectorAll('.sii-drag-over').forEach(i => i.classList.remove('sii-drag-over'));
        });
        item.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          list.querySelectorAll('.sii-drag-over').forEach(i => i.classList.remove('sii-drag-over'));
          if (dragSrcKey !== key) item.classList.add('sii-drag-over');
        });
        item.addEventListener('dragleave', () => item.classList.remove('sii-drag-over'));
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('sii-drag-over');
          if (!dragSrcKey || dragSrcKey === key) return;
          const newKeys = [...activeFilterCards];
          const from = newKeys.indexOf(dragSrcKey);
          const to   = newKeys.indexOf(key);
          if (from < 0 || to < 0) return;
          newKeys.splice(from, 1);
          newKeys.splice(to, 0, dragSrcKey);
          activeFilterCards = newKeys;
          saveFilterPrefs(activeFilterCards);
          renderFilterMgr();
          renderStats(getStats());
        });
      }

      return item;
    }

    for (const key of activeFilterCards) {
      const item = makeItem(key, true);
      if (item) list.append(item);
    }
    for (const def of ALL_FILTER_CARDS) {
      if (activeFilterCards.includes(def.key) || def.required) continue;
      const item = makeItem(def.key, false);
      if (item) list.append(item);
    }

    const panel = el('div', { id: 'sii-filter-panel', className: 'sii-col-panel' },
      el('span', { className: 'sii-col-panel-label' }, 'Drag to reorder'),
      list,
    );

    const stats = document.getElementById('sii-stats');
    if (stats) stats.before(panel);
  }

  // ---------------------------------------------------------------------------
  // Render — list (with dismiss/restore support)
  // ---------------------------------------------------------------------------

  function buildRow(conv, isDismissed) {
    const sla = fmtSla(conv);
    const href = `https://app.intercom.com/a/inbox/_/inbox/conversation/${conv.id}`;
    const canDismiss = DISMISSABLE_FILTERS.has(activeFilter);

    const cells = [];
    for (const colId of activeColumns) {
      switch (colId) {
        case 'id':
          cells.push(el('td', {},
            el('a', { className: 'sii-conv-id', href, target: '_blank', onClick: e => e.stopPropagation() }, `#${conv.id}`)
          ));
          break;
        case 'subject':
          cells.push(el('td', {}, el('span', { className: 'sii-subject' }, getSubject(conv))));
          break;
        case 'sla':
          cells.push(el('td', {}, el('span', { className: `sii-badge ${sla.cls}` }, sla.label)));
          break;
        case 'urgency': {
          const u = getUrgency(conv);
          cells.push(el('td', {}, el('span', { className: `sii-badge ${urgencyBadgeCls(u)}` }, u || '—')));
          break;
        }
        case 'priority':
          cells.push(el('td', {},
            isPriority(conv)
              ? el('span', { className: 'sii-badge priority' }, '★ Priority')
              : el('span', { className: 'sii-badge none' }, '—')
          ));
          break;
        case 'company': {
          const companyName = convCompanyMap[String(conv.id)] || '—';
          cells.push(el('td', {}, el('span', { className: 'sii-ts' }, companyName)));
          break;
        }
        case 'team': {
          const team = conv.team_assignee_id
            ? (teamsMap?.[String(conv.team_assignee_id)] ?? `Team ${conv.team_assignee_id}`)
            : '—';
          cells.push(el('td', {}, el('span', { className: 'sii-ts' }, team)));
          break;
        }
        case 'created':
          cells.push(el('td', {}, el('span', { className: 'sii-ts' }, fmtDate(conv.created_at))));
          break;
        case 'updated':
          cells.push(el('td', {}, el('span', { className: 'sii-ts' }, fmtDate(conv.updated_at))));
          break;
      }
    }

    if (canDismiss) {
      const actionCell = el('td', {});
      if (!isDismissed) {
        actionCell.append(el('button', {
          className: 'sii-dismiss-btn',
          onClick(e) {
            e.stopPropagation();
            dismissedIds.add(String(conv.id));
            saveDismissed();
            const convs = getActiveConversations();
            renderList(convs); renderFooter(convs);
          },
        }, '✓ Done'));
      } else {
        actionCell.append(el('button', {
          className: 'sii-restore-btn',
          onClick(e) {
            e.stopPropagation();
            dismissedIds.delete(String(conv.id));
            saveDismissed();
            const convs = getActiveConversations();
            renderList(convs); renderFooter(convs);
          },
        }, '↩ Restore'));
      }
      cells.push(actionCell);
    }

    return el('tr', {
      className: `sii-row${isDismissed ? ' dismissed' : ''}`,
      onClick() { window.open(href, '_blank'); },
    }, ...cells);
  }

  function buildTableHeader(canDismiss) {
    const labels = {
      id: '#', subject: 'Subject / Preview', sla: 'SLA',
      urgency: 'Urgency', priority: 'Priority', company: 'Company', team: 'Team', created: 'Created', updated: 'Updated',
    };
    const ths = activeColumns.map(id => `<th>${labels[id] ?? id}</th>`).join('');
    return `<tr>${ths}${canDismiss ? '<th></th>' : ''}</tr>`;
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
      body.append(el('div', { id: 'sii-waiting' }, 'No API token configured.', el('span', { className: 'sii-waiting-hint' }, 'Generate one at Settings → Developers → API Keys.'), el('button', { className: 'sii-icon-btn', onClick: showSettings }, 'Enter API token')));
      return;
    }

    const canDismiss = DISMISSABLE_FILTERS.has(activeFilter);
    const active    = canDismiss ? convs.filter(c => !dismissedIds.has(String(c.id))) : convs;
    const dismissed = canDismiss ? convs.filter(c =>  dismissedIds.has(String(c.id))) : [];

    if (!active.length && !dismissed.length) {
      body.append(el('div', { id: 'sii-empty' }, `No conversations in ${filterLabel(activeFilter)}.`));
      return;
    }

    const table = el('table', { className: 'sii-table' });
    const thead = el('thead');
    thead.innerHTML = buildTableHeader(canDismiss);
    table.append(thead);

    const tbody = el('tbody');
    for (const conv of active) tbody.append(buildRow(conv, false));

    if (dismissed.length > 0) {
      const dividerRow = el('tr');
      const dividerCell = el('td', {
        className: 'sii-dismissed-header',
        colspan: String(activeColumns.length + (canDismiss ? 1 : 0)),
      }, `Dismissed (${dismissed.length})`);
      dividerRow.append(dividerCell);
      tbody.append(dividerRow);
      for (const conv of dismissed) tbody.append(buildRow(conv, true));
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
    const urgencyText = urgencyFilter ? ` · Urgency: ${urgencyFilter}` : '';
    const companyText = companyFilter ? ` · Company: ${companyFilter}` : '';
    f.textContent = `${filterLabel(activeFilter)} · ${activeCount} active${dismissedText}${companyText}${urgencyText} · Refreshed ${new Date().toLocaleTimeString()}`;
  }

  // ---------------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------------

  let settingsVisible = false;

  function showSettings() {
    if (settingsVisible) return;
    settingsVisible = true;
    colMgrVisible = false;
    filterMgrVisible = false;
    document.getElementById('sii-col-panel')?.remove();
    document.getElementById('sii-filter-panel')?.remove();
    document.getElementById('sii-col-btn')?.classList.remove('active');
    document.getElementById('sii-filter-btn')?.classList.remove('active');
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
      el('h3', {}, 'API Token'),
      el('p', {}, 'Paste your Intercom API token below. Generate one at Settings → Developers → API Keys.'),
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
          currentAdminId = null; currentAdminName = null;          localStorage.removeItem(STORAGE_ADMIN_ID);
          localStorage.removeItem(STORAGE_ADMIN_NAME);
          hideSettings();
          handleRefresh();
        }}, 'Save & Load'),
        el('button', { className: 'sii-danger-btn', onClick() {
          [STORAGE_TOKEN, STORAGE_ADMIN_ID, STORAGE_ADMIN_NAME, STORAGE_DISMISSED, STORAGE_REFRESH, STORAGE_CACHE].forEach(k => localStorage.removeItem(k));
          currentAdminId = null; currentAdminName = null; lastLoadedAt = 0;
          clearDismissed();
          hideSettings();
          updateButtonStatus('st-none');
        }}, 'Clear saved data'),
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
          el('button', { id: 'sii-filter-btn', className: 'sii-icon-btn', onClick: toggleFilterMgr }, '⊟ Filters'),
          el('button', { id: 'sii-col-btn', className: 'sii-icon-btn', onClick: toggleColMgr }, '⊞ Columns'),
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
        el('div', { className: 'sii-sep', id: 'sii-company-sep', style: { display: 'none' } }),
        el('div', { id: 'sii-company-filter' }),
        el('div', { className: 'sii-sep', id: 'sii-urgency-sep', style: { display: 'none' } }),
        el('div', { id: 'sii-urgency-filter' }),
      ),
      el('div', { id: 'sii-body' }),
      el('div', { id: 'sii-footer' }, ''),
    );

    overlay.append(modal);
    return overlay;
  }

  const SORT_CATS = [
    { key: 'sla', label: 'SLA', defaultDir: 'asc' },
    { key: 'urgency', label: 'Urgency', defaultDir: 'asc' },
    { key: 'company', label: 'Company', defaultDir: 'asc' },
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

    // Try to restore cached data if we have nothing in memory
    const hasData = lastLoadedAt > 0;
    if (!hasData) loadCache();
    const hasCached = lastLoadedAt > 0;
    const isFresh = hasCached && (NOW_S() - lastLoadedAt < getStaleSecs());

    if (hasCached) {
      // Show cached data immediately
      renderStats(getStats(), !isFresh);
      const convs = getActiveConversations();
      renderList(convs);
      renderFooter(convs);
      renderCompanyFilter();
      renderUrgencyFilter();
      // Background-refresh if stale
      if (!isFresh) handleRefresh();
    } else {
      renderStats({}, true);
      handleRefresh();
    }
  }

  function closeModal() {
    document.getElementById('sii-overlay')?.remove();
    settingsVisible = false;
    colMgrVisible = false;
  }

  // ---------------------------------------------------------------------------
  // Button status indicator
  // ---------------------------------------------------------------------------

  const BTN_STATES = ['st-none', 'st-loading', 'st-fresh', 'st-stale', 'st-error'];

  function updateButtonStatus(state) {
    const btn = document.getElementById('sii-btn');
    if (!btn) return;
    btn.classList.remove(...BTN_STATES);
    btn.classList.add(state);
  }

  function computeButtonStatus() {
    if (!getToken()) return 'st-none';
    if (isLoading) return 'st-loading';
    if (lastLoadedAt <= 0) return 'st-none';
    if (NOW_S() - lastLoadedAt < getStaleSecs()) return 'st-fresh';
    return 'st-stale';
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  async function handleRefresh() {
    if (isLoading) return;
    if (!getToken()) { updateButtonStatus('st-none'); renderList([]); return; }

    isLoading = true;
    updateButtonStatus('st-loading');
    const hasCachedData = lastLoadedAt > 0;
    document.querySelectorAll('.sii-stat-card').forEach(c => c.classList.add('sii-loading'));
    // Only show full-screen spinner if there's no cached data to display
    if (!hasCachedData) {
      const body = document.getElementById('sii-body');
      if (body) {
        body.innerHTML = '';
        body.append(el('div', { id: 'sii-loading' }, el('div', { className: 'sii-spinner' }), 'Loading all datasets…', el('span', { className: 'sii-loading-sub' }, 'Fetching backlog, assignments, replies, closed, and unassigned in parallel…')));
      }
    }

    try {
      await ensureAdminInfo();
      const chip = document.getElementById('sii-admin-chip');
      if (chip && currentAdminName) chip.textContent = `👤 ${currentAdminName}`;
      await loadAllDatasets();
      lastLoadedAt = NOW_S();
      isLoading = false;
      updateButtonStatus('st-fresh');
      const stats = getStats(), convs = getActiveConversations();
      renderStats(stats); renderList(convs); renderFooter(convs); renderCompanyFilter(); renderUrgencyFilter();
    } catch (err) {
      isLoading = false;
      updateButtonStatus('st-error');
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
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);

    document.body.append(el('button', {
      id: 'sii-btn', onClick: () => {
        if (!getToken()) { openModal(); showSettings(); return; }
        openModal();
      },
    }, '☰', el('span', { className: 'sii-dot' })));
    updateButtonStatus(computeButtonStatus());

    setInterval(async () => {
      // Keep button dot in sync (green → amber when data goes stale)
      if (!isLoading) updateButtonStatus(computeButtonStatus());
      if (!getToken() || isLoading) return;
      if (NOW_S() - lastLoadedAt < getStaleSecs()) return;
      try {
        isLoading = true;
        updateButtonStatus('st-loading');
        await ensureAdminInfo();
        await loadAllDatasets();
        lastLoadedAt = NOW_S();
        isLoading = false;
        updateButtonStatus('st-fresh');
        if (document.getElementById('sii-overlay') && !settingsVisible) {
          const stats = getStats(), convs = getActiveConversations();
          renderStats(stats); renderList(convs); renderFooter(convs); renderCompanyFilter(); renderUrgencyFilter();
        }
      } catch (_) {
        isLoading = false;
        updateButtonStatus('st-error');
      }
    }, 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Debug tools
  try {
    const _w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    _w.siiDebug = (on) => {
      debugMode = (on === undefined) ? !debugMode : !!on;
      console.log(`[SII] Debug mode ${debugMode ? 'ON' : 'OFF'}`);
      return debugMode;
    };
    _w.siiInspect = async (...ids) => {
      if (!ids.length) { console.log('[SII] Usage: siiInspect(123456, 789012)'); return; }
      const adminIdStr = String(currentAdminId);
      console.log(`[SII] Inspecting ${ids.length} conversation(s)… Admin ID: ${adminIdStr}`);
      for (const id of ids) {
        try {
          const detail = await apiRequest({ path: `/conversations/${id}` });
          const parts = detail.conversation_parts?.conversation_parts ?? [];
          console.group(`[SII Inspect] Conversation #${id} — ${parts.length} parts`);
          console.log('SLA raw:', detail.sla_applied);
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
    _w.siiSla = (n = 5) => {
      const convs = datasets[F_BACKLOG].slice(0, n);
      if (!convs.length) { console.log('[SII] No backlog data loaded yet.'); return; }
      console.group(`[SII SLA] Raw sla_applied for first ${convs.length} backlog conversations`);
      convs.forEach(c => {
        console.log(`#${c.id}`, JSON.parse(JSON.stringify(c.sla_applied ?? null)));
      });
      console.groupEnd();
    };
  } catch (_) {}

})();
