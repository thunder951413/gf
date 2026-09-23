# Discussion topic frequency experiment

Run the deterministic offline experiment with:

```sh
node scripts/evaluate-discussion-frequency.mjs
```

The script prints JSON and writes the same result to
`.runtime/discussion-topics/frequency.json`. Its `targetOpportunityShare` and
`categoryOpportunityShares` fields measure only how often `choose()` offers a
topic under controlled synthetic history. They are not the application's
message-sending frequency, conversation naturalness, or user satisfaction.

The four variants differ only in whether the saved user response contains no
feedback, explicit category-level `wants_more`, `less`, or `blocked`. They use
the same catalog, prior exposure, most recent category, clock, sample count,
and random seed. The target exposure is older than the seven-day cooldown, so
the comparison isolates feedback weighting. Re-run with `--seed`, `--samples`,
or `--output` to change those explicit parameters.
