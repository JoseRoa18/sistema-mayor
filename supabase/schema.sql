-- =====================================================================
-- Sistema Mayor · Esquema de base de datos (Supabase / PostgreSQL)
--
-- Roles de la aplicación:
--   admin     → ve y edita productos (nombre, descripción, cantidad,
--               precio) y define la tasa de cambio del dólar.
--   atencion  → solo puede buscar y ver productos y la tasa.
--
-- Los permisos se aplican en la base de datos con RLS (Row Level
-- Security), no solo en la interfaz. Un usuario sin fila en `perfiles`
-- no puede ver ni modificar nada.
--
-- Uso: copiar y ejecutar completo en Supabase → SQL Editor.
-- Es seguro ejecutarlo varias veces.
-- =====================================================================

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

create table if not exists public.perfiles (
  id        uuid primary key references auth.users (id) on delete cascade,
  nombre    text not null default '',
  rol       text not null check (rol in ('admin', 'atencion')),
  creado_en timestamptz not null default now()
);

create table if not exists public.productos (
  id             bigint generated always as identity primary key,
  nombre         text not null check (char_length(trim(nombre)) > 0),
  descripcion    text not null default '',
  cantidad       integer not null default 0 check (cantidad >= 0),
  precio_cop     numeric(14, 2) not null default 0 check (precio_cop >= 0),
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- Una sola fila (id = 1). tasa_usd = cuántos pesos colombianos vale 1 USD.
create table if not exists public.configuracion (
  id              smallint primary key default 1 check (id = 1),
  tasa_usd        numeric(12, 2) check (tasa_usd > 0),
  actualizado_en  timestamptz not null default now(),
  actualizado_por uuid references auth.users (id) on delete set null
);

insert into public.configuracion (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Funciones
-- ---------------------------------------------------------------------

-- Rol del usuario que hace la petición (null si no tiene perfil).
create or replace function public.rol_actual()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select rol from public.perfiles where id = auth.uid()
$$;

create or replace function public.tocar_producto()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.actualizado_en := now();
  return new;
end
$$;

create or replace function public.tocar_configuracion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.actualizado_en := now();
  new.actualizado_por := auth.uid();
  return new;
end
$$;

drop trigger if exists productos_actualizado on public.productos;
create trigger productos_actualizado
  before update on public.productos
  for each row execute function public.tocar_producto();

drop trigger if exists configuracion_actualizada on public.configuracion;
create trigger configuracion_actualizada
  before update on public.configuracion
  for each row execute function public.tocar_configuracion();

-- Búsqueda sin importar mayúsculas ni tildes ("cafe" encuentra "Café").
-- Cada palabra escrita debe aparecer en el nombre o la descripción.
-- Corre con los permisos de quien llama, así que respeta RLS.
create or replace function public.buscar_productos(q text default '')
returns setof public.productos
language sql
stable
set search_path = public, extensions
as $$
  select p.*
  from public.productos p
  where not exists (
    select 1
    from unnest(regexp_split_to_array(unaccent(lower(coalesce(q, ''))), '\s+')) as palabra
    where palabra <> ''
      and strpos(unaccent(lower(p.nombre || ' ' || p.descripcion)), palabra) = 0
  )
  order by p.nombre
  limit 300
$$;

-- ---------------------------------------------------------------------
-- Privilegios: nada para anónimos; lo mínimo para usuarios con sesión
-- ---------------------------------------------------------------------

revoke all on public.perfiles, public.productos, public.configuracion from anon, authenticated;

grant select on public.perfiles to authenticated;
grant select, insert, delete on public.productos to authenticated;
grant update (nombre, descripcion, cantidad, precio_cop) on public.productos to authenticated;
grant select on public.configuracion to authenticated;
grant update (tasa_usd) on public.configuracion to authenticated;

revoke execute on function public.rol_actual() from public, anon;
revoke execute on function public.buscar_productos(text) from public, anon;
grant execute on function public.rol_actual() to authenticated;
grant execute on function public.buscar_productos(text) to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.perfiles      enable row level security;
alter table public.productos     enable row level security;
alter table public.configuracion enable row level security;

-- Perfiles: cada usuario solo ve el suyo. Los roles se asignan por SQL.
drop policy if exists "ver mi perfil" on public.perfiles;
create policy "ver mi perfil" on public.perfiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Productos: ambos roles ven; solo admin crea, edita y elimina.
drop policy if exists "ver productos" on public.productos;
create policy "ver productos" on public.productos
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'atencion'));

drop policy if exists "crear productos" on public.productos;
create policy "crear productos" on public.productos
  for insert to authenticated
  with check ((select public.rol_actual()) = 'admin');

drop policy if exists "editar productos" on public.productos;
create policy "editar productos" on public.productos
  for update to authenticated
  using ((select public.rol_actual()) = 'admin')
  with check ((select public.rol_actual()) = 'admin');

drop policy if exists "eliminar productos" on public.productos;
create policy "eliminar productos" on public.productos
  for delete to authenticated
  using ((select public.rol_actual()) = 'admin');

-- Tasa de cambio: ambos roles ven; solo admin la cambia.
drop policy if exists "ver configuracion" on public.configuracion;
create policy "ver configuracion" on public.configuracion
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'atencion'));

drop policy if exists "editar tasa" on public.configuracion;
create policy "editar tasa" on public.configuracion
  for update to authenticated
  using ((select public.rol_actual()) = 'admin')
  with check ((select public.rol_actual()) = 'admin');
