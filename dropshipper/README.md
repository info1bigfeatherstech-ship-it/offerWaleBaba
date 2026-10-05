# Dropshipper module

Isolated backend for dropshipping. Does **not** change ecomm/wholesale cart, checkout, or catalog filters.

- Phase 1: admin product dropship visibility & pricing  
- Phase 2: serviceability (warehouse → customer)  
- Phase 3: dropshipper catalog  
- Phase 4: create order + Razorpay (online only) + admin dropship order list  
- Phase A–E: auth foundation → register pay → OTP activate → login JWT → renew  

**Storefront / channel:** Dropship commerce uses `storefront: "dropship"` on orders only.  
Auth/settings use separate collections with `channel: "dropship"` — they do **not** use ecomm/wholesale storefront headers or CheckoutSettings.

---

## Phase 1 — Admin product APIs

**Base:** `/api/admin/dropshipper`  
**Auth:** Bearer JWT + `admin` | `product_manager` (list also: `inventory_manager`)

| Method | Path | Body / Query |
|--------|------|----------------|
| GET | `/products?page&limit&listedOnly&q` | — |
| GET | `/products/:slug` | — |
| PATCH | `/products/:slug/variants/:productCode/price` | `{ dropshipBase, enable? }` |
| PATCH | `/products/:slug/variants/:productCode/enable` | `{ dropshipBase? }` |
| PATCH | `/products/:slug/variants/:productCode/disable` | `{ clearPrice? }` |
| POST | `/products/bulk-enable` | `{ items: [{ productCode, slug?, dropshipBase? }] }` |
| POST | `/products/bulk-set-price` | `{ items: [{ productCode, dropshipBase, slug?, enable? }] }` |

---

## Phase 2 — Serviceability

**Base:** `/api/dropshipper`  
**Auth (temporary until dropshipper login):** Bearer JWT + `admin` | `product_manager` | `inventory_manager`  
(Non-prod only: `DROPSHIPPER_AUTH_BYPASS=true`)

### `POST /api/dropshipper/serviceability/check`

See earlier docs — use `paymentMode: "prepaid"` before placing (COD not used for dropship checkout).

---

## Phase 3 — Catalog

| Method | Path | Notes |
|--------|------|--------|
| GET | `/catalog/products?page&limit&q&categoryId&inStockOnly&sort` | Only dropship-listed variants |
| GET | `/catalog/products/:slug` | Detail; dropship variants only |
| GET | `/catalog/variants/:productCode` | Single variant detail |
| GET | `/catalog/variants/:productCode/download-pack` | JSON pack for FE download |

**Payable field:** `dropshipPrice` only (from `price.dropshipBase`).

---

## Phase 4 — Create order + Razorpay (online only)

**Base:** `/api/dropshipper`  
**Auth:** same temporary staff JWT as catalog  

Orders are saved with `storefront: "dropship"` and public ids `OWB-DS-######`.  
They **never** appear in the default ecomm/wholesale admin order lists.  
Fulfillment reuse: send admin header `x-storefront: dropship` on existing admin order APIs (ecomm staff with ecomm scope are auto-granted dropship scope at runtime).

### `POST /api/dropshipper/orders/quote`

Preview pricing + optional shipping (when pincodes provided).

```json
{
  "items": [{ "productCode": "SKU1", "quantity": 1 }],
  "customerPincode": "110001",
  "warehousePincode": "560001",
  "package": { "weightKg": 0.5, "lengthCm": 10, "widthCm": 10, "heightCm": 5 }
}
```

### `POST /api/dropshipper/orders`

Creates order, reserves stock, starts Razorpay. **COD rejected.**

```json
{
  "items": [{ "productCode": "SKU1", "quantity": 1 }],
  "warehousePincode": "560001",
  "dropshipRef": "IG-POST-42",
  "package": { "weightKg": 0.5, "lengthCm": 10, "widthCm": 10, "heightCm": 5 },
  "customer": {
    "fullName": "Rahul Kumar",
    "phone": "9876543210",
    "houseNumber": "12A",
    "area": "Connaught Place",
    "addressLine1": "Near Metro",
    "city": "New Delhi",
    "state": "Delhi",
    "postalCode": "110001"
  }
}
```

**Success (201)** includes `order` + `razorpay: { keyId, orderId, amount, currency }` for Checkout.js.  
If Razorpay env is missing / API fails: order is still created (`razorpayError: true`) — retry payment later.

### `POST /api/dropshipper/orders/verify-payment`

Same body as ecomm verify:

```json
{
  "orderId": "OWB-DS-123456",
  "razorpay_order_id": "order_…",
  "razorpay_payment_id": "pay_…",
  "razorpay_signature": "…"
}
```

Delegates to core payment verify (signature + amount + inventory commit). Existing Razorpay webhook also works for `OWB-DS-*` orders.

### List / detail (dropshipper)

| Method | Path |
|--------|------|
| GET | `/orders?page&limit&ref` |
| GET | `/orders/:orderId` |

### Admin dropship orders (filter hook)

**Base:** `/api/admin/dropshipper`  
**Auth:** `admin` | `order_manager` | `product_manager` | `inventory_manager`

| Method | Path | Query |
|--------|------|--------|
| GET | `/orders` | `page`, `limit`, `ref` / `dropshipRef`, `q`, `paymentStatus`, `orderStatus` |
| GET | `/orders/:orderId` | — |

---

## Safety guarantees

- Payable price = `dropshipBase` only (never ecomm/wholesale sale).  
- Payment method = online only.  
- Ecomm admin order match still excludes `storefront: dropship`.  
- Unpaid hold expiry does **not** merge dropship lines into ecomm/wholesale carts.  
- Inventory reserve uses shared warehouse (`ecomm` inventory channel).  

## Out of scope (later phases)

- Dropshipper-dashboard login/register/activate/renew UI — **FE developer owns this** (APIs ready)
- Wholesale storefront CTA — not in scope (ecomm only)

Ecomm `/api/delivery/*` and ecomm/wholesale catalogs / checkout are unchanged.

---

## Phase A — Auth foundation (isolated collections)

**Collections (NOT `User`):**
- `Dropshipper` — account  
- `DropshipperRegistrationRequest` — paid register/renew requests  
- `DropshipperSettings` — singleton subscription fee config  

**Duration:** hardcoded **1 year** (`subscriptionYears`).  
**Amount:** admin-configurable `subscriptionAmountInr` (new + renew use *current* fee; paid requests keep snapshot).

### Public

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/dropshipper/auth/subscription-settings` | none |

### Admin (`/api/admin/dropshipper`)

| Method | Path | Roles |
|--------|------|--------|
| GET | `/settings` | admin, order_manager, product_manager |
| PATCH | `/settings` | admin — body `{ subscriptionAmountInr?, registrationOpen? }` |
| GET | `/accounts?page&limit&status&q` | admin, order_manager, product_manager |
| GET | `/accounts/:id` | same |
| GET | `/requests?page&limit&adminStatus&kind&q` | same |
| GET | `/requests/:id` | same |
| POST | `/requests/:id/approve` | admin — optional `{ note }` |
| POST | `/requests/:id/reject` | admin — required `{ note }` |

Approve (paid + pending) creates/links `Dropshipper` with status `pending_otp`.  
OTP + password + `subscription.startsAt/endsAt` come in the next phase.

---

## Phase B — Register + subscription Razorpay pay

**Base:** `/api/dropshipper` (public — no JWT)  
**Channel:** `dropship` only (not ecomm/wholesale storefront).

| Method | Path | Body |
|--------|------|------|
| POST | `/auth/register/start` | `{ fullName, email, phone, businessName? }` → fee preview |
| POST | `/auth/register/create-payment` | same → `{ requestId, razorpay:{ keyId, orderId, amount, currency } }` |
| POST | `/auth/register/verify-payment` | `{ requestId, razorpay_order_id, razorpay_payment_id, razorpay_signature }` |
| GET | `/auth/register/status/:requestId?email=&phone=` | ownership check via email or phone |

**Flow for dropshipper-dashboard FE:**
1. `GET /auth/subscription-settings` — show ₹ fee + 1 year  
2. Form → `POST /auth/register/start` (optional validate)  
3. `POST /auth/register/create-payment` → open Razorpay Checkout with returned `razorpay`  
4. On success → `POST /auth/register/verify-payment`  
5. Show “pending admin approval”  
6. Admin sees request at `GET /api/admin/dropshipper/requests?adminStatus=pending`

**Rules:** fee snapshot frozen on request; live settings amount used only at create-payment; COD not allowed; ecomm User collection unused.

### Where to test / look (after deploy/restart)

**Backend**
1. Restart `offerWaleBaba` server on `dropshipper-feature`  
2. Confirm env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`  
3. Public: `GET /api/dropshipper/auth/subscription-settings`  
4. Admin (Bearer staff JWT):  
   - `PATCH /api/admin/dropshipper/settings` `{ "subscriptionAmountInr": 800 }`  
   - After a paid register: `GET /api/admin/dropshipper/requests?adminStatus=pending`  
5. Code lives only under `backend/offerWaleBaba/dropshipper/`  

**Offer frontend (API handoffs only — no dashboard UI)**
1. Branch `dropshipper-feature`  
2. Admin helpers: `src/SERVICES/adminDropshipperApi.js` → settings / accounts / requests  
3. Public register helpers: `src/SERVICES/dropshipperAuthApi.js`  
4. Admin UI tabs not built yet — when built, use those services under a new **Dropshippers** admin section  

**Dropshipper-dashboard**
- **Out of scope here** — FE developer wires register + Razorpay using Phase B public APIs above.

---

## Phase C — OTP + password → activate 1-year subscription

After admin **approves** a paid request, dropshipper status = `pending_otp`.  
Approve also **best-effort** emails an OTP (if `EMAIL_USER` / `EMAIL_PASSWORD` set).

| Method | Path | Body |
|--------|------|------|
| POST | `/api/dropshipper/auth/activate/send-otp` | `{ email }` or `{ phone }` or `{ dropshipperId }` |
| POST | `/api/dropshipper/auth/activate/complete` | `{ email\|phone\|dropshipperId, otp, password, confirmPassword? }` |

**On complete (success):**
- OTP verified (hashed, 10 min TTL, max 5 attempts, 60s resend cooldown)
- Password hashed with bcrypt
- `status: active`
- `subscription.startsAt = now`, `endsAt = now + 1 year` (hardcoded)
- `nextStep: login` (JWT login = next phase)

**Non-prod debug:** set `DROPSHIPPER_OTP_DEBUG=true` to include `debugOtp` in send-otp response (never in production).

### Where to test Phase C

**Backend**
1. Restart server on `dropshipper-feature`  
2. Env: `EMAIL_USER`, `EMAIL_PASSWORD` (OTP mail). Optional: `DROPSHIPPER_OTP_DEBUG=true` locally  
3. Admin approve: `POST /api/admin/dropshipper/requests/:id/approve`  
4. `POST /api/dropshipper/auth/activate/send-otp` `{ "email": "..." }`  
5. `POST /api/dropshipper/auth/activate/complete` with OTP + password  
6. Confirm account: `GET /api/admin/dropshipper/accounts?status=active`  
7. Code: `dropshipper/services/dropshipperActivate.service.js`

**Offer frontend handoffs**
- `src/SERVICES/dropshipperAuthApi.js` → `sendDropshipperActivationOtp`, `completeDropshipperActivation`  
- Admin approve already in `adminDropshipperApi.js` → `approveDropshipperRequest`

**Dropshipper-dashboard**
- FE developer wires OTP + set-password screens using Phase C APIs — **not built in this repo change**

---

## Phase D — Dropshipper login JWT (staff gate replaced)

Panel APIs under `/api/dropshipper/catalog|orders|serviceability` now require a **dropshipper** access token (`portal: dropshipper`).  
Admin staff JWT **no longer** unlocks those panel routes.

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| POST | `/auth/login` | public | `{ email\|phone, password }` → access + refresh |
| POST | `/auth/refresh` | public | `{ refreshToken }` |
| GET | `/auth/me` | dropshipper JWT | works even if subscription expired |
| POST | `/auth/logout` | dropshipper JWT | blacklists access token |
| * | `/catalog/*`, `/orders/*`, `/serviceability/*` | dropshipper JWT + **active subscription** | `403 SUBSCRIPTION_EXPIRED` if year ended |

Token claims: `{ id, type, role:'dropshipper', portal:'dropshipper', channel:'dropship' }`  
Default access TTL: `DROPSHIPPER_ACCESS_TOKEN_EXPIRES` or `7d`.

Orders store `dropshipMeta.dropshipperId` (additive on Order — ecomm untouched).

Non-prod only: `DROPSHIPPER_AUTH_BYPASS=true` still skips auth (orders may fail without actor id).

### Where to test Phase D

**Backend**
1. Restart server on `dropshipper-feature`  
2. Activate a dropshipper (Phase C complete)  
3. `POST /api/dropshipper/auth/login` `{ "email":"...", "password":"..." }`  
4. Use `Authorization: Bearer <accessToken>` on `GET /api/dropshipper/catalog/products`  
5. Expired subscription → login OK, catalog returns `SUBSCRIPTION_EXPIRED`  
6. Staff admin JWT on catalog → should **fail** (gate replaced)  
7. Code: `dropshipper/middlewares/dropshipperAccess.middleware.js`, `services/dropshipperLogin.service.js`

**Offer frontend handoffs**
- `src/SERVICES/dropshipperAuthApi.js` → `loginDropshipper`, `refreshDropshipperSession`, `getDropshipperMe`, `logoutDropshipper`

**Dropshipper-dashboard**
- FE developer stores accessToken and sends Bearer on panel APIs — **UI not built here**

---

## Phase E — Renew subscription (no admin re-approval)

Login works when expired; catalog/orders return `403 SUBSCRIPTION_EXPIRED`.  
Renew pays the **current** admin fee, then extends `subscription.endsAt` by **1 year** from `max(now, currentEndsAt)`. No admin approve step.

| Method | Path | Auth | Notes |
|--------|------|------|--------|
| GET | `/auth/renew/quote` | dropshipper JWT | fee + newEndsAt preview |
| POST | `/auth/renew/create-payment` | dropshipper JWT | → Razorpay order (`kind: renewal`) |
| POST | `/auth/renew/verify-payment` | dropshipper JWT | body same shape as register verify |

**Allowed statuses:** `active` (early renew) or `expired`. Rejected / suspended / pending_* cannot renew.

**On verify success:**
- `status → active`
- `endsAt = max(now, previousEndsAt) + 1 year`
- `subscription.renewedAt = now`
- request `adminStatus → approved` with `decisionNote: auto_approved_renewal` (audit only)
- `nextStep: panel`

Renew fee is independent of `registrationOpen` (closed registration still allows renew).

### Where to test Phase E

**Backend**
1. Restart `offerWaleBaba` on `dropshipper-feature`  
2. Env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`  
3. Login as expired (or force `subscription.endsAt` in past + `status: expired` via admin/DB)  
4. `GET /api/dropshipper/auth/me` → `capabilities.renewRequired: true`  
5. `GET /api/dropshipper/auth/renew/quote` with Bearer  
6. `POST /api/dropshipper/auth/renew/create-payment` → open Razorpay Checkout  
7. `POST /api/dropshipper/auth/renew/verify-payment` with signature fields  
8. Catalog should work again; admin: `GET /api/admin/dropshipper/requests?kind=renewal`  
9. Code: `dropshipper/services/dropshipperRenew.service.js`

**Offer frontend handoffs**
- `src/SERVICES/dropshipperAuthApi.js` → `getDropshipperRenewQuote`, `createDropshipperRenewPayment`, `verifyDropshipperRenewPayment`

**Dropshipper-dashboard**
- FE developer wires renew UX when panel returns `SUBSCRIPTION_EXPIRED` — **UI not built here**

---

## Offer admin UI — Dropshippers tab

**Location (offer frontend):** Admin sidebar → **Dropshippers**  
**URL:** `/babapanel?tab=dropshippers&ctab=accounts|requests|settings|orders`  
**Roles:** `admin` (full), `product_manager` / `order_manager` (read; approve/settings write = admin only)

Sub-tabs use `adminDropshipperApi.js` only — no ecomm User / wholesale panels.

## Ecomm storefront CTA

- Footer → **Become a Dropshipper** → `/become-dropshipper` (ecomm offer app only; not wholesale)
- Portal URL: `VITE_DROPSHIPPER_PORTAL_URL` (defaults to `http://localhost:5173`)

