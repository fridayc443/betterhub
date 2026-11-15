# BetterHub (complete, latest)

Files
- index.html: public site, sign-up and login
- app.html: customer dashboard (wallet, Paystack funding, transactions, notifications, support tickets)
- admin.html: admin dashboard (overview, supplier check + catalogue explorer, pricing, categories, customers, wallet adjustments, tickets, payments check, settings)
- netlify/functions/api.js: the whole server in one file (wallet ledger, pricing, Get Your OTP adapter, Paystack, tickets)
- netlify.toml, package.json: build settings
- firestore.rules: paste into Firebase > Firestore > Rules > Publish (not deployed with the site)

Netlify environment variables (names only; set the values in Netlify, never in files or chat)
- FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
- ADMIN_EMAILS (your login email, must be verified)
- GYO_API_KEY (Get Your OTP)
- PAYSTACK_SECRET_KEY (use sk_test_ first)
- SITE_URL (optional; set to your custom domain later, default is https://betterhubhq.netlify.app)

Paystack webhook URL: https://betterhubhq.netlify.app/paystack-webhook

Status
- Written and syntax-checked: everything above.
- Not tested against live Firebase, Paystack or Get Your OTP.
- Not built yet: buying numbers (needs Get Your OTP's real replies), automatic refunds, order retries.

Deploy on a phone: the server file needs Netlify's build (npm install), so deploy from a GitHub repo linked to Netlify.
A pages-only upload (betterhub-site.zip) works for the website but not for api.js.
