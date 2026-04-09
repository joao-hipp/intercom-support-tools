# Support Intercom Interface

This project is a single-file browser userscript (`support-interface.user.js`).

- No build step, no package manager, no local dev server.
- The preview/verification workflow does not apply — changes are tested by reloading the script in Tampermonkey/Greasemonkey on `app.intercom.com`.
- Do NOT attempt to run `preview_start` or install dependencies.

## Pre-commit checklist
When bumping version, update **all four** locations:
1. `support-interface.user.js` line 4 — `// @version X.Y.Z`
2. `support-interface.user.js` — `const SCRIPT_VERSION = 'X.Y.Z'`
3. `support-interface.meta.js` line 4 — `// @version X.Y.Z`
4. `README.md` — version badge **and** add a changelog entry
