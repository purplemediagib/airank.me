# Guest website autofill: bounded Firecrawl parsing

The public checker reserves a monetary amount before each scrape. Its adapter now sends `parsers: []` only when the guest reservation callback is present. This disables automatic PDF/image parsing: a root URL can return a multipage PDF even though the user enters a website domain. A response-size limit cannot undo per-page provider charges already incurred.

Signed-in website-profile workers call the same adapter without that callback and retain their existing request body and provider defaults. No billing configuration, provider credentials, or paid monitoring paths change. Normal HTML markdown autofill remains enabled. A PDF response without usable markdown is rejected before identity inference; users may supply the business information manually instead.

## Reservation assumptions (checked 2026-10-30)

- [Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape): `parsers: []` disables automatic document parsing; disabled PDF parsing uses a flat one-credit fetch instead of one credit per page.
- [Enhanced mode](https://docs.firecrawl.dev/features/enhanced-mode): basic/enhanced scrape is one credit, including the automatic fallback; the adapter makes one POST with no application retry. No JSON/Question/Highlight or other extra-cost formats are requested.
- [Public pricing](https://www.firecrawl.dev/pricing): Hobby extra credits are $5 / 1,000 ($0.005 each), the highest listed standard extra-credit unit rate. A configured `preparation.firecrawl.requestUsd` of $0.01 would reserve twice that current published unit rate. This patch does not set or approve that value.

These are conditional reservation assumptions, not an invoice guarantee. Operators must verify their actual contract, future pricing, taxes, subscription charges and any provider-side billing changes. Keep this request shape and the reservation rate aligned; disabling parsers must not be removed without revisiting the cost bound. No live provider requests were used for validation.
