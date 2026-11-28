# NOD money contract: USD only

The user requires one accounting currency throughout NOD: USD. This overrides older multi-currency designs and the incorrect currency behavior of the original 215 patch.

- Only USD amounts are admitted to operational monetary facts, prices, costs, aggregates, API results and UI. There is no currency selector, FX conversion, foreign-currency total or mixed-currency display mode.
- Omitted currency can mean USD only at a documented OnlyFans or NOD input boundary. Persisted money must explicitly satisfy its USD authority. An explicit unsupported currency fails validation; changing its label to USD is not a repair.
- Gross, net, price, tax, refund and source timestamps retain their original meanings. USD-only never authorizes inventing amounts or substituting gross for net.
- Historic unsupported data remains auditable and is excluded from usable money authority. A contaminated aggregate is unavailable/partial with an explicit reason, not a zero or a relabeled dollar amount. Other valid activity and creator scopes remain usable.
- Claims change attribution and resolution, not canonical amounts or currency. Accepted manual ownership and audit history survive quarantine.
- Provider payment asset fields are signed external settlement evidence. NOD invoices, wallet balances, debits and credits remain USD and require a valid USD quote.
- Currency codes other than USD may occur only in rejection tests, historic raw evidence or third-party settlement asset metadata. They are not supported NOD accounting currencies.

Any future change must preserve this contract at the source boundary, database/projection boundary and rendered output. Tests should prove USD success and unsupported-currency rejection, not reintroduce positive multi-currency examples.
