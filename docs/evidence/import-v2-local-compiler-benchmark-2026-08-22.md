# Import V2 local compiler benchmark — 2026-08-22

## Scope and qualification

This is reproducible synthetic local evidence for parser, deterministic row
shaping, immutable-plan expansion, item counts, and the 25-item Workflow-step
bound. It is **not** Production release qualification and does not establish an
Import V2 mutation cap or SLO. The required staging-equivalent durable execution,
database connections/locks, provider retries, crash recovery, and human approval
remain separate rollout gates.

Command:

```text
pnpm benchmark:import-v2
```

The harness uses seven measured iterations after one warm-up, a fixed
`2026-08-22T00:00:00.000Z` planning time, and only generated student values. It
does not connect to a database or provider.

## Results

Times are local p95 milliseconds. Steps are `ceil(mutation items / 25)`.

| Scenario | Rows | Items | Config | Students | Allocations | Payments | Steps | Extract p95 | Compile p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Students only | 100 | 100 | 0 | 100 | 0 | 0 | 4 | 2.55 | 6.14 |
| Students only | 500 | 500 | 0 | 500 | 0 | 0 | 20 | 5.28 | 18.72 |
| Students only | 2,000 | 2,000 | 0 | 2,000 | 0 | 0 | 80 | 11.31 | 44.91 |
| Existing allocation | 100 | 200 | 0 | 100 | 100 | 0 | 8 | 0.82 | 4.07 |
| Existing allocation | 500 | 1,000 | 0 | 500 | 500 | 0 | 40 | 3.76 | 15.02 |
| Existing allocation | 2,000 | 4,000 | 0 | 2,000 | 2,000 | 0 | 160 | 12.19 | 52.94 |
| Approved configuration + allocation | 100 | 301 | 101 | 100 | 100 | 0 | 13 | 0.54 | 7.70 |
| Approved configuration + allocation | 500 | 1,501 | 501 | 500 | 500 | 0 | 61 | 6.65 | 27.86 |
| Approved configuration + allocation | 2,000 | 6,001 | 2,001 | 2,000 | 2,000 | 0 | 241 | 11.62 | 101.77 |
| Current payment | 100 | 200 | 0 | 100 | 0 | 100 | 8 | 0.28 | 6.18 |
| Current payment | 500 | 1,000 | 0 | 500 | 0 | 500 | 40 | 2.24 | 27.93 |
| Current payment | 2,000 | 4,000 | 0 | 2,000 | 0 | 2,000 | 160 | 8.05 | 94.11 |
| 12-month payment history | 100 | 1,300 | 0 | 100 | 0 | 1,200 | 52 | 0.46 | 27.33 |
| 12-month payment history | 500 | 6,500 | 0 | 500 | 0 | 6,000 | 260 | 1.48 | 128.59 |
| 12-month payment history | 2,000 | 26,000 | 0 | 2,000 | 0 | 24,000 | 1,040 | 10.96 | 576.37 |
| 24-month payment history | 100 | 2,500 | 0 | 100 | 0 | 2,400 | 100 | 1.94 | 51.53 |
| 24-month payment history | 500 | 12,500 | 0 | 500 | 0 | 12,000 | 500 | 2.07 | 284.50 |
| 24-month payment history | 2,000 | 50,000 | 0 | 2,000 | 0 | 48,000 | 2,000 | 6.21 | 1,106.56 |

The largest compile-only plan contained 50,000 mutation items. Twice that is
100,000, but **100,000 is not an approved cap**: the runbook requires the
largest selected workload and its two-times headroom to pass durable execution
on staging-equivalent infrastructure before an owner sets
`IMPORT_MAX_PLANNED_MUTATIONS`.
