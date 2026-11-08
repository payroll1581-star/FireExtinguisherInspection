---
title: Run the system on real Google and real phones
type: task
mode: HITL
status: open
blocked-by: []
assignee:
---

## Question

Nothing has ever run on real Google Apps Script or a real phone; everything was tested against mocks. Deploy to a throwaway test Sheet, run `runTests`, and record what really happens so later decisions rest on facts.

Record: do all `runTests` checks pass on Google; does the live camera scan work on Android Chrome and iPhone Safari; does the photo-attach flow work; does the offline queue survive closing and reopening the page on both phones; do the daily email, damaged email and monthly PDF actually arrive; how long does a dashboard load take; any permission prompts or errors.

Output: a short findings note linked from this ticket. This ticket does not decide anything; it unblocks the offline, pilot and dependency decisions.
