# Relationship accumulation projection experiment

## What this prototype tests

This isolated experiment projects normalized, explicit events into a compact relationship context. It does not modify or integrate with production code, data, prompts, deployments, or model calls.

The projection treats relationship accumulation as evidence-backed semantic state:

- current user preferences and boundaries;
- open agreements and explicit updates;
- shared references;
- character self-references kept separate from user facts;
- familiarity described by distinct dates with user participation evidence, rather than an affection or relationship score.

Every event carries `sourceMessageId`, `subjectId`, `characterId`, `actor`, `timestamp`, `type`, `key`, and `value`. Supported types are `preference`, `boundary`, `agreement`, `agreement_update`, `shared_reference`, `ordinary_contact`, and `reset`.

## Observed properties in the synthetic fixture

The fixture covers early warmth, a same-day message burst, a week of shared threads, an explicit boundary, a corrected preference, a promise whose due date passes, a long absence, re-entry, a forget request, and cross-user/cross-character isolation probes.

- Twelve extra contacts on day one still produce one active date, and a character-only proactive day adds none.
- Empty elapsed days create no familiarity evidence and apply no penalty.
- The latest explicit value for the same actor/type/key replaces the older value.
- Persistent boundaries remain until an explicit update or reset. An active same-key temporary boundary overlays the persistent rule without deleting it; at the exclusive `untilAt`, context reverts to the persistent rule. Silence itself never relaxes a persistent boundary.
- A character-authored fictional food preference appears only under character self-references.
- A character statement of intent cannot mark an agreement fulfilled. Passing its due date makes it visibly overdue but still open.
- Replaying an identical source message is idempotent; conflicting reuse of the same ID is rejected.
- Reset removes matching prior semantics and leaves a tombstone. A later explicit event may establish a fresh fact without resurrecting the forgotten evidence.
- Events for another subject or another character are excluded by the exact `(subjectId, characterId)` scope.

The generated [SYNTHETIC-OUTPUT.md](./SYNTHETIC-OUTPUT.md) is a human-readable before/after trace. It is synthetic simulation output, not actual model quality evidence.

## Relation to current production mechanisms

`lib/episodic-memory.mjs` already provides scoped source validation, source-message idempotence, user corrections, tombstones, and context that distinguishes character speech from objective fact. Those are useful foundations, though quote validation proves that a message was stored as written; it does not prove the truth of its claims.

`lib/conversation-policy.mjs` already persists a small set of explicit interaction preferences and lets current user text override the stored plan. `lib/inner-state.mjs` prevents time away from creating longing or sexual pressure, but it also advances a fixed relationship-stage label after 12 interactions. `lib/companion-tuning.mjs` controls expression style and initiative frequency; slider values are not relationship facts and must not become consent or relationship labels.

## Deliberate limits and unresolved product work

Semantic extraction is unresolved. The prototype accepts normalized events only. Scope identifiers, actor roles, timestamps, time zones, and date semantics are supplied by synthetic fixtures; the prototype does not demonstrate that a model can infer them correctly. A normalized `shared_reference` is assumed to have passed prior validation; a raw assistant-only claim cannot prove a shared experience. A product could reuse existing repository logic or same-generation structured metadata, but extraction needs provenance, type-specific validation, and correction/forget handling. Stored quote equality alone is not truth proof.

The prototype is an in-memory replay projection. It does not specify durable schema migrations, concurrent writes, authorization, retention, encryption, UI controls, retrieval ranking, event compaction, source deletion propagation, or multi-device conflict resolution. Its simple latest-event rule uses timestamp and source ID ordering; a production system needs a trusted ordering/revision rule.

Agreement creation is intentionally conservative: character-only proposals do not create shared agreements, and character completion claims remain unverified. Only an explicit user update can close an agreement in this prototype. Production still needs domain-specific operational completion evidence and dispute/correction behavior.

Reset targets an exact actor/type/key inside one subject-character scope. Production needs clear user-facing semantics for “forget this,” broader category deletion, source erasure, backups, derived-cache invalidation, and prevention of re-extraction from old transcripts.

The active-date count is descriptive evidence, not a level, reward, consent signal, or permission to increase affection. The prototype does not invent model-authored relationship stages. It makes no recommendation or claim that these mechanisms have been adopted.

## Run

```sh
node --test experiments/relationship-design/relationship-projection.test.mjs
node experiments/relationship-design/simulate.mjs
```
