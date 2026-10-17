# Onboarding metrics (v13 peek routes)

No schema. The guide stores the last step reached in `user_private.induction_step`
(through `induction_step_set`) and stamps `user_private.induction_done_at` (through
`induction_finish`, also on Skip). Every v13 step id starts with its route prefix:
`c_` creator (self sign-up owner), `i_` invited creator (admin or agency), `a_` approver
(client). Ids without one of these prefixes are older guides or the approver who signed
up alone (`approver_brand`, `approver_waiting`) and are left out.

Run these read-only queries via the Supabase MCP `execute_sql` on project
`movnexawfhsyuluspxoc` (v2). Nothing here writes.

## Started, completed and completion rate per route

```sql
select
  left(up.induction_step, 2)                         as route_prefix,
  count(*)                                           as started,
  count(*) filter (where up.induction_done_at is not null) as completed,
  round(100.0 * count(*) filter (where up.induction_done_at is not null) / count(*), 1)
                                                     as completed_pct
from public.user_private up
where left(up.induction_step, 2) in ('c_', 'i_', 'a_')
group by 1
order by 1;
```

## Last step reached (drop-off) per route, people who have not finished

```sql
select
  left(up.induction_step, 2) as route_prefix,
  up.induction_step          as last_step_reached,
  count(*)                   as people
from public.user_private up
where left(up.induction_step, 2) in ('c_', 'i_', 'a_')
  and up.induction_done_at is null
group by 1, 2
order by 1, 3 desc;
```

## Last step reached by people who finished (Skip shows as an early step)

```sql
select
  left(up.induction_step, 2) as route_prefix,
  up.induction_step          as last_step_reached,
  count(*)                   as people
from public.user_private up
where left(up.induction_step, 2) in ('c_', 'i_', 'a_')
  and up.induction_done_at is not null
group by 1, 2
order by 1, 3 desc;
```

Notes:

- "Started" means the guide stored at least one v13 step for the person. A person who
  signs up but never reaches the first guided step has no prefixed step and is not counted.
- Going past the last step stores the route's closing card id (`c_closing`, `i_closing`,
  `a_closing`) before `induction_done_at` is stamped, so a finished person whose last step is
  `*_closing` completed the tour; an earlier last step with `induction_done_at` set means they
  tapped Skip there. Entering the look-around stores `*_intro`.
