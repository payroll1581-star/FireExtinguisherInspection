---
label: wayfinder:map
title: Fire Extinguisher Inspection — Stability Map
---

# Fire Extinguisher Inspection — Stability Map

Tracker: local markdown. Tickets live in `wayfinder/tickets/`. A ticket is open when its frontmatter says `status: open`; it is on the **frontier** when every id in `blocked-by` is `closed` and `assignee` is empty. Claim a ticket by writing your name in `assignee` first. Refer to tickets by their title, never by id.

## Destination

A **hardening spec**: a decided, prioritised list of what to add so the system runs stably in production, handed off for a separate implementation effort. Nothing in this map writes product code.

## Notes

- Domain: GAS web app + Google Sheets for fire extinguisher inspection (code in the repo root: `Code.gs`, `Auth.gs`, `Api.gs`, `Notify.gs`, `Report.gs`, `Setup.gs`, `Tests.gs`, front end in `*.html`). Domain terms: ถัง (equipment), การตรวจ (inspection), สถานะ (status), หมดอายุ (expiry).
- Priority order when trade-offs bite: (1) inspection results are never lost, (2) damaged/expired tanks reach a person, (3) inspectors can always get in, (4) the dashboard is correct and fast.
- The operator is not a developer: every monitoring and recovery action must work from the Google Sheet menu or email, never from the Apps Script editor.
- Scale: ≤500 tanks, ≤10 inspectors, 1–5 buildings. Platform stays Google Apps Script + Sheets.
- A real-device pilot (1 building, about 2 weeks, Android and iPhone, with pass criteria) is a mandatory gate before organisation-wide use.
- Skills for grilling tickets: `grilling`, `domain-modeling`.

## Decisions so far

<!-- one line per closed ticket: [title](tickets/file.md): gist -->

## Not yet specified

- Privacy and retention review of the "Anyone" web app deployment and the data it holds (names, photos), including what must be kept as legal evidence and for how long.
- Dashboard behaviour at real data volumes (a year of inspections, many photos); depends on what the real-Google run shows.
- A Thai incident runbook for the operator (what to do when an alert email says the system failed); depends on the monitoring and backup decisions.
- Assembling the final hardening spec from the closed tickets; depends on all of them.

## Out of scope

- New features: a web admin screen, LINE notifications, repair-ticket workflow, GPS capture. Stability only.
- Moving off Google Apps Script / Sheets to another platform.
