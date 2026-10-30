# Sources

Every external fact used in the README, slides, demo and submission, with where it came from.

## ZATCA rules implemented in code
| Fact | Source |
|---|---|
| Seller VAT number must be 15 digits, first and last digit "3" (rule BR-KSA-40) | [LookupTax — Saudi Arabia VAT guidelines (quotes ZATCA XML Implementation Standard)](https://lookuptax.com/docs/country/saudi-arabia-vat-guidelines-indirect-tax); [Qoyod — Error 1001](https://www.qoyod.com/en/learn/error-1001/) |
| Standard VAT rate 15% from 1 July 2020 (was 5%) | [Deloitte Middle East](https://www.deloitte.com/middle-east/en/services/tax/perspectives/ksa-vat-rate-increase-15percent-1-july-2020.html); [PwC](https://pwc.com/m1/en/services/tax/me-tax-legal-news/2021/saudi-arabia-end-of-the-transitional-period-for-vat-rate-increase.html) |
| QR = Base64 of TLV; tags 1–5 = seller name, VAT number, timestamp, total incl. VAT, VAT total | [Qoyod — QR code in the e-invoice](https://www.qoyod.com/en/learn/qr-code-in-e-invoice/); [SAP Community — KSA e-invoice guide](https://community.sap.com/t5/application-development-and-automation-blog-posts/e-invoice-sap-implementation-guide-for-ksa/ba-p/13508684) |
| Phase 2 QR has 9 tags (adds hash, signature, public key, CA signature) | [DEV Community — ZATCA Wave 25](https://dev.to/mousah20/zatca-wave-25-what-developers-integrating-before-1-february-2027-need-to-know-4lkn); [Wafeq](https://www.wafeq.com/en-sa/tax-and-reporting/qr-code-requirements-for-e-invoices-zatca-saudi-arabia) |
| Phase 2 invoices are UBL 2.1 XML aligned with EN 16931 | [Invopop — Saudi Arabia timeline](https://docs.invopop.com/timelines/saudi-arabia) |

## ZATCA timeline
| Fact | Source |
|---|---|
| Phase 1 (Generation) started 4 Dec 2021; Phase 2 (Integration) rolled out in waves, each notified ≥6 months ahead | [ZATCA news 1361](https://zatca.gov.sa/en/MediaCenter/News/Pages/news_1361.aspx) |
| Phase 2 started 1 Jan 2023 | [SAP Community](https://community.sap.com/t5/application-development-and-automation-blog-posts/e-invoice-sap-implementation-guide-for-ksa/ba-p/13508684) |
| Wave 25 (announced 24 Jul 2026): turnover > SAR 187,500 must integrate by 1 Feb 2027; waves 1–24 went from SAR 3 bn down to SAR 375,000 | [DEV Community](https://dev.to/mousah20/zatca-wave-25-what-developers-integrating-before-1-february-2027-need-to-know-4lkn) |

## Accounts payable benchmarks (Ardent Partners)
| Fact | Source |
|---|---|
| 2025: avg $9.40 per invoice, best-in-class $2.78; avg 9.2 days; 53% cite exceptions as top challenge; best-in-class 49.2% touchless | [apexanalytix summary of "AP Metrics That Matter in 2025"](https://www.apexanalytix.com/resources/blog/ardent-partners-key-ap-metrics-2025/) |
| State of ePayables 2025: $9.84 per invoice, 8.2 days, 18.4% exception rate | [Codebridge](https://www.codebridge.tech/articles/how-to-automate-accounts-payable) |
| Best-in-class 3.1 days vs 17.4 days for others | [Medius](https://www.medius.com/resources/guides-reports/ardent-partners-accounts-payable-metrics-that-matter/) |
| Best-in-class exception rate 9% vs 22% | [Thomson Reuters](https://europe.thomsonreuters.com/blog/3-ap-metrics-that-matter) |

## Fraud (ACFE Occupational Fraud 2024)
| Fact | Source |
|---|---|
| 1,921 cases, 138 countries; orgs lose ~5% of revenue to fraud; median loss $145,000 | [GRF CPAs](https://www.grfcpa.com/?p=4822) |
| Billing schemes: 22% of cases, $100,000 median loss, typically 18 months before detection | [CoStar](https://www.costar.com/article/1184241407/employee-committed-fraud-costs-companies-billions-in-losses-report-says) |
| Data monitoring cut median fraud duration 58% and median loss 52% | [Wipfli](https://www.wipfli.com/insights/articles/ra-identifying-the-risks-of-occupational-fraud) |

## HUMAIN context
| Fact | Source |
|---|---|
| HUMAIN ONE launched at FII9 (Oct 2025) as an agentic enterprise OS, powered by ALLaM; extending agents into procurement and finance; HUMAIN Marketplace for third-party agents | [Campaign Middle East](https://campaignme.com/humain-unveils-humain-one-a-next-gen-agentic-ai-operating-system-at-fii-in-riyadh/) |
| HUMAIN ONE on AWS (May 2026); CEO: enterprises want "measurable value at scale" | [HPCwire](https://www.hpcwire.com/aiwire/2026/05/04/humain-expands-aws-collaboration-with-humain-one-enterprise-ai-operating-system/) |

## Method notes
- **Naive all-LLM token estimate** (`eval/run.js`): 5 agent steps per invoice, each re-sending the document (chars ÷ 4) + ~600 instruction/context tokens + ~250 output tokens. It is an estimate of a common design, not a measurement of a specific product.
- **Wazin tokens without an API key** are projected as one call per free-text invoice (prompt + document + reply). With `--llm` they are measured.
- **Synthetic data**: supplier names, POs, IBANs and amounts are fictional; defects are injected with known labels so precision and recall can be computed exactly.

## Deployment and data protection
| Fact | Source |
|---|---|
| Render `generateValue` makes a random base64-encoded 256-bit value; Blueprint syntax | [Render Blueprint YAML reference](https://render.com/docs/yaml-spec) |
| Render free web services sleep after 15 minutes idle, wake in about a minute, cannot use persistent disks | [Render: Deploy for free](https://render.com/docs/free) |
| Saudi PDPL in force 14 Sep 2023, fully enforceable by SDAIA from 14 Sep 2024; safeguards for transfers abroad | [Clyde & Co](https://www.clydeco.com/en/insights/2024/09/saudi-arabia-s-personal-data-protection-law-become) |
| "Sanad Mohammed bin Salman" is a national social-support programme launched 30 Dec 2018 (why the project was renamed) | [Saudipedia](https://saudipedia.com/سند-محمد-بن-سلمان) |
