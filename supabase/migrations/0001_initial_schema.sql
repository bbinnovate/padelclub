-- Padel Club multi-venue foundation.
-- The exclusion constraint is the final authority against overlapping bookings.
create extension if not exists "pgcrypto";
create extension if not exists "btree_gist";

create type public.booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
create type public.payment_status as enum ('pending', 'paid', 'partially_paid', 'complimentary');
create type public.membership_status as enum ('active', 'expired', 'suspended');
create type public.block_type as enum ('maintenance', 'cleaning', 'tournament', 'event', 'private_reservation');

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  city text not null,
  timezone text not null default 'Asia/Kolkata',
  opens_at time not null default '06:00',
  closes_at time not null default '23:59:59',
  cancellation_notice_hours integer not null default 6 check (cancellation_notice_hours >= 0),
  upi_qr_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sports (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  slug text not null,
  facility_label text not null default 'Court',
  min_booking_minutes integer not null default 60 check (min_booking_minutes > 0),
  max_booking_minutes integer not null check (max_booking_minutes >= min_booking_minutes),
  player_options integer[] not null default array[2, 3, 4],
  is_active boolean not null default true,
  unique (venue_id, slug)
);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  sport_id uuid not null references public.sports(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  slot_minutes integer not null default 30 check (slot_minutes > 0),
  price_per_slot integer not null default 125000 check (price_per_slot >= 0),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  unique (sport_id, name)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  mobile text not null unique,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status membership_status not null default 'active',
  deposit_amount integer not null default 0,
  deposit_date date,
  expires_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  unique (venue_id, user_id)
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  verification_code text not null unique,
  venue_id uuid not null references public.venues(id),
  court_id uuid not null references public.courts(id),
  user_id uuid references public.profiles(id),
  guest_name text,
  guest_mobile text,
  guest_email text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  player_count integer not null check (player_count > 0),
  source text not null default 'web' check (source in ('web', 'mobile', 'phone', 'walk_in', 'staff', 'corporate')),
  status booking_status not null default 'confirmed',
  amount_due integer not null check (amount_due >= 0),
  payment_status payment_status not null default 'pending',
  cancellation_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (extract(epoch from (ends_at - starts_at)) / 60 >= 60)
);

alter table public.bookings add constraint prevent_overlapping_bookings
  exclude using gist (
    court_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status in ('pending', 'confirmed'));

create table public.booking_history (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  action text not null,
  actor_id uuid references auth.users(id),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create table public.booking_payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  amount integer not null check (amount > 0),
  method text not null default 'upi_qr',
  reference text,
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.blocked_slots (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  court_id uuid references public.courts(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  type block_type not null,
  reason text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id) on delete cascade,
  checked_in_at timestamptz,
  no_show boolean not null default false,
  staff_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.venue_staff (
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('super_admin', 'venue_manager', 'front_desk', 'coach')),
  primary key (venue_id, user_id)
);

create index bookings_venue_start_idx on public.bookings (venue_id, starts_at);
create index bookings_user_start_idx on public.bookings (user_id, starts_at desc);
create index bookings_guest_mobile_idx on public.bookings (guest_mobile);
create index blocked_slots_court_start_idx on public.blocked_slots (court_id, starts_at);

alter table public.venues enable row level security;
alter table public.sports enable row level security;
alter table public.courts enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_history enable row level security;
alter table public.booking_payments enable row level security;
alter table public.blocked_slots enable row level security;
alter table public.checkins enable row level security;
alter table public.venue_staff enable row level security;

create policy "Public can view active venues" on public.venues for select using (is_active);
create policy "Public can view active sports" on public.sports for select using (is_active);
create policy "Public can view active courts" on public.courts for select using (is_active);
create policy "Users can read own profile" on public.profiles for select using (auth.uid() = id);
create policy "Users can read own bookings" on public.bookings for select using (auth.uid() = user_id);

create or replace function public.is_venue_staff(target_venue uuid, allowed_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.venue_staff
    where venue_id = target_venue and user_id = auth.uid() and role = any(allowed_roles)
  );
$$;

create policy "Staff can read venue bookings" on public.bookings for select
  using (public.is_venue_staff(venue_id, array['super_admin','venue_manager','front_desk','coach']));
create policy "Managers can update venue bookings" on public.bookings for update
  using (public.is_venue_staff(venue_id, array['super_admin','venue_manager','front_desk']));

create or replace function public.validate_booking_duration()
returns trigger language plpgsql set search_path = public as $$
declare
  booking_minutes integer;
  minimum_minutes integer;
  maximum_minutes integer;
  allowed_players integer[];
begin
  booking_minutes := extract(epoch from (new.ends_at - new.starts_at)) / 60;
  select sports.min_booking_minutes, sports.max_booking_minutes, sports.player_options
  into minimum_minutes, maximum_minutes, allowed_players
  from public.courts
  join public.sports on sports.id = courts.sport_id
  where courts.id = new.court_id;

  if booking_minutes < minimum_minutes or booking_minutes > maximum_minutes or booking_minutes % 30 <> 0 then
    raise exception 'Booking duration violates sport rules';
  end if;
  if not new.player_count = any(allowed_players) then
    raise exception 'Player count violates sport rules';
  end if;
  return new;
end;
$$;

create trigger validate_booking_duration_before_write
before insert or update of starts_at, ends_at, court_id on public.bookings
for each row execute function public.validate_booking_duration();

insert into public.venues (name, slug, city)
values ('Padel Club', 'padel-club', 'Mumbai');

insert into public.sports (venue_id, name, slug, facility_label, max_booking_minutes, player_options)
select id, 'Padel', 'padel', 'Court', 180, array[2, 3, 4] from public.venues where slug = 'padel-club'
union all
select id, 'Pickleball', 'pickleball', 'Court', 120, array[2, 3, 4] from public.venues where slug = 'padel-club'
union all
select id, 'Turf Cricket', 'turf-cricket', 'Ground', 180, array[6, 8, 10, 12] from public.venues where slug = 'padel-club';

insert into public.courts (venue_id, sport_id, name, sort_order, price_per_slot)
select sports.venue_id, sports.id, sports.facility_label || ' ' || series.number, series.number,
  case sports.slug when 'padel' then 125000 when 'pickleball' then 80000 else 150000 end
from public.sports
cross join lateral generate_series(
  1,
  case sports.slug when 'padel' then 2 when 'pickleball' then 4 else 3 end
) as series(number);
