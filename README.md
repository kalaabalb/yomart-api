# YoMobiles Backend

Node.js and Express REST API for the YoMobiles e-commerce platform.

This repository is the server-side source of truth for the YoMobiles system. It powers the client storefront and the admin dashboard with:

- user and admin authentication
- catalog, brand, category, sub-category, poster, and variant data
- admin-managed storefront collections with curated product ordering
- database-backed store settings for payment availability and support contacts
- product ratings and reviews
- shopping orders and payment verification
- notifications

## Who Uses It

- Flutter customers through the YoMobiles Client app
- administrators through the YoMobiles Admin dashboard

## Stack

- Node.js
- Express
- MongoDB with Mongoose
- JSON Web Tokens for user and admin sessions
- Cloudinary for media uploads
- `node:test` and `supertest` for backend security tests

## Architecture

- `index.js` boots the Express app, middleware, routes, and database connection
- `config/` holds runtime configuration helpers
- `middleware/` contains authentication and request middleware
- `model/` contains Mongoose models
- `routes/` exposes the REST API surface
- `utils/` contains startup helpers such as admin provisioning
- `test/` contains the security-focused automated tests

## Authentication and Security Model

- Users and admins authenticate with signed JWT access tokens.
- Protected routes expect `Authorization: Bearer <token>`.
- The server validates user and admin roles on protected endpoints.
- Production startup fails closed when required JWT configuration is missing.
- Default admin provisioning is explicit and environment-driven; it does not silently create predictable credentials.

## Environment Configuration

Copy [`./.env.example`](./.env.example) to `.env` and provide real values for your environment.

Required values include:

- `MONGO_URL`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ADMIN_JWT_EXPIRES_IN` (defaults to 8 hours; use a shorter value if your admin workflow supports it)
- `ADMIN_USERNAME`
- `ADMIN_NAME`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Optional integrations:

- Cloudinary
- OneSignal
- `CORS_ALLOWED_ORIGINS` for production browser clients (comma-separated exact origins; browser requests are denied when no origin is configured)

Production `JWT_SECRET` must contain at least 32 bytes of cryptographically random data. Production startup exits when `MONGO_URL` is missing. Production readiness also requires Cloudinary or `UPLOADS_DIR` pointing to a mounted persistent volume; image uploads fail closed and `/health` returns 503 when neither is configured. The default local `/uploads` folder is for development only.

Store payment methods start unconfigured. A super admin must add and enable at least one method in store settings before checkout can accept orders. Uploaded catalog and payment images are limited to 10 MB per file and normalized to WebP with a 2400-pixel maximum edge and automatic quality at Cloudinary ingestion.

Order creation uses product prices and available stock from MongoDB, reserves stock in a transaction, applies the configured delivery fee, and sets the initial order/payment status on the server. Customer-submitted totals and statuses are ignored.

Email delivery is disabled on the free Render service. Registration accepts the supplied email without verifying ownership, so users must enter an address they control. Password changes are available to signed-in users from their profile; email-based password recovery is unavailable.

Do not commit secrets or live credentials.

## Local Setup

```bash
npm install
npm start
```

The default start command runs `index.js` and listens on `PORT` or `3000`.

## API Surface

The backend exposes endpoints for:

- `/users`
- `DELETE /users/account` disables the authenticated customer's account after current-password confirmation, removes direct contact/delivery identifiers and ratings, revokes customer access to receipts, and retains anonymized order/payment evidence for business records. See the launch receipt-lifecycle documentation before changing retention behavior.
- `POST /users/account-deletion` is the external web deletion path. It verifies account email/password, is rate-limited in production, and performs the same deletion for users without the app installed.
- `/admin-users`
- `/orders`
- `/ratings`
- `/payment`
- `/products`
- `/categories`
- `/subCategories`
- `/brands`
- `/variantTypes`
- `/variants`
- `/posters`
- `/collections`
- `/store-settings`
- `GET /retailer-contacts` returns only active, sanitized customer-facing entries; `GET /retailer-contacts/admin`, `POST /retailer-contacts`, `PUT /retailer-contacts/:id`, and `DELETE /retailer-contacts/:id` require an active admin or super-admin session. Contacts are stored separately from legacy scalar settings.
- `/notification`
- `/health`

## Testing

```bash
npm test
```

The current test suite focuses on authentication, authorization, token issuance, and admin provisioning behavior.
GitHub Actions now runs the same test suite on pushes and pull requests.

## Local Catalog Import

The checked-in October 16, 2026 catalog snapshot under `scripts/data/` contains
retailer-linked product listings and image URLs. Import it only into the local
`yomart_local` database:

```sh
npm run catalog:import                 # dry run
CATALOG_SEED_CONFIRM=yomart_local npm run catalog:import -- --apply
```

The importer downloads product photos and brand marks, converts them to
compressed WebP files under `uploads/catalog/`, and upserts catalog records.
Imported ETB prices are identified as market references and carry source
URLs/check dates for review in the admin product editor. YoMart stock is set to
zero because actual store inventory was not supplied. The importer does not
create customer accounts, orders, payment instructions, or store contact
details. Re-running it updates records by their source URLs and named groups.

## Deployment / Current Status

- API-only service; there is no UI to screenshot.
- The repository includes a `/health` endpoint for runtime checks.
- Public API deployment: [https://ecommerce-backend-api-jet.vercel.app](https://ecommerce-backend-api-jet.vercel.app)
- Production deployment should use the environment values documented above and a managed MongoDB instance.

## Related YoMobiles Repositories

- [YoMobiles Client](https://github.com/kalaabalb/yomoblies)
- [YoMobiles Admin](https://github.com/kalaabalb/yomobliesctl)

## Contributing

- [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Keep authentication, API contracts, and database behavior stable unless a change is explicitly requested.

## Security

- [`SECURITY.md`](SECURITY.md)

Do not commit JWT secrets, database passwords, API keys, or private signing material.

## License

MIT License. See [`LICENSE`](LICENSE).

## Author

YoMobiles project maintainer
