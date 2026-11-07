# MotionForge — Pixmo-powered public AI video platform (Version 3)

A multi-user web application with a public marketing homepage, brand mark, sample pricing section, account registration/sign-in, customer video dashboard, credit balances, Pixmo text-to-video generation, M-Pesa top-ups, and an administrator dashboard.

## Included

- Public registration and login with bcrypt password hashing.
- SQLite database for users, sessions, video jobs, and credit ledger.
- Server-side Pixmo API key; it is never sent to browsers.
- Text-to-video with Pixmo `sd2` and `sd2-fast`.
- Per-user credit accounting and generation limits.
- Job status polling and video library.
- Admin account provisioned from environment variables.
- Admin user overview and manual credit grants.
- M-Pesa Daraja STK Push top-ups, callback handling, and transaction query verification.
- Sample KES credit packages and payment history.
- Responsive public homepage with custom SVG logo, feature overview, workflow and sample pricing.
- Customer workspace with video library, credit history and M-Pesa top-ups.
- Admin panel with user/job/payment overview and manual credit adjustments.
- Custom-domain-ready Node deployment and environment-based configuration.
- Dockerfile and Render deployment blueprint.

## Requirements

- Node.js 20+
- A Pixmo API key
- A persistent disk/database volume for production hosting

## Run locally

1. Extract the ZIP.
2. Copy `.env.example` to `.env`.
3. Set `PIXMO_API_KEY`, `SESSION_SECRET`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD`.
4. Run:

   ```bash
   npm install
   npm start
   ```

5. Open `http://localhost:3000`.

The first administrator account is created on first startup using `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Change the example admin password before starting.

## Deploy online (Render example)

1. Push this folder to a private GitHub repository.
2. In Render, create a new Blueprint and select that repository.
3. Render reads `render.yaml`. Add the secret values for `PIXMO_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `APP_URL`.
4. Attach/retain the persistent disk mounted at `/var/data`. SQLite data must live on persistent storage.
5. Deploy. Visit the generated Render URL and sign in using your admin credentials.
6. Test a new account, then a low-cost 4-second video generation.

You can also deploy the included Dockerfile to another Node/Docker host. Ensure the host provides a persistent volume and HTTPS.

## Credits and Pixmo billing

This starter charges end users:
- `sd2-fast`: 5 platform credits per output second at the standard 720p tier.
- `sd2`: 6 platform credits per output second at the standard 720p tier.

These are mapped to Pixmo's published standard 720p rates. The platform grants `SIGNUP_CREDITS` on registration (25 by default). Admins can manually grant credits in the dashboard. Set `SIGNUP_CREDITS=0` if you do not want free signup credits.

**Important:** platform credits are an internal unit. They are not Pixmo credits or money. Review Pixmo's live pricing and your account balance before setting customer prices. Higher output resolutions/upscaling have different costs and are not exposed in this starter.

## Brand, pricing and customer experience

The public homepage and logo are in `public/index.html` and `public/logo.svg`. The sample credit packages are configured in `server.js` in the `CREDIT_PACKAGES` array. The public pricing cards currently mirror the first three sample packages; update both locations together if you change the prices or credit amounts. Prices and credit quantities are placeholders, not a profitability or Pixmo-cost guarantee.

Customer features: account sign-up/sign-in, private generation history, credit balance, credit ledger, video status/results and M-Pesa top-up. Admin features: platform totals, recent users/jobs/payments and manual credit grants. The first admin account is provisioned from `ADMIN_EMAIL` and `ADMIN_PASSWORD`; do not use a public or guessable password.

## Configure M-Pesa payments

1. Register for Safaricom Daraja and create an app to obtain Consumer Key and Consumer Secret.
2. Configure an M-Pesa shortcode and STK Push passkey. Begin with the Daraja sandbox.
3. Add the credentials from `.env.example` to your hosting environment variables.
4. Set `MPESA_ENV=sandbox` while testing. Use `production` only after Safaricom approves your production app and shortcode.
5. Set `APP_URL` to the public HTTPS website address so Safaricom can reach `/api/payments/mpesa/callback`.
6. Test with Daraja sandbox test credentials and test phone numbers before going live.

Sample packages are defined in `CREDIT_PACKAGES` in `server.js`: KES 100/100 credits, KES 300/330 credits, KES 700/800 credits, and KES 1,500/1,800 credits. Change the example prices and credit quantities to fit your costs and margins. These are sample values, not a pricing recommendation.

The callback checks the order amount and receipt, then queries Daraja before crediting the account. Payments that cannot be verified are marked `REVIEW` and are not automatically credited. Monitor these and reconcile them before launching at scale.

## Connect a custom domain

1. Deploy the app to a host that supports Node.js 20+ and persistent storage (the included Render blueprint is one option).
2. Add your domain in the hosting provider's custom-domain settings.
3. At your domain registrar/DNS provider, add the exact CNAME or A/ALIAS record values shown by the host. DNS records differ by host, so use the values shown in your hosting dashboard rather than copying generic IP addresses.
4. Wait for DNS propagation and the host to issue/enable HTTPS.
5. Set `APP_URL` to the final HTTPS domain, for example `https://www.example.com`, then redeploy. Safaricom must be able to reach the M-Pesa callback at `https://www.example.com/api/payments/mpesa/callback`.
6. Test registration, login, a low-cost Pixmo generation and M-Pesa sandbox payment after the domain is active.

## Go-live checklist

- Set a long random `SESSION_SECRET` (32+ characters), a unique strong `ADMIN_PASSWORD`, and `NODE_ENV=production`.
- Keep `PIXMO_API_KEY` and all Daraja credentials in hosting environment secrets only; never commit `.env`.
- Use a persistent disk for SQLite and back it up. Do not use an ephemeral filesystem for the database.
- Configure the production Daraja app/shortcode/passkey only after sandbox testing and Safaricom approval.
- Confirm Pixmo permits your intended commercial use, resale/access model and display of generated videos.
- Update sample prices, credit grants, terms, privacy notice, refund policy and customer support details before taking money.

## Before accepting public paying customers

This is a deployable MVP, not a fully audited commercial payment service. Before charging customers, add:
- Card payments (this release implements M-Pesa STK Push; card payments require a separate integration).
- Email verification, password reset, support/contact and privacy/terms pages.
- A stronger production database (managed PostgreSQL is recommended as traffic grows).
- Object storage if you want to retain copies of video files; current video URLs are the URLs returned by Pixmo and may be subject to provider retention policies.
- Abuse reporting, content moderation policy, quotas, monitoring, backups and security review.
- Confirm the applicable rights, terms, pricing, and resale/redistribution permissions with Pixmo before offering this as a paid public service.

## API routes

- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `POST /api/videos`
- `GET /api/videos/:id`
- `GET /api/jobs`
- `GET /api/ledger`
- `GET /api/payments/config`
- `GET /api/payments`
- `POST /api/payments/mpesa/initiate`
- `POST /api/payments/mpesa/callback`
- `GET /api/payments/:id`
- `GET /api/admin/overview` (admin only)
- `POST /api/admin/credits` (admin only)
- `GET /api/health`

## Notes

- The API key is stored only in server environment variables.
- Admin access is granted only to the configured `ADMIN_EMAIL`; public registration cannot create admins.
- Generation is rate-limited per signed-in account and credits are reserved before calling Pixmo.
- A failed Pixmo job is refunded once. A Pixmo task that remains processing is not refunded.
- Keep the hosting disk persistent. Ephemeral filesystems can erase SQLite data during redeploys.
