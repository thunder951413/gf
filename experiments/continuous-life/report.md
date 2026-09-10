# Continuous life simulation

Simulated 2026-09-07T16:00:00.000Z through 2026-09-21T16:00:00.000Z in five-minute steps using temporary data and no model calls.

## Expected versus actual

| Scenario | Expected | Actual |
|---|---|---|
| dawn | sleeping or waking at home | 睡觉 · 苏州的家中 |
| lunch | a concrete meal block | 吃午饭 · 工作室附近 |
| work | weekday work | 处理下午的工作 · 苏州的工作室 |
| cafe | the fixed character-owned café appointment | 去咖啡馆整理速写 · 苏州的咖啡馆 |
| cafe-home | home routine resumes after the appointment | 整理歌单听音乐 · 苏州的家中 |
| late-night-user | night routine remains coherent when a user may arrive | 睡觉 · 苏州的家中 |
| departure | travel departure location and action | 乘车去南京 · 从苏州前往南京的途中 |
| travel-dinner | meal action at the travel location | 吃晚饭 · 南京 |
| return | return journey before home | 乘车返回苏州 · 从南京返回苏州的途中 |
| overlapping-appointment | explicit character appointment overrides routine | The café agenda item became current over the routine. |
| shared-awaiting | joint movie is never fabricated as active | The joint movie waited, then was cancelled; it never became current. |
| cancel-while-generating | cancellation leaves no completed claim | Cancelled with no completion timestamp or fabricated outcome. |
| downtime | resume at now with no opportunity backlog | Advanced directly to current state; pending backlog was empty. |
| restart | same persisted day plan | Day plan matched byte-for-byte after repository restart. |

## Metrics

- 173 meaningful activity or location transitions
- 13 distinct opportunity candidates; these were observed, not sent
- Affection stayed 55 → 55

## Diary samples

- 2026-09-08 00:00 — 睡觉，苏州的家中
- 2026-09-08 08:10 — 吃早餐，苏州的家中
- 2026-09-08 12:00 — 吃午饭，工作室附近
- 2026-09-08 18:00 — 吃晚饭，苏州的咖啡馆
- 2026-09-08 19:00 — 在咖啡馆写写画画，苏州的咖啡馆
- 2026-09-08 23:20 — 睡觉，苏州的家中
- 2026-09-09 08:00 — 吃早餐，苏州的家中
- 2026-09-09 12:00 — 吃午饭，工作室附近
- 2026-09-09 18:00 — 吃晚饭，苏州的小酒馆
- 2026-09-09 19:00 — 去咖啡馆整理速写，苏州的咖啡馆
- 2026-09-09 20:00 — 去咖啡馆整理速写，苏州的咖啡馆
- 2026-09-09 23:20 — 睡觉，苏州的家中
- 2026-09-10 08:00 — 吃早餐，苏州的家中
- 2026-09-10 12:00 — 吃午饭，工作室附近
- 2026-09-10 18:00 — 吃晚饭，苏州的家中
- 2026-09-10 23:20 — 睡觉，苏州的家中
- 2026-09-11 08:20 — 吃早餐，苏州的家中
- 2026-09-11 12:00 — 吃午饭，工作室附近
- 2026-09-11 18:00 — 吃晚饭，苏州的咖啡馆
- 2026-09-11 19:00 — 在咖啡馆写写画画，苏州的咖啡馆
- 2026-09-11 23:20 — 睡觉，苏州的家中
- 2026-09-12 08:20 — 吃早餐，苏州的家中
- 2026-09-12 08:50 — 整理去南京的背包，苏州的家中
- 2026-09-12 09:00 — 乘车去南京，从苏州前往南京的途中

The diary entries are state-machine observations and narrative cues. The simulation generated no dialogue.
