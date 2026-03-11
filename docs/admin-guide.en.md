# Super Admin Guide

This guide is for the platform owner operating the control plane.

## 1. Your current operating model

The current codebase is best suited for:

- one super-admin backend operated by you
- CDK issuance for customer activation
- customer use through their own workspace dashboards

It is already structured to support future hosted SaaS, but that is not the primary commercial mode yet.

## 2. What the super admin controls

The super-admin dashboard can manage:

- all customer workspaces
- all groups
- all servers
- all streams
- CDKs
- platform runtime settings
- email notification settings
- control-plane host and application resource usage
- separate login portals and customer activation flow
- CRM-style sidebar pages for each operational module
- collapsible CRM-style navigation groups in the left sidebar

Customer users cannot see those platform-wide controls.

Customer operators now also have a stronger dedicated **Group Operations Matrix** page for issue-first daily handling. That reduces the need to operate from the generic stream list.

## 3. Recommended onboarding flow

### Option A: You create the customer workspace manually

Best for high-touch or custom customers.

1. Create the workspace.
2. Create the customer admin user.
3. Help them add groups, servers, and streams.

### Option B: You issue a CDK

Best for repeatable service packages.

1. Generate a CDK.
2. Send it to the customer.
3. The customer activates the workspace themselves.
4. The customer logs in through the customer portal.

The public root `/` now shows only customer login and CDK activation.
The super-admin entry is intentionally direct-route only: `/admin/login`.

## 4. Create a workspace

Fill:

- workspace name
- slug
- status
- expiration
- user limit
- server limit
- stream limit
- notes

Treat the slug as a stable internal identifier.

## 5. Generate CDKs

Useful fields:

- code
- quantity
- plan label
- duration
- max users
- max servers
- max streams
- notes

Recommended naming pattern:

- `VIP-30D-10S-100L`
- `VIP-90D-20S-300L`

For standardized service sales, use batch generation and create several CDKs for the same package in one operation.

The CDK page now also shows:

- total / unused / redeemed / expired counts
- the latest generated batch in a copy-ready panel
- limits per code directly in the list

## 6. Train customers to use groups

The UI is intentionally hierarchical:

- group
- server
- stream

Encourage customers to group by:

- region
- project
- business unit
- primary vs backup

Also train them to use the simplified stream onboarding flow:

- choose a server
- enter media filename or full path
- enter YouTube stream key
- click **Save and Start**

This avoids customers writing raw `ffmpeg` commands unless they truly need a custom advanced flow.

If the customer already has active streams on a server, train them to use the built-in SSH discovery/import button from the server page. That flow can scan live `ffmpeg` processes and create the matching stream records automatically.

## 7. Runtime settings

Main controls:

- poll interval
- SSH timeout
- default verification delay
- session lifetime
- event retention

Start conservative, then tune after real traffic:

- poll interval: `20`
- SSH timeout: `10-15`
- verify delay: `5-10`

## 8. Email notifications

Prepare:

- SMTP host
- SMTP port
- TLS setting
- SMTP username
- SMTP password
- from address
- recipient addresses

If email is not ready, monitoring and automatic recovery still work.

## 9. Daily operations

Recommended routine:

1. Review issue-first panels
2. Review host/app resource cards
3. Review the matrix
4. Sample-check the group explorer
5. Use the event log as supporting detail only

## 10. Dedicated customer deployments

When you deploy a dedicated instance for a customer, confirm:

- 24/7 runtime availability
- outbound SSH access to customer stream servers
- Docker availability
- no port conflict with existing websites
- reverse-proxy readiness

At minimum validate:

- dashboard boots
- customer login works
- server save works
- stream save works
- manual run-once works
- manual recovery works

## 11. GitHub automation included in this repo

This repository now ships with:

- Node.js CI
- GitHub Packages publish workflow
- Datadog Synthetics workflow

Configure these when you are ready:

- `DD_API_KEY` secret
- `DD_APP_KEY` secret
- `DD_SYNTHETICS_PUBLIC_IDS` variable
- optional `DATADOG_SITE` variable

The Datadog workflow is designed to skip cleanly until those values exist.
