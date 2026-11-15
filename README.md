# BetterHub

Status: Phases 1-4 written (public site, auth, dashboard, wallet ledger, provider layer, admin v1).
Not yet built: order engine, refunds automation, payment gateway, support tickets.

## Run locally (needs Node 20+)
1. Unzip, open a terminal in the folder.
2. `npm install`
3. Copy `.env.example` to `.env` and fill it in (service account values from Firebase > Project settings > Service accounts).
4. `npx netlify-cli dev`
5. Open http://localhost:8888 (site) and http://localhost:8888/admin.html (admin, needs your email in ADMIN_EMAILS and verified).

Local testing uses your real Firebase project, so wallet credits you make are real data in that project.
In Firebase, publish `firestore.rules` (Firestore > Rules). `localhost` is already an authorized auth domain.

## Files
- index.html, auth.js: public site and sign-up/login
- app.html, dash.js, live.js: customer dashboard
- admin.html, admin.js: admin dashboard
- firebase.js: public web config
- firestore.rules: database security rules
- netlify/functions/: server code (customer.js, admin.js, lib/core.js wallet + pricing, lib/providers.js supplier adapters)
- netlify.toml, package.json: build config
