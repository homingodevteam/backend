# Software Requirements Specification (SRS)
## Homingo — Home Services Marketplace Platform (Urban Company Clone)

**Version:** 1.0
**Document Type:** Backend-focused SRS
**Prepared for:** Homingo Engineering

---

## 1. Introduction

### 1.1 Purpose
Homingo is a multi-sided marketplace platform connecting **Customers** with verified **Professionals** (electricians, plumbers, painters, car washers, home cleaners, AC technicians, salon artists, geyser repair techs, etc.) for on-demand and scheduled home services. This document specifies the functional and non-functional requirements for the **backend system** that powers the Customer app, Professional app, and Admin panel.

### 1.2 Scope
The backend will support:
- Three primary actors: **Admin**, **Customer**, **Professional**
- Service catalog & category management
- Booking lifecycle (instant + scheduled)
- Professional onboarding & KYC verification
- Real-time availability, slot management, and assignment
- Payments, wallets, payouts, refunds
- Before/after job-proof image uploads
- Ratings, reviews, disputes
- Notifications (push/SMS/email)
- Admin moderation, analytics, and dispute resolution
- Edge-case handling across the booking/professional/payment lifecycle

### 1.3 Definitions
| Term | Meaning |
|---|---|
| Professional | Service provider (electrician, plumber, painter, cleaner, salon artist, car washer, etc.) |
| Booking | A confirmed service request tied to a Customer, Professional, Service, and Slot |
| KYC | Know Your Customer/Professional — identity + trade verification |
| SLA | Service Level Agreement (e.g., max time to accept, max time to arrive) |
| Payout | Transfer of earned funds from platform to Professional's bank/wallet |
| Job Proof | Before/after images + notes uploaded by Professional to prove work completion |

### 1.4 User Classes
1. **Admin** — platform owner/ops staff. Manages categories, professionals, KYC approval, pricing, disputes, refunds, payouts, analytics.
2. **Customer** — books services, pays, rates, raises complaints.
3. **Professional** — sub-typed by category (Electrician, Plumber, Painter, Car Washer, Home Cleaner, Salon Artist, AC Technician, Geyser Repair, etc.). Accepts/rejects jobs, uploads job proof, receives payouts.

---

## 2. Overall System Description

### 2.1 Product Perspective
Homingo is composed of:
- **Customer Mobile/Web App** (consumes backend APIs)
- **Professional Mobile App** (consumes backend APIs)
- **Admin Web Dashboard** (consumes backend + admin-only APIs)
- **Backend Core Services** (this SRS's focus): Auth, Catalog, Booking, Matching/Assignment, Payments, KYC, Notifications, Reviews, Disputes, Reporting

### 2.2 High-Level Architecture (Recommended)
Given typical modern stacks:
- **API Layer:** Node.js + Fastify + TypeScript (REST, optionally GraphQL for admin dashboard)
- **Primary DB:** PostgreSQL (relational — bookings, users, payments, KYC — needs strong consistency & transactions)
- **Cache/Queue:** Redis (session cache, slot-locking, rate limiting, job queues via BullMQ)
- **Document/Unstructured store:** MongoDB (optional — chat logs, activity/audit trail, job proof metadata) or keep everything in Postgres with JSONB if team wants a single source of truth
- **File Storage:** Supabase Storage / S3-compatible bucket (before/after images, KYC docs)
- **Auth:** JWT (access + refresh tokens), OTP-based login for Customers/Professionals, email+password/OAuth for Admin
- **Payments:** Razorpay/Stripe (India: Razorpay) with escrow-style hold-and-release, webhooks for status sync
- **Real-time:** WebSockets or Socket.IO / Supabase Realtime for live tracking, chat, and booking status push
- **Background Jobs:** Redis + BullMQ for: booking timeout auto-cancel, payout batching, reminder notifications, KYC re-verification reminders

### 2.3 Constraints
- Must support **city/pincode-based service availability** (not all services in all areas).
- Must handle **professional category-specific onboarding fields** (e.g., electrician needs trade license; salon artist may need portfolio images).
- Must be **PCI-DSS aware** — no raw card data touches Homingo servers; use payment gateway tokenization.
- Must comply with **local data protection norms** for storing KYC documents (Aadhaar/PAN equivalents) — encrypted at rest, access-logged.

---

## 3. Functional Requirements by Module

### 3.1 Authentication & User Management
- FR-1.1: Customers register/login via mobile OTP (primary) or email+password.
- FR-1.2: Professionals register via mobile OTP, then must complete a **multi-step onboarding wizard** before going live.
- FR-1.3: Admin logs in via email+password + optional 2FA; Admin accounts are provisioned by Super Admin only (no public signup).
- FR-1.4: Role-Based Access Control (RBAC): `super_admin`, `ops_admin`, `support_admin`, `customer`, `professional`.
- FR-1.5: JWT access token (short-lived, ~15 min) + refresh token (rotated, stored hashed in DB) for session management.
- FR-1.6: Account deactivation/soft-delete must preserve historical booking/payment records (never hard-delete transactional data).

### 3.2 Professional Onboarding & KYC
- FR-2.1: Professional selects one or more **service categories** (Electrician, Plumber, Painter, Car Washer, Home Cleaner, Salon, AC Service, Geyser Repair, etc.) — each category may require **different KYC document sets**.
- FR-2.2: Required KYC documents (configurable per category by Admin):
  - Government Photo ID (Aadhaar/PAN/Driving License)
  - Address Proof
  - Trade Certificate/License (mandatory for Electrician, Plumber, AC Technician — regulated trades)
  - Police Verification Certificate (recommended for all in-home service categories)
  - Bank account details / UPI ID (for payouts)
  - Profile photo (live selfie, matched against ID via manual or automated face-match)
  - Tools/equipment photo (optional, category-specific)
- FR-2.3: Documents uploaded to secure storage; DB stores only **metadata + signed URLs**, never raw files in relational tables.
- FR-2.4: KYC status state machine:
  `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED | REJECTED | RESUBMISSION_REQUIRED`
- FR-2.5: On `REJECTED` or `RESUBMISSION_REQUIRED`, Professional receives a reason code + free-text note from Admin and can re-upload specific documents (not the entire application).
- FR-2.6: Professional cannot appear in customer search or accept bookings until KYC status = `APPROVED` **and** at least one service category is `ACTIVE`.
- FR-2.7: Periodic re-verification: license/police-verification documents can carry an `expiry_date`; system auto-flags Professional as `KYC_EXPIRING` 30 days prior and `KYC_EXPIRED` (auto-suspended from new bookings) on expiry.
- FR-2.8: Admin can bulk-approve/reject and must leave an audit trail (`reviewed_by`, `reviewed_at`, `decision_reason`).

### 3.3 Service Catalog & Pricing
- FR-3.1: Hierarchical catalog: **Category → Sub-service → Pricing variant** (e.g., Cleaning → Bathroom Cleaning → Standard/Deep).
- FR-3.2: Each sub-service has: base price, duration estimate, city-wise price override, tax/GST config, cancellation policy, materials-included flag.
- FR-3.3: Admin can enable/disable a service per city/pincode independently.
- FR-3.4: Dynamic/surge pricing (optional v2): multiplier based on demand-supply in a zone at a time slot.
- FR-3.5: Combo/package services (e.g., "Full Home Deep Clean") map to multiple sub-services with a bundled price.

### 3.4 Search, Discovery & Slot Availability
- FR-4.1: Customer searches by pincode/geo-location → returns available categories/services in that zone.
- FR-4.2: System shows available time slots per service based on: professional availability calendar, existing bookings, buffer time between jobs, and travel-time heuristics.
- FR-4.3: Slot-locking: when a customer selects a slot, it's soft-locked (Redis TTL ~5–10 min) during checkout to prevent double-booking; released if payment isn't completed in time.

### 3.5 Booking Lifecycle
- FR-5.1: Booking state machine:
  `CREATED → PAYMENT_PENDING → CONFIRMED → PROFESSIONAL_ASSIGNED → EN_ROUTE → IN_PROGRESS → COMPLETED → CLOSED`
  with side-branches: `CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_PROFESSIONAL`, `CANCELLED_BY_ADMIN`, `NO_SHOW_CUSTOMER`, `NO_SHOW_PROFESSIONAL`, `DISPUTED`, `REFUNDED`.
- FR-5.2: Two assignment models supported:
  - **Auto-assign**: system assigns nearest/best-rated available Professional; Professional has an accept/reject window (e.g., 2 minutes) before reassignment.
  - **Customer-select**: customer browses available professionals for that slot and picks one directly.
- FR-5.3: Booking can be instant ("book now, arrive in X mins") or scheduled (specific date/time).
- FR-5.4: Reschedule flow: allowed until a configurable cutoff (e.g., 2 hrs before slot); triggers re-check of professional availability.
- FR-5.5: Cancellation policy engine: free cancellation window, partial-fee window, no-refund window — all configurable per service.

### 3.6 Job Execution & Proof of Work
- FR-6.1: Professional must mark `EN_ROUTE` → `ARRIVED` → `IN_PROGRESS` → `COMPLETED` sequentially; each transition timestamped and optionally geo-tagged.
- FR-6.2: **Before-images**: mandatory upload (min 1, configurable per category) before marking `IN_PROGRESS`.
- FR-6.3: **After-images**: mandatory upload before marking `COMPLETED`.
- FR-6.4: Images stored with metadata: `booking_id`, `uploaded_by`, `type (before/after)`, `timestamp`, `geo_coords (optional)`.
- FR-6.5: If Professional attempts to complete a booking without required after-images, backend rejects the state transition (hard validation, not just UI).
- FR-6.6: Customer can view before/after images in booking history indefinitely (or per data-retention policy).
- FR-6.7: Digital job completion OTP: Customer shares a 4-digit OTP with Professional on-site to confirm completion (prevents fraudulent "completed" marking without customer present).

### 3.7 Payments, Wallet & Payouts
- FR-7.1: Payment collected at booking confirmation (prepaid) or COD/pay-after-service (configurable per service/category — regulated trades may default to prepaid for fraud control).
- FR-7.2: Integration with payment gateway (Razorpay/Stripe) — supports UPI, cards, netbanking, wallets.
- FR-7.3: Platform holds funds in an internal ledger (escrow model): funds move to `pending_payout` for the Professional only after booking reaches `COMPLETED` and any dispute window (e.g., 24–48 hrs) has passed without a customer complaint.
- FR-7.4: Professional wallet: shows `available_balance`, `pending_balance`, `lifetime_earnings`, `deductions` (platform commission, penalties).
- FR-7.5: Payout cycle: scheduled batch payout (e.g., weekly) to Professional's registered bank/UPI, or on-demand payout request (subject to min. threshold).
- FR-7.6: Commission engine: platform commission % configurable per category, deducted automatically at payout calculation.
- FR-7.7: Refund engine: full/partial refund triggered by Admin or automated cancellation-policy rules; refund routed back to original payment method; refund status synced via gateway webhook.
- FR-7.8: All monetary transactions immutable/append-only ledger (no updates, only new offsetting entries) for auditability.

### 3.8 Ratings, Reviews & Disputes
- FR-8.1: Customer rates Professional (1–5 stars + optional text + optional photo) after `COMPLETED`; Professional can optionally rate Customer (behavior flags: late, unsafe premises, etc.).
- FR-8.2: Aggregate rating recalculated async (queue job) and cached on Professional profile.
- FR-8.3: Customer can raise a dispute/complaint against a completed job within a configurable window (e.g., 48 hrs) — categories: quality issue, damage, incomplete work, overcharge, professional conduct.
- FR-8.4: Dispute triggers: hold on the related payout, Admin case creation, evidence collection (photos/chat/booking timeline auto-attached).
- FR-8.5: Admin resolves dispute with outcomes: `refund_customer`, `partial_refund`, `no_action`, `penalize_professional`, `warn_professional`, `suspend_professional`.

### 3.9 Notifications
- FR-9.1: Push/SMS/email triggers for: booking confirmed, professional assigned, professional en route, job started/completed, payment success/failure, refund processed, KYC status change, payout processed, dispute update.
- FR-9.2: Professional-specific alerts: new job offer (with accept/reject countdown), booking cancelled by customer, document expiry reminder, payout credited.
- FR-9.3: Admin alerts: new KYC submission, dispute raised, SLA breach (e.g., no professional accepted within X minutes), suspicious payment activity.

### 3.10 Admin Panel Capabilities
- FR-10.1: User management (Customers & Professionals): view, suspend, ban, reinstate.
- FR-10.2: KYC review queue with document viewer, approve/reject/request-resubmission actions.
- FR-10.3: Catalog management: categories, services, pricing, city/pincode enablement.
- FR-10.4: Booking oversight: search/filter all bookings, manually reassign/cancel, force-refund.
- FR-10.5: Payout management: view pending payouts, approve/hold payouts, view ledger.
- FR-10.6: Dispute resolution console.
- FR-10.7: Analytics dashboard: bookings/day, GMV, category-wise demand, professional utilization, cancellation rate, average rating, city-wise heatmap.
- FR-10.8: Audit log for every Admin action (who did what, when, before/after state).

---

## 4. Edge Cases & System Behavior (Critical Section)

### 4.1 Admin removes/suspends/bans a Professional
| Scenario | Required Behavior |
|---|---|
| Professional has **future confirmed bookings** at time of removal | System must NOT silently cancel. Trigger a workflow: (a) attempt auto-reassignment to another available Professional for the same slot; (b) if no replacement found within X hours, auto-cancel with full refund + apology notification to Customer; (c) notify affected Customers proactively regardless of outcome. |
| Professional has an **in-progress** booking (`EN_ROUTE`/`IN_PROGRESS`) when banned | Do not interrupt the live job — let it complete normally; ban takes effect for **future** assignments only. Flag account for post-completion enforcement (e.g., withhold payout if ban reason is fraud/safety). |
| What Professional sees on their dashboard after removal | Account status banner: `Account Suspended/Deactivated` with reason (if disclosed by policy). All future job slots removed from calendar. Existing `available_balance` remains visible and payable per normal payout cycle **unless** ban reason is fraud (then funds held pending investigation, shown as `Under Review`). Cannot accept new jobs; read-only access to past booking/earnings history. |
| Soft-delete vs hard-delete | Professional record is **soft-deleted** (`status = REMOVED`, `deleted_at` set). Historical bookings, ratings, and ledger entries retain the reference (never cascade-delete) so Customer booking history and financial audit trail stay intact. |
| Re-application | If eligible, removed Professional can reapply — creates a **new onboarding record** linked to old profile (not a fresh identity) so repeat-offender patterns are visible to Admin. |

### 4.2 Booking & Assignment Edge Cases
- **No professional accepts within SLA window**: auto-escalate — widen search radius → notify Admin ops → offer Customer a rebooking/refund choice if still unresolved after a hard timeout.
- **Professional accepts but goes offline/unreachable before arrival**: system auto-triggers reassignment flow identical to cancellation-by-professional, with Customer notified in real time, not left waiting silently.
- **Customer cancels after Professional has already started traveling**: cancellation-fee policy applies (configurable), partial compensation credited to Professional's wallet for travel effort.
- **Double-booking race condition**: two customers select the same Professional/slot simultaneously — resolved via the Redis slot-lock (first payment-confirmed wins); the second is auto-notified "slot no longer available" and offered next best.
- **Professional marks job "Completed" but Customer disputes it never happened**: completion OTP requirement (FR-6.7) reduces this; if disputed anyway, Admin reviews geo-tags, before/after images, and OTP-verification log as evidence.
- **Customer not present at scheduled time (no-show)**: Professional can flag `NO_SHOW_CUSTOMER` after a grace period + geo-tagged proof of arrival; triggers partial-charge per policy and protects Professional's time.
- **Multi-day/recurring bookings** (e.g., weekly cleaning): if Professional is removed/unavailable mid-series, remaining occurrences go through the same reassignment logic per-occurrence, not a blanket cancellation of the whole series.

### 4.3 KYC Edge Cases
- **Document expires while Professional has active future bookings**: system blocks only *new* bookings from the expiry date forward; existing confirmed bookings before expiry proceed normally, with an automated reminder sent well in advance (30/15/3 days).
- **Professional resubmits after rejection with mismatched category**: Admin review queue flags category-specific document mismatch (e.g., electrician license uploaded for a plumber application) automatically via basic validation rules before human review.
- **Face-match/selfie fails automated check**: routes to manual review instead of auto-rejecting, to avoid false negatives.
- **Professional operates in multiple categories, one KYC revoked**: only the affected category goes `INACTIVE`; other approved categories remain bookable (e.g., electrician license revoked but AC-servicing KYC still valid → Professional still shows up for AC jobs, not electrical).

### 4.4 Payment & Payout Edge Cases
- **Payment succeeds at gateway but webhook delayed/fails**: booking stays `PAYMENT_PENDING` with a reconciliation job that polls gateway status; never trust client-side "success" callback alone — server-side webhook/verification is the source of truth.
- **Payment deducted but booking creation fails (server error)**: idempotency keys on the payment-intent + booking-creation calls to guarantee no "money taken, no booking" state; auto-refund job for orphaned payments.
- **Refund requested but original payment method no longer valid (e.g., expired card)**: fallback to refund-to-wallet (platform credit) with Customer notified and option to request bank transfer.
- **Professional's payout bank details invalid/rejected by bank**: payout marked `FAILED`, funds remain in `pending_payout` (not lost), Professional notified to update bank details, auto-retry on next cycle.
- **Dispute raised after payout already released**: system supports **clawback** — deduct from Professional's next payout or flag for manual recovery; ledger entry created as a reversal, not a silent balance edit.
- **Partial completion (job stopped midway — e.g., part unavailable)**: supports partial payment capture/partial refund tied to a `PARTIALLY_COMPLETED` status with itemized breakdown.

### 4.5 Image Upload Edge Cases
- **Professional uploads before-image but connectivity drops before after-image**: booking cannot transition to `COMPLETED` until after-image is present — system allows retry/resume upload; booking stays `IN_PROGRESS` (not stuck/cancelled) with a background retry queue.
- **Image upload contains no actual service context (blank/irrelevant photo)**: basic automated checks (file size/dimensions/EXIF sanity) + Admin spot-audit sampling; repeated low-quality submissions trigger a Professional-side warning.
- **Storage failure/quota exceeded**: upload requests fail gracefully with clear error, retried via background job — never silently drop images tied to a completed job (they're the audit/dispute record).
- **Customer requests deletion of their images (privacy)**: soft-delete with retention hold if tied to an open dispute or within legal retention window; otherwise honored per data-deletion policy.

### 4.6 Availability & Geo Edge Cases
- **Service pincode gets disabled by Admin mid-way through an active booking**: only blocks **new** bookings in that pincode; existing bookings unaffected.
- **Professional relocates to a new city**: requires re-verification of service-area assignment; historical bookings/ratings stay tied to profile, but active-zone matching updates only after Admin/automated confirmation.
- **Customer address falls on a service-area boundary (ambiguous pincode/geo-fence)**: fallback to distance-based radius check instead of strict pincode match, with manual override option in Admin if flagged.

### 4.7 Account & Identity Edge Cases
- **Customer tries to book while a past booking has an unresolved dispute/payment failure**: system can optionally soft-block new **prepaid-COD** bookings until resolved (configurable risk policy), but should never fully lock the account without Admin visibility.
- **Same person tries to register as both Customer and Professional** using the same phone number: allowed, but treated as two distinct role-profiles under one identity record (shared auth, separate role data) — prevents fraud from duplicate-identity workarounds while allowing legitimate dual use.
- **Professional account flagged for fraud mid-active-job**: as in 4.1, live job is allowed to finish safely (for customer safety/service continuity), enforcement applies going forward.

---

## 5. Core Data Model (Entity Overview)

- **users** (id, phone, email, role, status, created_at, deleted_at)
- **customer_profiles** (user_id, name, default_address_id, ...)
- **professional_profiles** (user_id, status, overall_rating, active_categories[], kyc_status, bank_details_ref, ...)
- **kyc_documents** (id, professional_id, doc_type, category_id, file_url, status, expiry_date, reviewed_by, reviewed_at, rejection_reason)
- **service_categories** (id, name, description, requires_documents[])
- **services** (id, category_id, name, base_price, duration_mins, cancellation_policy_id)
- **service_city_pricing** (service_id, city_id, price_override, is_enabled)
- **bookings** (id, customer_id, professional_id, service_id, slot_time, status, address_snapshot, price_breakdown, otp_code, created_at)
- **booking_status_history** (booking_id, from_status, to_status, changed_by, changed_at, geo_coords)
- **job_media** (id, booking_id, uploaded_by, type[before/after], file_url, uploaded_at, geo_coords)
- **payments** (id, booking_id, gateway_ref, amount, status, method, idempotency_key)
- **wallet_ledger** (id, professional_id, booking_id, entry_type[earning/commission/penalty/payout/refund_clawback], amount, balance_after, created_at)
- **payouts** (id, professional_id, amount, status, bank_ref, initiated_at, completed_at)
- **reviews** (id, booking_id, rated_by, rated_user_id, rating, comment, photo_url)
- **disputes** (id, booking_id, raised_by, category, status, resolution, resolved_by, resolved_at)
- **notifications** (id, user_id, type, payload, read_at, sent_at)
- **admin_audit_log** (id, admin_id, action, entity_type, entity_id, before_state, after_state, created_at)

---

## 6. Representative API Surface (REST)

```
POST   /auth/otp/request
POST   /auth/otp/verify
POST   /auth/refresh

# Customer
GET    /services?pincode=...
GET    /professionals/:id
POST   /bookings
PATCH  /bookings/:id/cancel
PATCH  /bookings/:id/reschedule
POST   /bookings/:id/review
POST   /bookings/:id/dispute

# Professional
GET    /professional/jobs?status=...
PATCH  /professional/jobs/:id/accept
PATCH  /professional/jobs/:id/reject
PATCH  /professional/jobs/:id/status        # en_route/arrived/in_progress/completed
POST   /professional/jobs/:id/media          # before/after image upload
GET    /professional/wallet
POST   /professional/payout-request
POST   /professional/kyc/documents

# Admin
GET    /admin/kyc/queue
PATCH  /admin/kyc/:id/approve
PATCH  /admin/kyc/:id/reject
GET    /admin/bookings
PATCH  /admin/bookings/:id/force-cancel
GET    /admin/disputes
PATCH  /admin/disputes/:id/resolve
GET    /admin/analytics/overview
PATCH  /admin/professionals/:id/suspend
```

---

## 7. Non-Functional Requirements

- **NFR-1 (Consistency):** Booking, payment, and ledger operations must be ACID-transactional (Postgres transactions); no eventual-consistency shortcuts for money movement.
- **NFR-2 (Availability):** Core booking/payment APIs target 99.9% uptime.
- **NFR-3 (Scalability):** Slot-locking and assignment matching designed to handle city-wide concurrent demand spikes (Redis-backed, horizontally scalable API layer).
- **NFR-4 (Security):** KYC documents encrypted at rest; access to KYC viewer restricted + logged; JWT with short expiry + refresh rotation; rate-limiting on OTP endpoints to prevent abuse.
- **NFR-5 (Auditability):** Every state-changing action (booking status, payment, KYC decision, admin override) is logged immutably.
- **NFR-6 (Observability):** Structured logging + metrics on booking funnel drop-off, SLA breaches, payout failures.
- **NFR-7 (Data Retention):** Financial records retained per statutory requirement (e.g., 7 years); job-proof images retained per dispute-window + configurable archival policy.

---

## 8. Open Questions for Product Decision (to refine before build)
1. Prepaid-only vs COD support per category — affects fraud/risk design.
2. Auto-assignment vs customer-choice as the **default** flow (or both, toggle per city).
3. Commission % structure — flat vs category-wise vs tiered by professional rating.
4. Police-verification — mandatory at onboarding or acceptable to onboard provisionally and enforce within N days?
5. Recurring/subscription bookings — in scope for v1 or v2?
6. Dispute window length and refund policy specifics (business decision, not just technical).

---

*This SRS is structured to be broken into epics: Auth & Onboarding → Catalog & Pricing → Booking Engine → Payments & Wallet → KYC Workflow → Admin Panel → Notifications → Disputes/Analytics.*
