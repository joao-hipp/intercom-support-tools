# Intercom Support Tools

A personal queue health dashboard for Intercom — gives support engineers a quick overview of their backlog, SLA status, assignments, replies, and closed conversations without leaving the inbox.

![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-green) ![Version](https://img.shields.io/badge/version-2.8.2-blue)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser (Chrome, Firefox, Edge, Safari).
2. Click the link below — Tampermonkey will show an install prompt:

   ### [Click here to install](https://raw.githubusercontent.com/joao-hipp/intercom-support-tools/main/support-interface.user.js)

3. Click **Install**. A ☰ button with a coloured status dot will appear on the right side of your Intercom page.
4. Click it — if no API token is configured yet, Settings will open automatically so you can paste your token.

## Features

### Stat Cards
- **Backlog** — your open conversations assigned to you
- **SLA Breached** — conversations past their SLA deadline
- **SLA Warning** — conversations within 2 hours of breaching SLA
- **Assigned Today / This Week** — new assignments since today or Sunday
- **Replied Today / This Week** — conversations you've replied to
- **Closed This Week** — resolved conversations since Sunday

### Table
- **Configurable columns** — show, hide, and reorder columns to your preference; layout is saved between sessions
- **Columns available:** ID, Subject/Preview, SLA, Urgency, Priority, Responses, Company, Team, Created, Last Updated
- **Urgency column** — shows the ticket urgency badge (e.g. High, Medium, Low)
- **Priority column** — flags conversations marked as priority in Intercom
- **Company column** — shows the company name associated with the conversation's contact
- **Team column** — displays the assigned team name

### Filters
- **Urgency filter** — filter the table to a specific urgency level
- **Unassigned filter** — show only conversations with no assignee
- **Unanswered filter** — show backlog conversations you haven't replied to yet
- **Configurable filter bar** — show, hide, and reorder filter chips; layout is saved between sessions

### Other
- **Dismiss** — mark a conversation as handled to declutter your view without waiting for a data refresh
- **Sorting** — sort by SLA urgency, created date, or last updated
- **Configurable refresh** — set how often the dashboard fetches fresh data (default: 30 minutes)
- **Status indicator** — the floating button's dot changes colour to reflect the current state: red (no token), pulsing blue (loading), green (data fresh), amber (data stale), flashing red (error)
- **Admin switcher** — searchable dropdown to view any teammate's queue; auto-detects your identity on load, with a fallback picker for ViolentMonkey and Orion Browser
- **Progressive loading** — stat cards update individually as each data group resolves; no more waiting for all queries to finish
- **Data caching** — conversation data is cached in localStorage so the dashboard opens instantly with cached data while a background refresh runs

## Auto-Updates

The script updates automatically via Tampermonkey. Verify your settings once:

1. Open Tampermonkey → **Dashboard** → **Settings** tab.
2. Confirm **Check interval** is set (e.g. "Every 12 hours" or "Daily").
3. Confirm **Updates** is enabled.

When a new version is pushed to this repo, Tampermonkey will detect it and update your script automatically.

## Settings

Click the **⚙ Settings** button inside the dashboard to:

- Enter your Intercom API token (generated at Settings → Developers → API Keys)
- Set your preferred auto-refresh interval (in minutes)
- Clear all saved data (token, cache, preferences)

## How It Works

The script runs inside Intercom's web app via Tampermonkey. You provide your Intercom API token once via Settings, and the script queries the Intercom API to build your personal dashboard. All data stays in your browser — nothing is sent to any third-party server.

## Changelog

### v2.8.2
- **Fixed Updated column** — now shows the last meaningful conversation event (reply, assignment, close) instead of Intercom's internal `updated_at` which gets bumped by SLA recalculations and bot workflows

### v2.8.1
- **Smoother admin switching** — switching mid-load now discards stale data instantly via a load-generation counter; no more flash of the previous admin's stats
- **Fewer redundant re-renders** — company and urgency filter UIs only rebuild when available options actually change
- **Deduplicated API calls** — admins list is fetched once on modal open instead of twice
- **Arrow indicator inline** — the ▾ chevron now sits inside the admin chip text for consistent placement

### v2.8.0
- **Admin switcher** — searchable dropdown in the header to view any teammate's queue
- **Cross-browser admin picker** — when auto-detection fails (ViolentMonkey/Orion), a modal prompts the user instead of silently defaulting to the wrong admin
- **Static Backlog label** — stat card now says "Backlog" instead of "{Name}'s Backlog", no longer re-renders on admin switch
- **Admins cache** — `ensureAdminsCache()` avoids redundant `/admins` API calls
- **Pending admin switch** — queues refresh if user switches admin mid-load
- **Switcher renders on open** — admins list fetched eagerly so the switcher is interactive immediately
- **Dropdown arrow indicator** — ▾ chevron on admin chip for discoverability

### v2.7.1
- **Code cleanup** — extracted shared helpers (`refreshActiveView`, `slaBreached`/`slaWarning`, `buildDragList`), removed ~94 lines of duplicated logic across SLA filters, column/filter managers, and render calls
- **Derived labels** — `filterLabel()` and table headers now read from existing definitions instead of maintaining separate hardcoded maps

### v2.7.0
- **Responses column** — shows how many public replies you've sent on each conversation; sortable
- **Unanswered filter** — surfaces backlog conversations you haven't replied to yet (assigned to you, zero public replies from you)
- **Progressive loading on refresh** — stat cards update individually as each data group resolves instead of waiting for everything to finish
- **Improved reply detection** — counts replies by checking for actual message body content; excludes Fin bot messages, internal notes, and system events (assignments, tags, etc.)
- **Response counts cached** — `convResponsesMap` is persisted to localStorage so response data loads instantly from cache

### v2.6.1
- **Sort by Company** — alphabetical A→Z or Z→A; no-company conversations pushed to the bottom
- **Sort by Urgency** — Critical → High → Medium → Low or reversed; no-urgency pushed to the bottom

### v2.6.0
- **Searchable company filter** — type-ahead dropdown to filter conversations by company name; keyboard navigation (arrows + Enter), clear button, and auto-populated from current data
- **Fixed company resolution** — switched to `GET /contacts/{id}` for reliable contact-to-company mapping
- **Fixed team names on cached loads** — `teamsMap` is now persisted in the localStorage cache so team names display immediately

### v2.5.0
- **Company column** — resolves and displays company names from conversation contacts via the Intercom Companies API
- Companies are fetched once and cached; contact-to-company mapping is resolved in batches for performance

### v2.4.0 — Performance & UX overhaul
- **Dramatically faster perceived load** — dashboard opens instantly with cached data; fresh data loads in the background. No more waiting minutes on every open
- **Data caching** — all conversation datasets are persisted to localStorage; stale data is shown immediately while a background refresh runs
- **Status indicator on floating button** — coloured dot shows current state: red (no token), pulsing blue (loading), green (fresh), amber (stale), flashing red (error)
- **Automatic admin detection** — reads your identity from Intercom's Ember session; falls back to the admins list if needed (no manual picker or user selection step)
- **Removed session sniffing** — eliminated XHR/fetch interception that caused infinite `user_presence.json` polling and page slowdowns. Users now enter their API token once via Settings
- **Lighter footprint** — removed `@run-at document-start` and `unsafeWindow` grants; script no longer patches browser globals
- First click auto-opens Settings if no token is configured
- Full loading spinner only appears on the very first load (no cache yet)

### v2.3.0
- Added **Team column** with team name resolution
- Added **Urgency column** with colour-coded badges (fixed case-insensitive field lookup)
- Added **Priority column**
- Added **Unassigned filter** (conversations with no assignee)
- **Configurable columns** — show/hide and drag-to-reorder, persisted in localStorage
- **Configurable filter bar** — show/hide filter chips and drag-to-reorder, persisted in localStorage
- Subject/Preview column is now optional (can be hidden)
- SLA column now shows the policy name alongside time remaining or breach status

### v2.0.0
- Initial public release

## Maintainers

- joao@hipp.health
- guilherme@hipp.health
