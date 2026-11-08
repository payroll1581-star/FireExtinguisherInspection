---
title: Safe deploys, versions and rollback that keep printed QR codes working
type: grilling
mode: HITL
status: open
blocked-by: []
assignee:
---

## Question

Printed QR labels encode the web app URL, so a new deployment URL silently breaks every label. Decide: how changes are tested without touching the live deployment (separate test copy), how a new version is released to the same URL, how to roll back a bad release, how versions are named and recorded, and how the operator is warned before anything changes the URL.
