---
title: Guaranteeing a damaged-tank alert reaches a person
type: grilling
mode: HITL
status: open
blocked-by: []
assignee:
---

## Question

The immediate damaged-tank email is sent once and failures are only logged; if the mail quota is exhausted or sending fails, the alert is lost until the next daily digest. Decide: is a retry queue needed, what the fallback is when email cannot be sent (sheet highlight, second channel, digest priority), how the daily mail quota is protected, and the longest acceptable delay between a damaged result and a human knowing.
