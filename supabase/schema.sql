-- =====================================================================
-- منصة تحكيم جادة ثون — قاعدة البيانات (Supabase / PostgreSQL)
-- شغّل هذا الملف كاملاً مرة واحدة من: Supabase → SQL Editor → New query
-- يمكن تشغيله مرة أخرى بأمان بعد أي تحديث (لا يحذف البيانات).
-- =====================================================================

-- ---------- الجداول ----------

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  city          text not null default '',
  event_date    date,
  scale         int  not null default 5 check (scale between 3 and 10),
  status        text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  live_visible  boolean not null default true,
  reveal        int  not null default 0 check (reveal between 0 and 3),
  criteria      jsonb not null default '[]'::jsonb,   -- [{key, label, desc, weight}]
  teams         jsonb not null default '[]'::jsonb,   -- [{id, name}]
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.judges (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events(id) on delete cascade,
  name       text not null,
  position   int  not null default 0,
  code       text not null unique default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now()
);
create index if not exists judges_event_idx on public.judges(event_id);

create table if not exists public.scores (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events(id) on delete cascade,
  judge_id    uuid references public.judges(id) on delete set null,
  judge_name  text not null,
  team_id     text not null,
  vals        jsonb not null,           -- {criterion_key: 1..scale}
  worthy      boolean not null,
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  constraint scores_one_per_judge_team unique (event_id, judge_id, team_id)
);
create index if not exists scores_event_idx on public.scores(event_id);

create table if not exists public.settings (
  id             int primary key default 1 check (id = 1),
  current_event  uuid references public.events(id) on delete set null
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.admins (
  email text primary key
);

-- ---------- الصلاحيات ----------

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

alter table public.events   enable row level security;
alter table public.judges   enable row level security;
alter table public.scores   enable row level security;
alter table public.settings enable row level security;
alter table public.admins   enable row level security;

drop policy if exists admin_all on public.events;
create policy admin_all on public.events   for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all on public.judges;
create policy admin_all on public.judges   for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all on public.scores;
create policy admin_all on public.scores   for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_all on public.settings;
create policy admin_all on public.settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists admin_read on public.admins;
create policy admin_read on public.admins  for select to authenticated using (public.is_admin());
-- لا توجد سياسات للزوار (anon): لا يقرؤون الجداول مباشرة، بل عبر الدوال أدناه فقط.

-- ---------- حساب النتائج ----------
-- يعيد الترتيب كاملاً للمنظّمين، أو عندما يكون الترتيب ظاهراً للجمهور.
-- أسماء الفائزين لا تظهر للجمهور إلا بعد كشف كل مركز.

create or replace function public.event_results(p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  e events;
  admin_view boolean := public.is_admin();
  full_access boolean;
  res jsonb;
begin
  select * into e from events where id = p_event_id;
  if not found then return null; end if;
  if not admin_view and p_event_id is distinct from (select current_event from settings where id = 1) then
    return null;
  end if;
  full_access := admin_view or e.live_visible;

  res := (
    with crit as (
      select c ->> 'key' as key, coalesce((c ->> 'weight')::numeric, 0) as weight
      from jsonb_array_elements(e.criteria) c
    ),
    tms as (
      select t ->> 'id' as id, t ->> 'name' as name, x.ord
      from jsonb_array_elements(e.teams) with ordinality as x(t, ord)
    ),
    complete as (
      select s.*, coalesce(s.judge_id::text, 'n:' || s.judge_name) as judge_key
      from scores s
      where s.event_id = e.id
        and s.team_id in (select id from tms)
        and not exists (select 1 from crit where not (s.vals ? crit.key))
    ),
    vals as (
      select s.id as sid, s.judge_key, s.team_id, crit.key, (s.vals ->> crit.key)::numeric as v
      from complete s cross join crit
    ),
    jstat as (
      select judge_key, avg(v) as m, coalesce(nullif(stddev_pop(v), 0), 1) as sd
      from vals group by judge_key
    ),
    evalz as (
      select v.sid, v.team_id, (avg(v.v) - j.m) / j.sd as z, sum(v.v) as total
      from vals v join jstat j using (judge_key)
      group by v.sid, v.team_id, j.m, j.sd
    ),
    per as (
      select team_id, key, avg(v) as a from vals group by team_id, key
    ),
    agg as (
      select t.id, t.name, t.ord,
        (select count(*) from complete c where c.team_id = t.id) as n,
        (select count(*) from complete c where c.team_id = t.id and c.worthy) as yes,
        (select coalesce(max(total) - min(total), 0) from evalz z where z.team_id = t.id) as spread,
        (select avg(z) from evalz z where z.team_id = t.id) as z,
        (select jsonb_object_agg(key, round(a, 3)) from per p where p.team_id = t.id) as per,
        (select round(sum(p.a / e.scale * c.weight) / nullif((select sum(weight) from crit), 0) * 100, 1)
           from per p join crit c on c.key = p.key where p.team_id = t.id) as score
      from tms t
    ),
    ranked as (
      select a.*,
        rank() over (order by score desc nulls last, yes desc, spread asc) as rk,
        row_number() over (order by z desc nulls last, score desc nulls last) as zr
      from agg a where n > 0
    ),
    placed as (
      select r.*, row_number() over (order by rk, ord) as place from ranked r
    ),
    jprog as (
      select x.name, x.cnt, x.ord from (
        select jd.name, (select count(*) from complete c where c.judge_id = jd.id) as cnt, jd.position as ord
        from judges jd where jd.event_id = e.id
        union all
        select c.judge_name, count(*), 100000
        from complete c
        where c.judge_id is null or c.judge_id not in (select id from judges where event_id = e.id)
        group by c.judge_name
      ) x
    )
    select jsonb_build_object(
      'received', (select count(*) from complete),
      'expected', jsonb_array_length(e.teams) * greatest(
                    (select count(*) from judges where event_id = e.id),
                    (select count(distinct judge_key) from complete)),
      'judges', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'count', cnt) order by ord, name) from jprog), '[]'::jsonb),
      'rows', case when full_access then coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'id', id, 'name', name, 'rank', rk, 'score', score, 'per', coalesce(per, '{}'::jsonb),
                   'yes', yes, 'n', n, 'spread', spread, 'z_rank', zr) order by rk, ord)
                 from ranked), '[]'::jsonb) else null end,
      'unscored', case when full_access then coalesce((
                 select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by ord)
                 from agg where n = 0), '[]'::jsonb) else null end,
      'winners', coalesce((
                 select jsonb_agg(
                   case when admin_view or e.reveal >= 4 - w.place
                     then jsonb_build_object('place', w.place, 'name', w.name, 'score', w.score, 'yes', w.yes, 'n', w.n)
                     else jsonb_build_object('place', w.place, 'hidden', true) end
                   order by w.place)
                 from placed w where w.place <= 3), '[]'::jsonb),
      'scored_count', (select count(*) from ranked)
    )
  );
  return res;
end;
$$;

-- ---------- ما يراه الجمهور ----------

create or replace function public.public_state()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare e events;
begin
  select ev.* into e from settings s join events ev on ev.id = s.current_event where s.id = 1;
  if not found then return jsonb_build_object('event', null); end if;
  return jsonb_build_object(
    'event', jsonb_build_object(
      'id', e.id, 'name', e.name, 'city', e.city, 'event_date', e.event_date, 'scale', e.scale,
      'status', e.status, 'live_visible', e.live_visible, 'reveal', e.reveal,
      'criteria', e.criteria, 'teams', e.teams,
      'judges', coalesce((select jsonb_agg(name order by position, name) from judges where event_id = e.id), '[]'::jsonb)
    ),
    'results', public.event_results(e.id)
  );
end;
$$;

-- ---------- صفحة المحكّم (بالرمز الخاص في رابطه) ----------

create or replace function public.judge_session(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare j judges; e events;
begin
  select * into j from judges where code = p_code;
  if not found then return null; end if;
  select * into e from events where id = j.event_id;
  return jsonb_build_object(
    'judge', jsonb_build_object('id', j.id, 'name', j.name),
    'event', jsonb_build_object(
      'id', e.id, 'name', e.name, 'city', e.city, 'event_date', e.event_date, 'scale', e.scale,
      'status', e.status, 'criteria', e.criteria, 'teams', e.teams),
    'scores', coalesce((
      select jsonb_object_agg(team_id, jsonb_build_object('v', vals, 'worthy', worthy, 'note', note, 'at', updated_at))
      from scores where judge_id = j.id), '{}'::jsonb)
  );
end;
$$;

create or replace function public.submit_score(
  p_code text, p_team_id text, p_vals jsonb, p_worthy boolean, p_note text default ''
)
returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  j judges; e events; c jsonb; k text; v numeric; clean jsonb := '{}'::jsonb;
begin
  select * into j from judges where code = p_code;
  if not found then raise exception 'invalid_code'; end if;
  select * into e from events where id = j.event_id;
  if e.status <> 'open' then raise exception 'not_open'; end if;
  if not exists (select 1 from jsonb_array_elements(e.teams) t where t ->> 'id' = p_team_id) then
    raise exception 'bad_team';
  end if;
  if p_worthy is null then raise exception 'bad_worthy'; end if;
  for c in select * from jsonb_array_elements(e.criteria) loop
    k := c ->> 'key';
    begin
      v := (p_vals ->> k)::numeric;
    exception when others then
      raise exception 'bad_value';
    end;
    if v is null or v <> trunc(v) or v < 1 or v > e.scale then raise exception 'bad_value'; end if;
    clean := clean || jsonb_build_object(k, v::int);
  end loop;
  insert into scores (event_id, judge_id, judge_name, team_id, vals, worthy, note, updated_at)
  values (e.id, j.id, j.name, p_team_id, clean, p_worthy, left(coalesce(p_note, ''), 1000), now())
  on conflict (event_id, judge_id, team_id) do update
    set vals = excluded.vals, worthy = excluded.worthy, note = excluded.note,
        judge_name = excluded.judge_name, updated_at = now();
  return jsonb_build_object('ok', true, 'at', now());
end;
$$;

revoke all on function public.event_results(uuid) from public;
revoke all on function public.public_state() from public;
revoke all on function public.judge_session(text) from public;
revoke all on function public.submit_score(text, text, jsonb, boolean, text) from public;
revoke all on function public.is_admin() from public;
grant execute on function public.event_results(uuid) to anon, authenticated;
grant execute on function public.public_state() to anon, authenticated;
grant execute on function public.judge_session(text) to anon, authenticated;
grant execute on function public.submit_score(text, text, jsonb, boolean, text) to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
