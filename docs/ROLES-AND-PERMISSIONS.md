# RegOps roles and permissions

Reference for integrating RegOps with a host platform that supplies each user's organisation, roles and permissions.
It lists every RegOps role, what each role may do, the business rules that apply on top of roles, and a proposed
permission catalogue the host can map to. The endpoint table in section 4 is generated from the API's role checks, so it
matches what the system enforces.

## 1. Concepts

| Term | Meaning |
|---|---|
| Tenant | One regulated institution (MFB, fintech, PSP or MMO). Every customer, transaction, alert and case belongs to exactly one tenant. Data is isolated per tenant by the database itself. |
| Role | A named bundle of access. A user has exactly one role in one tenant. |
| Permission | A single action, such as approving a case. RegOps checks **roles** today; section 5 proposes permission names so the host can express access in its own terms. |

## 2. Roles

| Role | Purpose | Typical holder | MFA |
|---|---|---|---|
| **Super Admin** | Platform operator. Creates tenants and can act as any tenant to support it. Belongs to the platform, not to a customer institution. | RegOps or host platform staff | Expected |
| **Tenant Admin** | Runs one institution's RegOps: users, rules, customers, screening settings. | Head of compliance, IT administrator | Expected |
| **Compliance Officer** | Does the compliance work: reviews alerts and screening matches, runs the case workflow, files and approves SARs. The only role that can approve. | MLRO, compliance analyst | Expected |
| **Investigator** | Investigates cases: opens them, adds notes and evidence. Cannot decide or approve. | Fraud or AML investigator | Optional |
| **Viewer** | Read-only access to operational screens. | Auditor, management | Optional |

"Expected" means the role is on the list of roles for which MFA is meant to be mandatory. The sign-in flow supports
authenticator-app (TOTP) codes but does not yet block a user who has not enrolled.

### Who can grant which role

| Actor | Roles they can assign |
|---|---|
| Super Admin | Any role, including Super Admin |
| Tenant Admin | Tenant Admin, Compliance Officer, Investigator, Viewer |
| Everyone else | None |

Further rules: nobody can change their own role or status; only a Super Admin can modify a Super Admin; a suspended user
cannot sign in and their sessions end at the next token refresh.

## 3. Capability matrix

"Yes" means the role may do it. "Own tenant" is implied everywhere; the Super Admin additionally works inside any tenant
it chooses to act as.

| Capability | Super Admin | Tenant Admin | Compliance Officer | Investigator | Viewer |
|---|---|---|---|---|---|
| Sign in, change own password, set up MFA | Yes | Yes | Yes | Yes | Yes |
| View customers, transactions, alerts, cases, reports | Yes | Yes | Yes | Yes | Yes |
| Export customers and alerts (CSV) | Yes | Yes | Yes | Yes | Yes |
| Reveal unmasked BVN/NIN | Yes | Yes | Yes | — | — |
| Create or edit customers, photos, accounts, bulk upload | — | Yes | Yes | — | — |
| Approve a PEP customer | — | Yes | Yes | — | — |
| Delete a customer | — | Yes | — | — | — |
| Re-score a customer | Yes | Yes | Yes | — | — |
| Assign, bulk-assign or close alerts | Yes | Yes | Yes | — | — |
| Open a case, add notes, evidence or linked alerts | — | — | Yes | Yes | — |
| Assign a case | — | Yes | Yes | — | — |
| Submit, approve, reject or close a case | — | — | Yes | — | — |
| View screening checks and matches, review a match | Yes | Yes | Yes | — | — |
| Run a screening or sanctions check | Yes (screening) | Yes | Yes | — | — |
| Change screening provider settings | — | Yes | — | — | — |
| View detection rules and dry-run them | Yes | Yes | Yes | — | — |
| Edit detection rules | Yes | Yes | — | — | — |
| View transaction ingestion batches and velocity statistics | Yes | Yes | Yes | — | — |
| Trigger the SFTP inbox poll | — | Yes | — | — | — |
| Edit, submit, confirm or reject SAR and CTR reports | — | — | Yes | — | — |
| Download regulator XML | Yes | Yes | Yes | — | — |
| Download report PDF or CSV | Yes | Yes | Yes | Yes | Yes |
| View the audit log | Yes | Yes | Yes | — | — |
| List, invite, edit and suspend users | Yes | Yes | — | — | — |
| See colleagues' names (no email or sign-in details) | Yes | Yes | Yes | Yes | Yes |
| Rename the current tenant | Yes | Yes | — | — | — |
| List, create or switch between tenants | Yes | — | — | — | — |

## 4. Endpoint reference

Access values: **Public** needs no sign-in; **Signature (HMAC)** is machine-to-machine, authenticated by a per-tenant
shared secret; **Any signed-in role** needs a valid sign-in but no particular role; otherwise the roles listed.

### Authentication and own account

| Method and path | What it does | Access |
|---|---|---|
| `POST /auth/login` | Sign in with email and password | Public |
| `POST /auth/verify-mfa` | Complete sign-in with a 6-digit authenticator code | Public |
| `POST /auth/forgot-password` | Request a password-reset email | Public |
| `POST /auth/reset-password` | Set a new password using a reset or invite token | Public |
| `POST /auth/change-password` | Change own password | Any signed-in role |
| `POST /auth/refresh` | Exchange the refresh token for a new access token | Public |
| `POST /auth/logout` | End the session | Public |
| `GET /auth/me` | Current user and tenant | Any signed-in role |
| `POST /auth/mfa/setup` | Start authenticator-app enrolment | Any signed-in role |
| `POST /auth/mfa/enable` | Confirm enrolment with a code | Any signed-in role |
| `POST /auth/mfa/disable` | Turn MFA off | Any signed-in role |

### Customers

| Method and path | What it does | Access |
|---|---|---|
| `GET /customers` | List and search customers | Any signed-in role |
| `GET /customers/export` | Export customers as CSV | Any signed-in role |
| `GET /customers/:id` | Customer detail (BVN/NIN masked) | Any signed-in role |
| `GET /customers/:id/pii` | Reveal unmasked BVN/NIN (reason required, audited) | Super Admin, Tenant Admin, Compliance Officer |
| `POST /customers` | Create a customer | Tenant Admin, Compliance Officer |
| `PATCH /customers/:id` | Edit a customer | Tenant Admin, Compliance Officer |
| `DELETE /customers/:id` | Delete a customer (reason required) | Tenant Admin |
| `POST /customers/:id/approve-pep` | Approve a PEP customer's enhanced due diligence | Tenant Admin, Compliance Officer |
| `POST /customers/:id/photo` | Upload customer photo | Tenant Admin, Compliance Officer |
| `GET /customers/:id/photo` | Download customer photo | Any signed-in role |
| `DELETE /customers/:id/photo` | Remove customer photo | Tenant Admin, Compliance Officer |
| `POST /customers/batch` | Upload a CSV of customers | Tenant Admin, Compliance Officer |
| `GET /customers/batch/:jobId` | Bulk upload progress | Any signed-in role |
| `GET /customers/batch/:jobId/error-report` | Download the bulk upload error report | Any signed-in role |

### Risk scoring

| Method and path | What it does | Access |
|---|---|---|
| `POST /customers/:id/rescore` | Recalculate the customer's risk score | Super Admin, Tenant Admin, Compliance Officer |
| `GET /customers/:id/risk-history` | Risk score history | Any signed-in role |

### Transactions and accounts

| Method and path | What it does | Access |
|---|---|---|
| `GET /transactions/batches` | List transaction ingestion batches | Super Admin, Tenant Admin, Compliance Officer |
| `GET /transactions/batches/:id` | Batch detail | Super Admin, Tenant Admin, Compliance Officer |
| `GET /transactions/batches/:id/errors` | Rows rejected from a batch | Super Admin, Tenant Admin, Compliance Officer |
| `POST /customer-accounts` | Link an account number to a customer | Tenant Admin, Compliance Officer |
| `GET /customer-accounts` | List customer accounts | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `POST /transactions/sftp-inbox` | Trigger a poll of the SFTP inbox | Tenant Admin |
| `POST /transactions/ingest` | Push transactions (signed webhook) | Signature (HMAC) |
| `GET /transactions` | List and filter transactions | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /transactions/stats` | Transaction KPIs | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /transactions/:id` | Transaction detail | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /customers/:id/transactions` | A customer's transactions | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /customers/:id/velocity-stats` | A customer's velocity statistics | Super Admin, Tenant Admin, Compliance Officer |

### Alerts

| Method and path | What it does | Access |
|---|---|---|
| `GET /alerts` | List and filter alerts | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /alerts/export` | Export alerts as CSV | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `PATCH /alerts/bulk-assign` | Assign several alerts at once | Super Admin, Tenant Admin, Compliance Officer |
| `GET /alerts/:id` | Alert detail with evidence | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /alerts/:id/related-transactions` | Transactions behind an alert | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `POST /alerts/:id/assign` | Assign an alert | Super Admin, Tenant Admin, Compliance Officer |
| `POST /alerts/:id/close` | Close an alert with a reason | Super Admin, Tenant Admin, Compliance Officer |

### Cases

| Method and path | What it does | Access |
|---|---|---|
| `POST /cases` | Open a case (from an alert or a customer) | Compliance Officer, Investigator |
| `GET /cases` | List cases | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /cases/:id` | Case detail with timeline | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /cases/:id/checklist` | Escalation checklist state | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `POST /cases/:id/alerts` | Link another alert to the case | Compliance Officer, Investigator |
| `POST /cases/:id/notes` | Add an investigation note | Compliance Officer, Investigator |
| `POST /cases/:id/evidence` | Attach evidence | Compliance Officer, Investigator |
| `GET /cases/:id/evidence/:evidenceId` | Download evidence | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `PATCH /cases/:id/close` | Close a case with no further action (reason required) | Compliance Officer |
| `PATCH /cases/:id/submit` | Submit for approval with an escalation rationale | Compliance Officer |
| `PATCH /cases/:id/approve` | Approve a submitted case; files the SAR draft | Compliance Officer |
| `PATCH /cases/:id/reject` | Reject a submitted case (reason required) | Compliance Officer |
| `PATCH /cases/:id/assign` | Assign or reassign the case | Compliance Officer, Tenant Admin |

### Screening

| Method and path | What it does | Access |
|---|---|---|
| `GET /screening/matches` | List screening matches | Super Admin, Tenant Admin, Compliance Officer |
| `GET /screening/matches/:id` | Match detail | Super Admin, Tenant Admin, Compliance Officer |
| `POST /screening/matches/:id/review` | Record a true or false positive decision | Super Admin, Tenant Admin, Compliance Officer |
| `POST /screening/customers/:id/sanctions` | Run an on-demand sanctions check | Tenant Admin, Compliance Officer |
| `POST /screening/customers/:id/screen` | Queue a full screening of a customer | Super Admin, Tenant Admin, Compliance Officer |
| `GET /screening/checks` | List screening checks | Super Admin, Tenant Admin, Compliance Officer |
| `GET /screening/checks/:id` | Check detail | Super Admin, Tenant Admin, Compliance Officer |
| `GET /screening/providers` | View screening provider settings | Tenant Admin |
| `PUT /screening/providers` | Change screening provider settings | Tenant Admin |

### Detection rules

| Method and path | What it does | Access |
|---|---|---|
| `GET /rules` | List the tenant's detection rules | Super Admin, Tenant Admin, Compliance Officer |
| `GET /rules/replays/:replayId` | Rule replay status | Super Admin, Tenant Admin, Compliance Officer |
| `GET /rules/:id` | Rule detail | Super Admin, Tenant Admin, Compliance Officer |
| `PATCH /rules/:id` | Change a rule's thresholds, severity or active state | Super Admin, Tenant Admin |
| `POST /rules/:id/test` | Dry-run a rule on sample data | Super Admin, Tenant Admin, Compliance Officer |

### Reports (SAR and CTR)

| Method and path | What it does | Access |
|---|---|---|
| `GET /reports` | List SAR and CTR reports | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /reports/:id` | Report detail | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `PATCH /reports/:id` | Edit a draft report | Compliance Officer |
| `PATCH /reports/:id/submit` | Submit a report | Compliance Officer |
| `PATCH /reports/:id/confirm` | Confirm a submitted report | Compliance Officer |
| `PATCH /reports/:id/reject` | Reject a submitted report | Compliance Officer |
| `GET /reports/:id/xml` | Download regulator XML (contains personal data) | Super Admin, Tenant Admin, Compliance Officer |
| `GET /reports/:id/pdf` | Download PDF | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |
| `GET /reports/:id/csv` | Download CSV | Super Admin, Tenant Admin, Compliance Officer, Investigator, Viewer |

### Audit log

| Method and path | What it does | Access |
|---|---|---|
| `GET /audit-logs` | List and filter the tenant's audit log | Super Admin, Tenant Admin, Compliance Officer |

### Users

| Method and path | What it does | Access |
|---|---|---|
| `GET /users/directory` | Names only (id, name, role, status) so screens can show who did what | Any signed-in role |
| `GET /users` | List the tenant's users with email and sign-in details | Super Admin, Tenant Admin |
| `GET /users/:id` | User detail | Super Admin, Tenant Admin |
| `POST /users` | Invite or create a user | Super Admin, Tenant Admin |
| `POST /users/:id/resend-invite` | Resend an invitation | Super Admin, Tenant Admin |
| `PATCH /users/:id` | Change a user's role or status | Super Admin, Tenant Admin |

### Tenants

| Method and path | What it does | Access |
|---|---|---|
| `GET /tenants` | List all tenants | Super Admin |
| `GET /tenants/current` | The current tenant | Any signed-in role |
| `PATCH /tenants/current` | Rename the current tenant | Super Admin, Tenant Admin |
| `POST /tenants/switch` | Act as another tenant | Super Admin |
| `GET /tenants/:id` | Tenant detail | Super Admin |
| `POST /tenants` | Create a tenant | Super Admin |

### Platform

| Method and path | What it does | Access |
|---|---|---|
| `GET /health` | Service readiness (database and Redis) | Public |

## 5. Proposed permission catalogue

If the host expresses access as permissions, these names map one-to-one onto the endpoints above. RegOps would translate
the permissions it receives into a role (section 6). The third column shows which roles hold the permission today.

| Permission | Allows | Roles that hold it |
|---|---|---|
| `customers.read` | View, search and export customers; photos; risk history | All |
| `customers.pii.reveal` | Reveal unmasked BVN/NIN | Super Admin, Tenant Admin, Compliance Officer |
| `customers.write` | Create, edit, photo, link accounts | Tenant Admin, Compliance Officer |
| `customers.bulk_upload` | Upload customers by CSV | Tenant Admin, Compliance Officer |
| `customers.pep.approve` | Approve a PEP's enhanced due diligence | Tenant Admin, Compliance Officer |
| `customers.delete` | Delete a customer | Tenant Admin |
| `customers.rescore` | Recalculate risk score | Super Admin, Tenant Admin, Compliance Officer |
| `transactions.read` | View transactions, statistics, customer accounts | All |
| `transactions.ops.read` | Ingestion batches, batch errors, velocity statistics | Super Admin, Tenant Admin, Compliance Officer |
| `transactions.sftp.trigger` | Trigger SFTP inbox poll | Tenant Admin |
| `alerts.read` | View and export alerts | All |
| `alerts.manage` | Assign, bulk-assign, close alerts | Super Admin, Tenant Admin, Compliance Officer |
| `cases.read` | View cases, checklist, evidence | All |
| `cases.work` | Open a case; add notes, evidence, linked alerts | Compliance Officer, Investigator |
| `cases.assign` | Assign a case | Tenant Admin, Compliance Officer |
| `cases.decide` | Submit, approve, reject, close a case | Compliance Officer |
| `screening.read` | View checks and matches | Super Admin, Tenant Admin, Compliance Officer |
| `screening.run` | Run screening or a sanctions check | Super Admin, Tenant Admin, Compliance Officer |
| `screening.review` | Decide a match | Super Admin, Tenant Admin, Compliance Officer |
| `screening.providers.manage` | View and change screening providers | Tenant Admin |
| `rules.read` | View and dry-run rules | Super Admin, Tenant Admin, Compliance Officer |
| `rules.edit` | Change rules | Super Admin, Tenant Admin |
| `reports.read` | View reports, PDF, CSV | All |
| `reports.xml` | Download regulator XML | Super Admin, Tenant Admin, Compliance Officer |
| `reports.decide` | Edit, submit, confirm, reject reports | Compliance Officer |
| `audit.read` | View the audit log | Super Admin, Tenant Admin, Compliance Officer |
| `users.manage` | Invite, edit, suspend users | Super Admin, Tenant Admin |
| `tenant.rename` | Rename the current tenant | Super Admin, Tenant Admin |
| `platform.tenants` | List, create, switch tenants | Super Admin |

## 6. Mapping the host's roles and permissions to RegOps

RegOps keeps the five roles above. For each user the host supplies, RegOps needs to end up with **one role**. Two ways to
get there:

1. **Role mapping (simplest).** The host sends role names and we agree a table, for example host `org_admin` to
   Tenant Admin, `aml_analyst` to Compliance Officer, `read_only` to Viewer. Unknown host roles get no access.
2. **Permission mapping.** The host sends permission names (ideally those in section 5). RegOps grants the **highest role
   whose permissions are all present**. This is coarser than enforcing each permission separately, which would need RegOps
   to check permissions endpoint by endpoint instead of roles.

Information we need from the host for either approach: the exact role and permission strings, whether a user can belong to
more than one organisation, and how a change or removal of a role reaches RegOps.

## 7. Rules that apply on top of roles

Having a role is necessary but not always sufficient.

| Rule | Detail |
|---|---|
| Case maker and checker | Opening a case makes the opener its assignee. **The assignee cannot submit** the case for approval. **The submitter cannot approve or reject** it. A rejection needs a written reason and returns the case to investigation. In practice a SAR needs at least two Compliance Officers. |
| Report maker and checker | The Compliance Officer who submitted a report cannot confirm or reject it. |
| Escalation checklist | A case cannot be submitted until its checklist is complete. |
| Reasons | Closing an alert, rejecting a case and deleting a customer each require a written reason. Closing a case takes an optional reason; a standard "no suspicious activity" text is used if none is given. |
| PII reveal | Unmasked BVN/NIN is shown only on explicit request with a reason, is hidden again after a short time, and every reveal is audited. |
| Role changes | Nobody changes their own role or status. Only a Super Admin changes a Super Admin. |
| Tenant isolation | Every query is limited to the user's tenant by the database. Only a Super Admin can act as another tenant; starting to act as a tenant is logged in that tenant's audit log, and so are the actions taken there. |
| Super Admin and cases | A Super Admin can read cases but cannot open, submit, approve, reject or close them. |
| Password change | A user created with a temporary password can do nothing except change it until they do. |
| Audit | Sign-ins (success and failure), password and MFA changes, user invitations and changes, tenant creation, renaming and switching into, and customer, alert, case and report actions are written to an append-only audit log. |

## 8. Points to confirm

1. **Colleague names.** Every signed-in role can read a names-only list of the tenant's users (`GET /users/directory`: id, name, role, status) so screens can show who assigned or decided something. Email and sign-in details are limited to Super Admin and Tenant Admin. Confirm that is acceptable.
2. **Customer list for Viewer.** Viewers can list and open customers (BVN/NIN stay masked). Confirm that is intended.
3. **MFA.** If the host already performs multi-factor authentication, RegOps can accept that instead of its own prompt.
4. **Investigator scope.** Investigators cannot assign cases or close alerts. Confirm whether the host expects them to.
