# YoMart API

Express/MongoDB REST API for the YoMart Flutter customer app, React storefront and React admin.

## Live production status — 12 November 2026

- API: https://yomart-api.onrender.com
- Runtime: `NODE_ENV=production`, `PLATFORM=Production`.
- Database: existing MongoDB Atlas Free cluster `yomart-staging`, database `yomart_staging` (historical names; now the active production data store).
- Live health: HTTP 200, `success:true`, production, database connected, Cloudinary image storage and authenticated private payment-proof storage, version `1.0.4`.
- Exact CORS preflight: HTTP 204 for `https://yomart.onrender.com` and `https://yomart-admin.onrender.com`.
- Latest backend CI and live production smoke: [run 43226507608](https://github.com/kalaabalb/yomart-api/actions/runs/43226507608).
- Test suite: 253 tests, 251 passed, 0 failed, 2 optional tests skipped (verified in run 43226507608).
- No paid Atlas resource was created; no existing database was deleted.

## Production safety boundary

Production checkout is explicitly disabled with `YOMART_SALES_ENABLED=false` until the owner approves real prices and available stock. The order route fails closed. Public `GET /products` and `GET /products/:id` responses omit `price`, `offerPrice` and `quantity` while sales are disabled; authenticated admin product responses retain those fields. Live CI verifies both public routes do not leak illustrative prices/stock.

The active database currently contains 8 active synthetic catalogue products, 2 inactive historical fixtures, 4 categories, 4 subcategories, 2 brands, 2 collections and 2 posters. It contains zero orders and zero payment-proof records. No synthetic customer/order/receipt records were created. The one enabled payment method is **Cash at shop or handover**; no online gateway or bank/wallet payment method is configured.

## Stack and architecture

- Node.js, Express, MongoDB/Mongoose
- JWT authentication for customers and admins
- Cloudinary media storage; payment-proof storage is private/authenticated
- `config/` runtime configuration, `middleware/` request/auth middleware, `model/` schemas, `routes/` API routes, `utils/` helpers, `test/` automated tests

## Local setup

Copy `.env.example` to `.env`, then configure local-only values:

```bash
npm install
npm start
npm test
```

Production/staging sales are opt-in. Set `YOMART_SALES_ENABLED=false` until real product prices/stock are approved. Do not commit secrets or live credentials.

## Security and business behavior

- Production startup fails closed when required JWT/database/storage configuration is missing.
- Customer/admin routes enforce owner and role checks.
- Public product API redacts unapproved retail price/stock while sales are disabled.
- Order creation uses server-side prices/stock, reserves inventory transactionally, and ignores customer-submitted totals/status.
- Payment-proof retrieval is private and authorized; receipt URLs are not exposed in order JSON.
- Account deletion removes direct identifiers and retains some order/payment evidence in pseudonymized form; final retention policy needs owner/legal approval.
- Email verification/password recovery is unavailable on the current free Render service.
- Do not run synthetic write tests or fake transactions against the active production database.

## Deployment

The production API runs on Render at https://yomart-api.onrender.com. The public customer and admin static sites are still staging/noindex builds, even though they use the production API. There is no separate staging database/API at this time.

See the [YoMart documentation repository](https://github.com/kalaabalb/yomart-docs) for the free-tier decision, live database audit, cutover runbook and release readiness checklist.
