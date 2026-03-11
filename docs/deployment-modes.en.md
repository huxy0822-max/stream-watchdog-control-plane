# Deployment Modes

This project can already support more than one commercial model.

## 1. Managed service

You run one control plane and your customers use customer dashboards under separate workspaces.

Best fit today:

- fast rollout
- central support
- CDK-based activation
- one place to monitor many customer environments

## 2. Dedicated deployment

You deploy one isolated control plane per customer on their own infrastructure or on a server assigned to them.

Best fit when:

- the customer requires infrastructure isolation
- the customer wants its own domain
- the customer wants its own operational boundary

## 3. Future hosted SaaS

The current code already includes some SaaS foundations:

- workspaces
- users
- sessions
- quotas
- CDKs
- role separation

Still missing before full SaaS:

- direct billing
- subscription lifecycle automation
- stronger tenant-level audit controls
- production-grade HTTPS automation everywhere
- self-service domain and deployment flows

## Recommendation

Use the codebase today as:

- managed service first
- dedicated deployment second
- hosted SaaS later
