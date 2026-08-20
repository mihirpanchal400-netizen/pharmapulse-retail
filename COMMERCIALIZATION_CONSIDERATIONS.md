# Regulatory and Commercialization Considerations

**Read this before deploying PharmaPulse Retail in a working pharmacy.**

PharmaPulse Retail is a working piece of retail-pharmacy software, built so that
it *could* be developed towards a product. It is not certified, approved or
audited for regulated pharmacy operation anywhere, and this document exists so
that no one mistakes "it works" for "it is compliant".

---

## 1. What this software is, plainly

It is an inventory, billing, procurement and analytics application that runs on
one Windows machine against a local SQLite database. It has authentication,
role-based access, an audit trail, batch and expiry tracking, FEFO allocation,
GST-aware pricing fields and an audited import path.

**It carries no certification of any kind.** Nothing in this repository has been
assessed by a regulator, an auditor, a chartered accountant or a legal adviser.

---

## 2. What would need attention before real-world use in India

The following is a map of the territory, not legal advice. Requirements vary by
state and change over time; a qualified professional should be engaged.

### Pharmacy licensing and drug sale rules

Retail sale of drugs in India is governed by the **Drugs and Cosmetics Act, 1940**
and its Rules, administered largely at state level. Matters that typically apply:

- A valid retail drug licence, and a registered pharmacist on the premises
- Prescription handling and record-keeping for **Schedule H, H1 and X** drugs
- A **Schedule H1 register** with prescriber and patient details, retained as prescribed
- Purchase and sale records retained for the statutory period
- Rules on narcotic and psychotropic substances (**NDPS Act**), which this software does not attempt to model

The software records a `schedule_category` and a `prescription_flag` per product
and can warn on them, but **it does not implement a Schedule H1 register, and it
deliberately stores no prescription or patient clinical data at all** (see §4).

### GST and invoicing

- GST registration and correct HSN classification for pharmaceutical goods
- Tax-invoice content requirements: supplier GSTIN, buyer details where applicable, HSN, taxable value, CGST/SGST/IGST split
- Invoice series and sequence rules
- Periodic returns (GSTR-1, GSTR-3B) and reconciliation
- **E-invoicing** obligations above the prescribed turnover threshold

PharmaPulse holds GSTIN and HSN fields, applies a per-product GST rate and
produces a GST summary report. **It does not file returns, does not connect to
the GST Network, and produces no IRN or e-invoice.** The tax figures it
calculates should be reconciled by whoever files the returns.

### Accounting

- Books of account under the Companies Act or Income Tax Act as applicable
- Statutory audit thresholds
- Whether this software is the book of record, or feeds an accounting package that is

Treat PharmaPulse as an **operational** system, not an accounting system of
record, unless that has been reviewed with an accountant.

### Data protection

- The **Digital Personal Data Protection Act, 2023** applies to personal data of customers
- Purpose limitation, notice and consent, retention limits, breach reporting
- Reasonable security safeguards

PharmaPulse stores customer name, phone, address and GSTIN for billing and
credit. That is personal data. **The application implements no consent capture,
no retention policy and no data-subject request handling.**

### Electronic records

Where records must be kept electronically, expect requirements around integrity,
retention, tamper evidence, retrievability and, in some contexts, electronic
signatures under the **Information Technology Act, 2000**.

PharmaPulse has an append-only inventory ledger and an activity log. **These have
not been assessed against any electronic-records standard**, and the database
file is directly editable by anyone with access to the machine.

### Weights, measures and pricing

- MRP is a ceiling; sale above MRP is not permitted. The software enforces this on import, and the POS should be checked to behave the same way.
- Certain formulations are price-controlled under the **DPCO** by the NPPA. PharmaPulse holds no ceiling-price data and performs no DPCO checks.

---

## 3. Technical gaps between "runs" and "production"

Honest list, from the current code:

| Area | Current state | Needed for production |
|---|---|---|
| Demo credentials | `admin/admin123` etc., documented in the README | Removed; forced password set on first run |
| JWT secret | Falls back to a development default | Mandatory secret; refuse to start without one |
| Transport | Plain HTTP on localhost | TLS if it ever leaves the machine |
| Database | Local SQLite file, unencrypted | Encryption at rest, or a hardened host |
| Backups | `npm run backup` writes a local copy, run manually | Scheduled, verified, off-machine, tested restores |
| Multi-user | Single machine | Concurrency, locking and a server deployment reviewed |
| Multi-branch | Single pharmacy per database | Tenancy model |
| Deletion | Records deactivate rather than delete | Retention and disposal policy |
| Monitoring | Console logs | Error tracking, alerting |
| Updates | Manual `git pull` | Versioned releases, migration testing on real data |
| Penetration testing | None | Independent security review |

---

## 4. What this software deliberately does not do

These are design decisions, not omissions:

- **No patient clinical data.** No diagnosis, medical history, prescription images or EMR records anywhere in the schema.
- **No live distributor connection.** The distributor network is **demonstration data generated locally** and is labelled as such in the interface. It is not scraped from, and does not connect to, any commercial platform.
- **No payment processing.** A payment method is recorded; no money moves.
- **No AI service.** The Mini Analyst is a deterministic rule engine over the pharmacy's own tables. Nothing is sent anywhere.
- **No proprietary code or data.** Original implementation throughout; no commercial pharmacy product was copied, decompiled or reverse-engineered. Dependencies are permissively licensed and recorded in `THIRD_PARTY_LICENSES.md`.

---

## 5. Import Center — specific cautions

The Import Center writes directly to the product master, stock and trading
history. Points to be clear about:

- **Imported values are stored as given.** GSTIN and drug licence numbers are *not* verified against any registry. A field being filled in is not evidence that the registration exists.
- **Opening Stock overwrites quantities.** It is intended to be run once, at go-live. Running it against a live shelf replaces counted stock with whatever the file says.
- **Sales History does not deduct stock** (see `IMPORT_SYSTEM.md` §7). Importing it does not adjust the shelf.
- **Back up before a large import.** `npm run backup` takes a timestamped copy. The import is transactional, so it cannot land half-done — but a *successful* import of a *wrong file* is still wrong.
- **The uploaded file is deleted after import.** The job record and the error report remain; the spreadsheet does not.
- **Personal data in an uploaded file becomes the pharmacy's responsibility** under the DPDP Act, whatever the file's origin.

---

## 6. If this were to be commercialized

The architecture was built to make that possible: modular services, a clean
normalised schema, an API separated from the client, configurable pharmacy
settings, role-based access, an audit trail, import and export, backup,
validation, tests and documentation.

What would come before selling it to a pharmacy:

1. Legal review of drug-sale, GST and data-protection obligations for the target states
2. A compliance gap analysis against actual pharmacy record-keeping requirements
3. Independent security assessment and penetration testing
4. Chartered-accountant review of the tax and invoice output
5. A support, update and data-migration plan
6. Professional indemnity cover
7. Clear terms of service and a privacy policy
8. Pilot deployment with a real pharmacy, supervised

**Until that work is done, PharmaPulse Retail should be treated as a
demonstration and development project, not as a system of record for a licensed
pharmacy.**

---

## 7. No warranty

Released under the MIT Licence, which includes no warranty. The authors accept
no liability for regulatory penalties, tax errors, stock losses, expired stock
reaching a customer, or any other consequence of using this software. Anyone
deploying it in a real pharmacy does so on their own professional judgement and
under their own licence.
