# Intercom Support Tools

A personal queue health dashboard for Intercom — gives support engineers a quick overview of their backlog, SLA status, assignments, replies, and closed conversations without leaving the inbox.

![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-green) ![Version](https://img.shields.io/badge/version-2.0.0-blue)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser (Chrome, Firefox, Edge, Safari).
2. Click the link below — Tampermonkey will show an install prompt:

   ### [Click here to install](https://raw.githubusercontent.com/joao-hipp/intercom-support-tools/main/support-interface.user.js)

3. Click **Install**. A ☰ button will appear on the right side of your Intercom page.
4. Click it to open the dashboard.

## Features

- **Backlog** — your open conversations assigned to you
- **SLA Breached** — conversations past their SLA deadline
- **SLA Warning** — conversations within 2 hours of breaching SLA
- **Assigned Today / This Week** — new assignments since today or Sunday
- **Replied Today / This Week** — conversations you've replied to
- **Closed This Week** — resolved conversations since Sunday
- **Dismiss** — mark a conversation as handled to declutter your view without waiting for a data refresh
- **Sorting** — sort by SLA urgency, created date, or last updated
- **Configurable refresh** — set how often the dashboard fetches fresh data (default: 30 minutes)
- **Auto token capture** — no manual setup needed; the script captures your Intercom session automatically

## Auto-Updates

The script updates automatically via Tampermonkey. Verify your settings once:

1. Open Tampermonkey → **Dashboard** → **Settings** tab.
2. Confirm **Check interval** is set (e.g. "Every 12 hours" or "Daily").
3. Confirm **Updates** is enabled.

When a new version is pushed to this repo, Tampermonkey will detect it and update your script automatically.

## Settings

Click the **⚙ Settings** button inside the dashboard to:

- Manually enter an Intercom API token if auto-capture didn't work
- Set your preferred auto-refresh interval (in minutes)
- Clear all saved data

## How It Works

The script runs inside Intercom's web app via Tampermonkey. It captures your existing session token from Intercom's own API calls (no separate login needed) and queries the Intercom API to build your personal dashboard. All data stays in your browser — nothing is sent to any third-party server.

## Maintainers

- joao@hipp.health
- guilherme@hipp.health
