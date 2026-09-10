# Experiment handoff

Scope: comprehensive attention simulation only. No production server/lib/public changes, deployment, live messages, settings mutations, notifications or TTS except the lead's final completion speech.

Delegation: one Sol worker implemented the isolated lexical retriever and its mechanism tests; one Sol worker independently ran the production-route replay on database copies. Lead authored frozen fixtures, paired real-model harness, long-horizon experiment, summaries, and reviewed all delivered text. Lead requested one scoped-negation correction before v1 freeze; post-run diagnosis established generic tokenizer and query-gate bugs, so a separate v2 file was created and the attention trajectory rerun. V1 evidence remains unchanged.

Acceptance: basic mechanism tests passed, but v1 did not pass retrieval/quality acceptance. V2 improved retrieval regression and fresh-probe coverage; it still did not pass production integration acceptance. No repeated quality-judge calls were used. Provider usage is recorded per experiment call; Codex subagent token/cost telemetry was not available, so no delegated-cost saving is claimed.

Validation: v1 mechanism suites 28 tests; v2 adds 7 focused tests. 90 main interaction nodes, 7 production HTTP replay requests, 109 provider calls total, 2,730 long-horizon selections. Full final interpretation in SUMMARY.md. No deployment was performed; the current request was to simulate and inspect results.
