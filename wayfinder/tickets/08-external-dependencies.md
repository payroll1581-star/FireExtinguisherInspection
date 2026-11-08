---
title: Risk from libraries and fonts loaded from other sites
type: research
mode: AFK
status: open
blocked-by: []
assignee:
---

## Question

The page loads the QR scanner from unpkg, fonts from Google Fonts and the QR generator from cdnjs. Establish the facts a decision waits on: which of these can be inlined into the HtmlService page within Apps Script size limits, whether versions and integrity can be pinned, what actually breaks if each host is down (scanner, fonts, print labels), and what the HtmlService sandbox allows for loading them. Use primary sources (Google Apps Script documentation, the libraries' own docs). Findings go in a note linked from this ticket; no code changes.
