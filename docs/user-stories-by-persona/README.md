# User Stories — by Persona

The same stories as `../user-stories/`, cut a different way.

| View | Organised by | Answers |
|---|---|---|
| [`../user-stories/`](../user-stories/README.md) | **Module** — 15 files | "What must this module do?" |
| **This folder** — 3 files | **Person** | "What can this user do, and what happens to them?" |

| File | Persona |
|---|---|
| [customer.md](customer.md) | The person booking a service |
| [pro.md](pro.md) | The salaried service professional |
| [admin.md](admin.md) | Ops, support, finance and super-admin |

**Story IDs are identical across both views.** `US-4.12` is the same story in `04-booking-and-job-lifecycle.md` and in `pro.md`. Use them in tickets and tests.

A story with more than one actor appears in the file of whoever **initiates** it, and is cross-referenced from the others. `US-4.20` (customer cancels while the Pro is en route) lives in `customer.md`, and `pro.md` links to it under "things that happen to you".

---

## Why a persona view

The module view is for building. This one is for three other jobs:

- **Scoping an app.** Everything the Customer App must do is in one file. Same for the Pro App.
- **Spotting gaps in a journey.** Module files hide the fact that a Pro's day crosses six modules. Read end to end and the seams show.
- **Seeing what a user does *not* control.** Each file has a section for things the system does *to* that person — the assignments a Pro can't refuse, the duty flag only an admin can set, the rotation a customer can't request around.

---

## Ground rules

Unchanged from the module view, restated because they shape every story here.

- Phone + OTP is the only login, for all three personas. Third-party verified.
- **The system assigns work.** A Pro can only *acknowledge*, never accept or decline. A missed ack reassigns to the next-best candidate.
- **Pros are salaried employees.** Salary is recorded but never paid by this system. Commission is the only Pro money computed here.
- **Admins set availability.** `Pro.isAvailable` is toggled by ops, not by the Pro. All three dispatchability gates are admin-controlled.
- **Ranking uses customer rating alone**, applied as a smoothed score so a Pro with few reviews sits at the platform average. **`acceptanceRate` is analytics only** — it never affects ranking or pay.
- A **verified door OTP** is the only thing that starts a job timer — and therefore the only basis for commission.
- One flat price per service, nationally. One commission rate per service. City-level geography only.
- **38 tables.** Payment attempts live at Razorpay; the assignment lives on `Booking`; push tokens are columns on the user rows; availability is a boolean; there are no quality audits.

---

## Story format

| Part | What it answers |
|---|---|
| **Story** | As a … I want … so that … |
| **State** | What changes in the database or Redis |
| **Ripple** | What the *other* users now see or can no longer do |
| **Edge** | The case that breaks a naive implementation |

Actor tags: `C` Customer · `P` Pro · `A` Admin · `S` System
