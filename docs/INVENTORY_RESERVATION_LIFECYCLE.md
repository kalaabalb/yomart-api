# Inventory reservation lifecycle

## New orders

Checkout already decrements available product quantities and creates the order within one MongoDB transaction. This candidate adds an `inventoryReservation` snapshot to each new order in that same transaction. The snapshot records exact product IDs, quantities, state, and timestamps. Checkout idempotency remains the guard against decrementing stock twice when a request is retried.

| Event | Reservation state | Stock action |
| --- | --- | --- |
| Order created | `reserved` | Stock was decremented during checkout |
| Admin cancellation | `released` | Recorded quantities are restored once |
| Payment rejection | `released` | Recorded quantities are restored once |
| Collection or delivery | `consumed` | No stock change |

Before release or consumption, the backend aggregates persisted order lines and reservation entries by canonical product ID and requires exact product/quantity equality. Duplicate lines for a product are aggregated on both sides. Invalid IDs, quantities, empty lists, or mismatched totals fail closed before stock or reservation state changes. Release/consume and the corresponding order status update run in the same MongoDB transaction. A repeated release/consumption with a valid terminal marker does not adjust stock again. Concurrent status writes contend on the same order/product documents; the transaction and transition validation determine one consistent outcome. A missing or malformed marker fails the transaction closed.

## Historical orders

Orders without an `inventoryReservation` marker remain historical/unknown. Cancellation, rejection, collection, or delivery cannot infer a reservation from order items and fails closed without changing stock or order status. No migration or bulk inventory adjustment is included; historical records remain intact and require an explicit owner-approved reconciliation if a protected transition is needed. The schema change is additive and optional. Production still requires a MongoDB deployment with transaction support.

## Validation boundary

The lifecycle route tests in this candidate use mocked persistence/transactions. They validate route behavior and rollback logic but do not establish MongoDB transaction behavior. Verify the exact candidate commit in a controlled staging deployment before production promotion.
