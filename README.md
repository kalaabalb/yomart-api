# YoMart API

Express/MongoDB REST API for the YoMart Flutter customer app, React storefront and React admin.

## Live production status — 12 November 2026

- API: https://yomart-api.onrender.com
- Runtime: `NODE_ENV=production`, `PLATFORM=Production`.
- Database: existing MongoDB Atlas Free cluster `yomart-staging`, database `yomart_staging` (historical names; now the active production data store).
- Production deployment `dep-dbqscvjm8hqs73eo6p50` went live at 14:01:49 UTC on 12 November. Startup logs confirmed `Environment: production` and `Connected to MongoDB`.
- `YOMART_SALES_ENABLED=false` is explicitly set in Render. New order creation remains fail-closed until the owner approves actual prices and available stock.
- Latest live health, catalog, checkout-settings and CORS verification: [Backend CI run 43233076575](https://github.com/kalaabalb/yomart-api/actions/runs/43233076575) passed after the explicit sales-flag deployment. Health returned HTTP 200 with production, database connected, Cloudinary image storage and authenticated private payment-proof storage, version `1.0.4`.
- The same live smoke verified 8 public products with illustrative prices/stock omitted, cash-at-shop-or-handover as the only checkout method, no proof requirement, zero delivery fee, and exact HTTP 204 CORS preflights for the storefront and admin.
- Test suite: 253 tests, 251 passed, 0 failed, 2 optional tests skipped (run 43233076575).
- No paid Atlas resource was created; no existing database was deleted.

## Production safety boundary

Public `GET /products` and `GET /products/:id` responses omit `price`, `offerPrice`, `quantity`, `catalogSource` and `createdBy` while sales are disabled; authenticated admin product responses retain those fields. Live CI verifies both public routes do not leak illustrative prices/stock.

The active database currently contains 8 active synthetic catalogue products, 2 inactive historical fixtures, 4 categories, 4 subcategories, 2 brands, 2 collections and 2 posters. It contains zero orders and zero payment-proof records. No synthetic customer/order/receipt records were created. The one enabled payment method is **Cash at shop or handover**; live public checkout settings verify proof is not required and delivery fee is zero. No online gateway or bank/wallet payment method is configured.

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

Production/staging sales are opt-in. Keep `YOMART_SALES_ENABLED=false` until real product prices/stock are approved. Do not commit secrets or live credentials.

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
