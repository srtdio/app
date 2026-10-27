create table public.user_active_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  country_code text check (country_code ~ '^[A-Z]{2}$'),
  first_seen_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index user_active_days_day_idx on public.user_active_days (day);
alter table public.user_active_days enable row level security;
revoke all on public.user_active_days from anon, authenticated;

create function public.user_active_day_mark(p_country text, p_trace_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_country is not null and p_country !~ '^[A-Z]{2}$' then raise exception 'invalid_country' using errcode = '22023'; end if;
  raise log 'user_active_day_mark trace_id=%', p_trace_id;
  insert into public.user_active_days (user_id, day, country_code)
  values (auth.uid(), (now() at time zone 'Asia/Kolkata')::date, p_country)
  on conflict (user_id, day) do nothing;
end $$;
revoke all on function public.user_active_day_mark(text, uuid) from public, anon;
grant execute on function public.user_active_day_mark(text, uuid) to authenticated;

create function public.ops_user_summary(p_days int)
returns jsonb language sql stable security definer set search_path = '' as $$
with d as (select least(greatest(p_days, 1), 90) n, (now() at time zone 'Asia/Kolkata')::date today),
days as (select generate_series(d.today - (d.n - 1), d.today, interval '1 day')::date as day from d),
self_users as (
  select u.id, (u.created_at at time zone 'Asia/Kolkata')::date as day from auth.users u
  where (select m.invited_by from public.workspace_members m where m.user_id = u.id
         order by coalesce(m.accepted_at, m.invited_at) nulls last limit 1) is null),
last_country as (
  select distinct on (a.user_id) a.user_id, a.country_code from public.user_active_days a, d
  where a.day > d.today - 30 order by a.user_id, a.day desc)
select jsonb_build_object(
  'signed_up', (select count(*) from auth.users),
  'confirmed', (select count(*) from auth.users where email_confirmed_at is not null),
  'signed_in_30d', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
  'active_today', (select count(*) from public.user_active_days a, d where a.day = d.today),
  'active_7d', (select count(distinct a.user_id) from public.user_active_days a, d where a.day > d.today - 7),
  'active_30d', (select count(distinct a.user_id) from public.user_active_days a, d where a.day > d.today - 30),
  'daily', (select jsonb_agg(jsonb_build_object('day', x.day,
     'active', (select count(*) from public.user_active_days a where a.day = x.day),
     'self_signups', (select count(*) from self_users s where s.day = x.day)) order by x.day) from days x),
  'countries_30d', (select coalesce(jsonb_agg(jsonb_build_object('country', c.k, 'people', c.n) order by c.n desc), '[]'::jsonb)
     from (select coalesce(country_code, '??') k, count(*) n from last_country group by 1) c))
$$;
revoke all on function public.ops_user_summary(int) from public, anon, authenticated;
grant execute on function public.ops_user_summary(int) to service_role;
