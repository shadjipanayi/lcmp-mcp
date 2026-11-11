# Logicom Cloud Marketplace

Read-only lookups across Logicom's country cloud marketplaces for internal and support staff.

## Language

### Marketplaces and accounts

**Marketplace**:
One country's instance of the Logicom Cloud Marketplace (e.g. CYMA, GR), with its own accounts, reseller network and local time zone.
_Avoid_: country, instance, tenant

**Root**:
The distributor account at the top of a marketplace, under which all resellers sit. The platform labels it a reseller, but it is not one.
_Avoid_: distributor root, top account

**Reseller**:
An account directly under the root that sells to customers and receives the invoices.
_Avoid_: partner, company

**Customer**:
An account under a reseller that holds subscriptions.
_Avoid_: end customer, client, company

### Subscriptions

**CSP model**:
Whether a Microsoft CSP licence is **NCE** (new commerce) or **Legacy**. Products that aren't CSP licences (tenants, Azure Plans, reserved instances, non-Microsoft products) have no CSP model.
_Avoid_: licence type, commerce type

**Legacy monthly**:
A Legacy subscription without advance payment. It renews every month whatever its stored end-date action says.
_Avoid_: month-to-month, monthly legacy

**Stored end-date action**:
The end-date action recorded on the subscription in the marketplace (Renew or Terminate).

**Effective end-date action**:
What actually happens at the subscription's end date: the stored end-date action, except for Legacy monthly subscriptions, which always renew.
_Avoid_: end-date action (unqualified, when the two can differ)

**Days left**:
Whole days from today's date in the marketplace's own time zone to the subscription's end date. Negative once the end date has passed.
_Avoid_: days until expiry, days remaining

**Urgency**:
How soon a subscription's end date is, by days left: **past end date** (below 0), **urgent** (0 to 31), **soon** (32 to 60) or **later** (over 60).
_Avoid_: priority, severity, red/orange
