# Profile images and customer help content

## Customer profile images

The authenticated customer endpoints are `POST /users/profile/image` (multipart field `image`), `GET /users/profile/image`, and `DELETE /users/profile/image`. The authenticated user identity comes from the access token; clients cannot select another owner. Uploads accept one JPEG, PNG, or WebP image up to 10 MiB and decode/re-encode it as WebP. The public user representation exposes only `profileImageAvailable`; it does not expose the storage reference or provider URL.

Cloudinary storage uses authenticated delivery in a per-user profile-images namespace. Where the application is configured for local private storage, files are stored outside public static paths with restrictive permissions. Retrieval is authenticated and private/no-store. Replacing and removing an image update the user's reference and clean up only the exact prior asset where cleanup succeeds. No database/provider integration was exercised by the automated tests; those tests use an isolated temporary local storage directory and mocked persistence.

## Customer help content

`GET /support-content` returns only active customer-facing title/body content in stable sort order. It does not create defaults or write to the database. Management routes are under `/support-content` and require the existing admin authentication plus `contacts.manage` capability; moderators are not authorized. Supported operations are create (`POST /support-content`), edit/publish (`PUT /support-content/:id`), and delete (`DELETE /support-content/:id`). Content is plain text, bounded, and rejects markup/control characters. No contact details are seeded or hardcoded.

The admin dashboard's **Help & Support** section manages these records. Only publish owner-approved text. The customer application refreshes this endpoint whenever Help & Support is opened, so published changes do not require an app release. Until the API and admin commits are deployed and approved content is entered, customers may see the clean empty state.
