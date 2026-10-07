-- =====================================================================
-- Sistema Mayor · Esquema de base de datos (Supabase / PostgreSQL)
--
-- Roles de la aplicación:
--   admin     → crea y edita productos (código, nombre, descripción, precio),
--               define la tasa del dólar, ve el cierre del día y registra
--               entradas/salidas y anulaciones (estas con la clave del jefe).
--   atencion  → busca y ve productos, y vende con su código de vendedor.
--   jefe      → todo lo del administrador sin pedir clave, más la
--               configuración: vendedores (y sus códigos) y la clave del jefe.
--
-- La cantidad de un producto nunca se escribe directamente: solo cambia con
-- registrar_venta, anular_venta y registrar_movimiento.
-- La clave del jefe (cifrada) es la que el jefe teclea en el computador del
-- administrador para autorizar entradas, salidas y anulaciones.
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
  rol       text not null check (rol in ('admin', 'atencion', 'jefe')),
  creado_en timestamptz not null default now()
);

-- Para bases creadas antes de que existiera el rol jefe.
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check check (rol in ('admin', 'atencion', 'jefe'));

create table if not exists public.productos (
  id             bigint generated always as identity primary key,
  codigo         text,
  nombre         text not null check (char_length(trim(nombre)) > 0),
  descripcion    text not null default '',
  cantidad       integer not null default 0 check (cantidad >= 0),
  precio_cop     numeric(14, 2) not null default 0 check (precio_cop >= 0),
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- Para bases creadas antes de que existiera el código.
alter table public.productos add column if not exists codigo text;

-- El código no se puede repetir (los productos sin código no cuentan).
create unique index if not exists productos_codigo_unico on public.productos (codigo);

-- Categorías: lista fija, cada una con la letra con la que empiezan sus códigos
-- (V-3013 → Varios). El jefe puede agregar más en Configuración.
create table if not exists public.categorias (
  prefijo text primary key check (prefijo ~ '^[A-Z]{1,5}$'),
  nombre  text not null unique check (char_length(trim(nombre)) > 0)
);
insert into public.categorias (prefijo, nombre) values
  ('V', 'Varios'), ('L', 'Lavadora'), ('R', 'Refrigeración'), ('C', 'Cocina')
on conflict (prefijo) do nothing;

-- Categoría del producto: obligatoria al crear, editar o importar (los que ya
-- existían sin categoría la reciben la próxima vez que se editen).
alter table public.productos add column if not exists categoria text;
alter table public.productos drop constraint if exists productos_categoria_fkey;
alter table public.productos add constraint productos_categoria_fkey
  foreign key (categoria) references public.categorias (nombre) on update cascade;
create index if not exists productos_categoria on public.productos (categoria);

-- Letra con la que empieza un código: "V-3013" y "V3013" → "V".
create or replace function public.prefijo_codigo(p_codigo text)
returns text
language sql
immutable
set search_path = ''
as $$
  select substring(upper(coalesce(p_codigo, '')) from '^([A-Z]+)')
$$;

-- Los productos que aún no tienen categoría la toman de la letra de su código.
update public.productos p set categoria = c.nombre
from public.categorias c
where p.categoria is null and c.prefijo = public.prefijo_codigo(p.codigo);

-- Una sola fila (id = 1). tasa_usd = cuántos pesos colombianos vale 1 USD.
create table if not exists public.configuracion (
  id              smallint primary key default 1 check (id = 1),
  tasa_usd        numeric(12, 2) check (tasa_usd > 0),
  actualizado_en  timestamptz not null default now(),
  actualizado_por uuid references auth.users (id) on delete set null
);

insert into public.configuracion (id) values (1) on conflict (id) do nothing;

-- ¿Cambiar un precio requiere la clave del jefe? (lo decide el jefe en Configuración)
alter table public.configuracion add column if not exists precio_requiere_clave boolean not null default true;

-- Cada venta guarda una copia del código, nombre, precio y tasa del momento,
-- para que el reporte no cambie si después se edita o elimina el producto.
-- Solo se crean y anulan con las funciones registrar_venta / anular_venta.
create table if not exists public.ventas (
  id              bigint generated always as identity primary key,
  producto_id     bigint references public.productos (id) on delete set null,
  codigo          text,
  nombre          text not null,
  cantidad        integer not null check (cantidad > 0),
  precio_unitario numeric(14, 2) not null check (precio_unitario >= 0),
  total           numeric(14, 2) not null check (total >= 0),
  tasa_usd        numeric(12, 2),
  vendedor        text not null default '',
  vendido_por     uuid references auth.users (id) on delete set null,
  vendido_en      timestamptz not null default now(),
  anulada_en      timestamptz,
  anulada_por     uuid references auth.users (id) on delete set null
);

create index if not exists ventas_vendido_en on public.ventas (vendido_en);

-- Clave del jefe y códigos de vendedor: solo se guardan cifrados (bcrypt).
-- Nadie puede leer estas tablas desde la app; solo las usan las funciones.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.seguridad (
  id                       smallint primary key default 1 check (id = 1),
  clave_jefe_hash          text,
  intentos_jefe            integer not null default 0,
  jefe_bloqueado_hasta     timestamptz,
  intentos_vendedor        integer not null default 0,
  vendedor_bloqueado_hasta timestamptz
);

insert into public.seguridad (id) values (1) on conflict (id) do nothing;

create table if not exists public.vendedores (
  id             bigint generated always as identity primary key,
  nombre         text not null check (char_length(trim(nombre)) > 0),
  codigo_hash    text not null,
  activo         boolean not null default true,
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

-- ¿Esta persona puede hacer el cierre del día con su código? (lo decide el jefe)
alter table public.vendedores add column if not exists puede_cerrar boolean not null default false;

alter table public.ventas add column if not exists vendedor_id bigint references public.vendedores (id) on delete set null;

-- Día del negocio: la fecha en la zona horaria del sistema (Caracas, UTC-4).
-- Debe coincidir con ZONA_HORARIA de js/config.js.
create or replace function public.dia_negocio(p_momento timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (p_momento at time zone 'America/Caracas')::date
$$;

-- Número de venta: agrupa los productos que se cobraron juntos (carrito).
-- Los números son consecutivos y sin saltos (1, 2, 3…): salen de un contador
-- que avanza dentro de la misma transacción de la venta, así que si la venta
-- no se completa, el número no se gasta.
alter table public.ventas add column if not exists ticket bigint;
create index if not exists ventas_ticket on public.ventas (ticket);

create table if not exists public.numeracion (
  id           smallint primary key default 1 check (id = 1),
  ultima_venta bigint not null default 0
);
insert into public.numeracion (id) values (1) on conflict (id) do nothing;

-- Una sola vez (cuando el contador aún está en 0): numerar en orden de fecha
-- todas las ventas existentes, incluidas las que no tenían número.
do $$
begin
  if (select ultima_venta from public.numeracion where id = 1) = 0 then
    with grupos as (
      select coalesce(ticket::text, 'L' || id) as grupo, min(vendido_en) as inicio, min(id) as primer_id
      from public.ventas
      group by 1
    ), numerados as (
      select grupo, row_number() over (order by inicio, primer_id) as numero from grupos
    )
    update public.ventas v set ticket = n.numero
    from numerados n
    where n.grupo = coalesce(v.ticket::text, 'L' || v.id);

    update public.numeracion set ultima_venta = (select coalesce(max(ticket), 0) from public.ventas) where id = 1;
  end if;
end
$$;

alter table public.ventas alter column ticket set not null;
drop sequence if exists public.ventas_ticket_seq;   -- versión anterior (dejaba saltos)

-- Número del día: cada día las ventas empiezan en #1. El consecutivo interno
-- (ticket) sigue sin reiniciarse nunca.
alter table public.ventas add column if not exists numero_dia integer;
alter table public.ventas add column if not exists categoria text;   -- copia de la categoría al vender
-- Ventas anteriores a las categorías: toman la categoría actual de su producto.
update public.ventas v set categoria = p.categoria
from public.productos p
where p.id = v.producto_id and v.categoria is null and p.categoria is not null;
alter table public.numeracion add column if not exists fecha_dia date;
alter table public.numeracion add column if not exists ultima_del_dia integer not null default 0;

-- Una sola vez: numerar por día las ventas que ya existían.
do $$
begin
  if exists (select 1 from public.ventas where numero_dia is null) then
    with ventas_dia as (
      select ticket, public.dia_negocio(min(vendido_en)) as dia from public.ventas group by ticket
    ), numerados as (
      select ticket, dia, row_number() over (partition by dia order by ticket) as numero from ventas_dia
    )
    update public.ventas v set numero_dia = n.numero
    from numerados n
    where n.ticket = v.ticket and v.numero_dia is null;

    update public.numeracion set
      fecha_dia = (select public.dia_negocio(max(vendido_en)) from public.ventas),
      ultima_del_dia = (select coalesce(max(numero_dia), 0) from public.ventas
                        where public.dia_negocio(vendido_en) = (select public.dia_negocio(max(vendido_en)) from public.ventas))
    where id = 1 and fecha_dia is null;
  end if;
end
$$;

-- Cierres del día: manuales, con el código de una persona autorizada.
-- Un día está cerrado si tiene un cierre sin reabrir.
create table if not exists public.cierres (
  id            bigint generated always as identity primary key,
  fecha         date not null,
  cerrado_por   text not null,
  cerrado_en    timestamptz not null default now(),
  usuario       text not null default '',   -- cuenta con la que se cerró
  totales       jsonb not null,             -- foto de los totales al momento del cierre
  reabierto_por text,
  reabierto_en  timestamptz
);

create index if not exists cierres_fecha on public.cierres (fecha);
create unique index if not exists cierres_un_abierto_por_dia on public.cierres (fecha) where reabierto_en is null;

-- Historial de todo lo que mueve el inventario: ventas, anulaciones,
-- entradas y salidas autorizadas con la clave del jefe.
create table if not exists public.movimientos (
  id            bigint generated always as identity primary key,
  producto_id   bigint references public.productos (id) on delete set null,
  codigo        text,
  nombre        text not null,
  tipo          text not null check (tipo in ('entrada', 'salida', 'venta', 'anulacion')),
  cantidad      integer not null check (cantidad > 0),
  stock_antes   integer,
  stock_despues integer,
  motivo        text not null default '',
  venta_id      bigint references public.ventas (id) on delete set null,
  usuario       text not null default '',   -- cuenta con la que se hizo (admin / publico)
  vendedor      text,                       -- en ventas: quién vendió
  creado_en     timestamptz not null default now()
);

create index if not exists movimientos_creado_en on public.movimientos (creado_en);

-- Historial de precios: cada cambio queda con quién, cuándo, antes y después.
-- Lo llena un trigger, así no hay forma de cambiar un precio sin dejar rastro.
create table if not exists public.historial_precios (
  id              bigint generated always as identity primary key,
  producto_id     bigint references public.productos (id) on delete set null,
  codigo          text,
  nombre          text not null,
  precio_anterior numeric(14, 2),
  precio_nuevo    numeric(14, 2) not null,
  origen          text not null default 'edicion' check (origen in ('creacion', 'edicion', 'importacion')),
  usuario         text not null default '',
  creado_en       timestamptz not null default now()
);

-- 'masivo' = subida o bajada de precios en bloque.
alter table public.historial_precios drop constraint if exists historial_precios_origen_check;
alter table public.historial_precios add constraint historial_precios_origen_check
  check (origen in ('creacion', 'edicion', 'importacion', 'masivo'));

create index if not exists historial_precios_creado_en on public.historial_precios (creado_en);
create index if not exists historial_precios_producto on public.historial_precios (producto_id, creado_en desc);

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

-- Guarda el código en mayúsculas y sin espacios ("abc-12 " → "ABC-12"),
-- y registra la fecha de la última modificación.
create or replace function public.preparar_producto()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.codigo := nullif(upper(trim(new.codigo)), '');
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
drop function if exists public.tocar_producto();

drop trigger if exists productos_preparar on public.productos;
create trigger productos_preparar
  before insert or update on public.productos
  for each row execute function public.preparar_producto();

drop trigger if exists configuracion_actualizada on public.configuracion;
create trigger configuracion_actualizada
  before update on public.configuracion
  for each row execute function public.tocar_configuracion();

-- Búsqueda por código, nombre, descripción o categoría, sin importar mayúsculas,
-- tildes ni guiones ("cafe" encuentra "Café"; "v3013" encuentra "V-3013" y al revés).
-- Cada palabra escrita debe aparecer. p_categoria (opcional) filtra por categoría.
-- Primero salen los productos cuyo código es exactamente el buscado,
-- luego los que empiezan por él, y después el resto por nombre.
-- Corre con los permisos de quien llama, así que respeta RLS.
drop function if exists public.buscar_productos(text);
create or replace function public.buscar_productos(q text default '', p_categoria text default null)
returns setof public.productos
language sql
stable
set search_path = public, extensions
as $$
  -- translate(…, '-–—', '') quita el guion, el guion largo y la raya.
  with buscado as (
    select translate(upper(trim(coalesce(q, ''))), '-–—', '') as codigo
  )
  select p.*
  from public.productos p, buscado b
  where (nullif(trim(coalesce(p_categoria, '')), '') is null or p.categoria = p_categoria)
    and not exists (
      select 1
      from unnest(regexp_split_to_array(unaccent(lower(coalesce(q, ''))), '\s+')) as palabra
      where translate(palabra, '-–—', '') <> ''
        and strpos(translate(unaccent(lower(coalesce(p.codigo, '') || ' ' || p.nombre || ' ' || p.descripcion || ' ' || coalesce(p.categoria, ''))), '-–—', ''),
                   translate(palabra, '-–—', '')) = 0
    )
  order by
    coalesce(translate(p.codigo, '-–—', '') = b.codigo, false) desc,
    coalesce(b.codigo <> '' and starts_with(translate(p.codigo, '-–—', ''), b.codigo), false) desc,
    p.nombre
  limit 300
$$;

drop function if exists public.normalizar_categoria(text);   -- versión anterior (categorías libres)

-- Categoría válida a partir de lo escrito (el nombre, sin importar mayúsculas
-- ni tildes, o la letra: "l" → Lavadora). Si no se escribió nada, se deduce de
-- la letra del código. Devuelve null si no corresponde a ninguna categoría.
create or replace function public.categoria_valida(p_texto text, p_codigo text)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  with escrito as (select nullif(trim(coalesce(p_texto, '')), '') as t)
  select case
    when (select t from escrito) is not null then (
      select c.nombre from public.categorias c, escrito e
      where unaccent(lower(c.nombre)) = unaccent(lower(e.t)) or c.prefijo = upper(e.t)
      limit 1)
    else (select c.nombre from public.categorias c where c.prefijo = public.prefijo_codigo(p_codigo))
  end
$$;

-- Lista de categorías (para el formulario, el filtro y los reportes).
drop function if exists public.lista_categorias();
create or replace function public.lista_categorias()
returns table (prefijo text, nombre text)
language sql
stable
security definer
set search_path = ''
as $$
  select prefijo, nombre from public.categorias order by nombre
$$;

-- Texto con las categorías, para los mensajes de error: "C Cocina, L Lavadora…".
create or replace function public.texto_categorias()
returns text
language sql
stable
set search_path = ''
as $$
  select string_agg(prefijo || ' ' || nombre, ', ' order by nombre) from public.categorias
$$;

-- Cuenta con sesión ("admin", "publico"), para el historial.
create or replace function public.usuario_actual()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select split_part(email, '@', 1) from auth.users where id = auth.uid()), '')
$$;

-- Verifica la clave del jefe. Devuelve null si es correcta o el mensaje de error.
-- 5 intentos fallidos seguidos la bloquean 15 minutos.
-- (Devuelve el error en vez de lanzarlo para que el conteo de intentos se guarde.)
create or replace function public.verificar_clave_jefe(p_clave text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seguridad;
begin
  select * into s from public.seguridad where id = 1 for update;
  if s.clave_jefe_hash is null then
    return 'Todavía no se ha definido la clave del jefe.';
  end if;
  if s.jefe_bloqueado_hasta > now() then
    return format('Demasiados intentos fallidos. Espera %s min e intenta de nuevo.',
                  ceil(extract(epoch from s.jefe_bloqueado_hasta - now()) / 60));
  end if;
  if p_clave is not null and extensions.crypt(p_clave, s.clave_jefe_hash) = s.clave_jefe_hash then
    update public.seguridad set intentos_jefe = 0, jefe_bloqueado_hasta = null where id = 1;
    return null;
  end if;
  if s.intentos_jefe + 1 >= 5 then
    update public.seguridad set intentos_jefe = 0, jefe_bloqueado_hasta = now() + interval '15 minutes' where id = 1;
    return 'Clave del jefe incorrecta. Por seguridad quedó bloqueada 15 minutos.';
  end if;
  update public.seguridad set intentos_jefe = intentos_jefe + 1 where id = 1;
  return format('Clave del jefe incorrecta. Quedan %s intentos.', 4 - s.intentos_jefe);
end
$$;

-- Entradas, salidas y anulaciones: el jefe (usuario con rol "jefe") no
-- necesita clave; el administrador necesita la clave del jefe.
create or replace function public.autorizar_con_clave_jefe(p_clave text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.rol_actual() = 'jefe' then
    return null;
  end if;
  return public.verificar_clave_jefe(p_clave);
end
$$;

-- Busca al vendedor activo con ese código. Devuelve {id, nombre} o {error}.
-- 10 códigos incorrectos seguidos bloquean las ventas 5 minutos.
create or replace function public.identificar_vendedor(p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.seguridad;
  v public.vendedores;
begin
  select * into s from public.seguridad where id = 1 for update;
  if s.vendedor_bloqueado_hasta > now() then
    return jsonb_build_object('error', format('Demasiados códigos incorrectos. Espera %s min e intenta de nuevo.',
                              ceil(extract(epoch from s.vendedor_bloqueado_hasta - now()) / 60)));
  end if;
  select * into v from public.vendedores
  where activo and p_codigo is not null and extensions.crypt(p_codigo, codigo_hash) = codigo_hash
  limit 1;
  if found then
    update public.seguridad set intentos_vendedor = 0, vendedor_bloqueado_hasta = null where id = 1;
    return jsonb_build_object('id', v.id, 'nombre', v.nombre);
  end if;
  if s.intentos_vendedor + 1 >= 10 then
    update public.seguridad set intentos_vendedor = 0, vendedor_bloqueado_hasta = now() + interval '5 minutes' where id = 1;
    return jsonb_build_object('error', 'Código de vendedor incorrecto. Por seguridad las ventas quedaron bloqueadas 5 minutos.');
  end if;
  update public.seguridad set intentos_vendedor = intentos_vendedor + 1 where id = 1;
  return jsonb_build_object('error', 'Código de vendedor incorrecto.');
end
$$;

-- ¿Ya usa otro vendedor activo este código?
create or replace function public.codigo_vendedor_en_uso(p_codigo text, p_excepto bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.vendedores
    where activo and id is distinct from p_excepto
      and extensions.crypt(p_codigo, codigo_hash) = codigo_hash
  )
$$;

-- Las funciones que siguen responden {ok: true, ...} o {ok: false, error, campo}.

-- Registra una venta de uno o varios productos (carrito) en un solo paso:
-- o se registra todo, o nada. p_items = [{"producto_id": 1, "cantidad": 2}, ...].
-- El vendedor se identifica una vez con su código. Todas las líneas comparten
-- el mismo número de venta (ticket). Los productos se bloquean en orden fijo:
-- si dos vendedores venden la última unidad al mismo tiempo, solo uno la vende.
create or replace function public.registrar_venta_multiple(p_items jsonb, p_codigo_vendedor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_vendedor jsonb;
  v_item     record;
  v_producto public.productos;
  v_venta    public.ventas;
  v_ticket   bigint;
  v_dia      integer;
  v_cierre   public.cierres;
  v_tasa     numeric;
  v_lineas   jsonb := '[]'::jsonb;
  v_total    numeric := 0;
begin
  if public.rol_actual() is null then
    raise exception 'No tienes permiso para registrar ventas.' using errcode = '42501';
  end if;
  -- Con el día ya cerrado no se vende (el jefe puede reabrirlo).
  select * into v_cierre from public.cierres where fecha = public.dia_negocio(now()) and reabierto_en is null;
  if found then
    return jsonb_build_object('ok', false, 'motivo', 'dia_cerrado',
      'error', format('El día de hoy ya se cerró (lo cerró %s a las %s). Para seguir vendiendo, el jefe debe reabrirlo.',
                      v_cierre.cerrado_por, replace(replace(to_char(v_cierre.cerrado_en at time zone 'America/Caracas', 'FMHH12:MI AM'), 'AM', 'a. m.'), 'PM', 'p. m.')));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'error', 'El carrito está vacío.');
  end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(producto_id bigint, cantidad integer)
             where x.producto_id is null or x.cantidad is null or x.cantidad < 1) then
    return jsonb_build_object('ok', false, 'error', 'Cada producto debe tener una cantidad de 1 o más.', 'campo', 'cantidad');
  end if;

  v_vendedor := public.identificar_vendedor(p_codigo_vendedor);
  if v_vendedor ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_vendedor ->> 'error', 'campo', 'codigo');
  end if;

  -- 1) Bloquear y revisar todos los productos antes de tocar nada.
  for v_item in
    select producto_id, sum(cantidad)::integer as cantidad
    from jsonb_to_recordset(p_items) as x(producto_id bigint, cantidad integer)
    group by producto_id order by producto_id
  loop
    select * into v_producto from public.productos where id = v_item.producto_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'producto_id', v_item.producto_id,
        'error', 'Un producto del carrito ya no existe. Quítalo e intenta de nuevo.');
    end if;
    if v_producto.cantidad < v_item.cantidad then
      return jsonb_build_object('ok', false, 'campo', 'cantidad', 'producto_id', v_producto.id, 'stock', v_producto.cantidad,
        'error', format('No hay suficientes unidades de %s: solo quedan %s.', v_producto.nombre, v_producto.cantidad));
    end if;
  end loop;

  -- 2) Registrar cada línea con el mismo número de venta: el consecutivo interno
  --    (nunca se reinicia) y el número del día (empieza en 1 cada día).
  update public.numeracion set
    ultima_venta = ultima_venta + 1,
    ultima_del_dia = case when fecha_dia = public.dia_negocio(now()) then ultima_del_dia + 1 else 1 end,
    fecha_dia = public.dia_negocio(now())
  where id = 1
  returning ultima_venta, ultima_del_dia into v_ticket, v_dia;
  v_tasa := (select tasa_usd from public.configuracion where id = 1);
  for v_item in
    select producto_id, sum(cantidad)::integer as cantidad
    from jsonb_to_recordset(p_items) as x(producto_id bigint, cantidad integer)
    group by producto_id order by producto_id
  loop
    select * into v_producto from public.productos where id = v_item.producto_id;
    update public.productos set cantidad = cantidad - v_item.cantidad where id = v_producto.id;

    insert into public.ventas
      (ticket, numero_dia, producto_id, codigo, nombre, categoria, cantidad, precio_unitario, total, tasa_usd, vendedor, vendedor_id, vendido_por)
    values (
      v_ticket, v_dia, v_producto.id, v_producto.codigo, v_producto.nombre, v_producto.categoria, v_item.cantidad, v_producto.precio_cop,
      v_producto.precio_cop * v_item.cantidad, v_tasa,
      v_vendedor ->> 'nombre', (v_vendedor ->> 'id')::bigint, auth.uid()
    )
    returning * into v_venta;

    insert into public.movimientos
      (producto_id, codigo, nombre, tipo, cantidad, stock_antes, stock_despues, venta_id, usuario, vendedor)
    values (
      v_producto.id, v_producto.codigo, v_producto.nombre, 'venta', v_item.cantidad,
      v_producto.cantidad, v_producto.cantidad - v_item.cantidad, v_venta.id, public.usuario_actual(), v_venta.vendedor
    );

    v_lineas := v_lineas || to_jsonb(v_venta);
    v_total := v_total + v_venta.total;
  end loop;

  return jsonb_build_object('ok', true, 'ticket', v_ticket, 'numero_dia', v_dia, 'vendedor', v_vendedor ->> 'nombre',
                            'total', v_total, 'lineas', v_lineas);
end
$$;

-- Venta de un solo producto (atajo de la anterior).
drop function if exists public.registrar_venta(bigint, integer);
create or replace function public.registrar_venta(p_producto_id bigint, p_cantidad integer, p_codigo_vendedor text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
begin
  r := public.registrar_venta_multiple(
    jsonb_build_array(jsonb_build_object('producto_id', p_producto_id, 'cantidad', p_cantidad)), p_codigo_vendedor);
  if (r ->> 'ok')::boolean then
    return jsonb_build_object('ok', true, 'venta', r -> 'lineas' -> 0);
  end if;
  return r;
end
$$;

-- Anula una venta y devuelve las unidades al inventario.
-- Administrador con la clave del jefe, o el jefe.
drop function if exists public.anular_venta(bigint);
create or replace function public.anular_venta(p_venta_id bigint, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_error text;
  v_venta public.ventas;
  v_stock integer;
begin
  if coalesce(public.rol_actual(), '') not in ('admin', 'jefe') then
    raise exception 'Solo el administrador o el jefe pueden anular ventas.' using errcode = '42501';
  end if;

  v_error := public.autorizar_con_clave_jefe(p_clave_jefe);
  if v_error is not null then
    return jsonb_build_object('ok', false, 'error', v_error, 'campo', 'clave');
  end if;

  select * into v_venta from public.ventas where id = p_venta_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'La venta no existe.');
  end if;
  if v_venta.anulada_en is not null then
    return jsonb_build_object('ok', false, 'error', 'Esta venta ya estaba anulada.');
  end if;
  if exists (select 1 from public.cierres where fecha = public.dia_negocio(v_venta.vendido_en) and reabierto_en is null) then
    return jsonb_build_object('ok', false, 'motivo', 'dia_cerrado',
      'error', 'Esa venta es de un día que ya se cerró. Para anularla, el jefe debe reabrir ese día.');
  end if;

  select cantidad into v_stock from public.productos where id = v_venta.producto_id for update;
  update public.productos set cantidad = cantidad + v_venta.cantidad where id = v_venta.producto_id;

  update public.ventas set anulada_en = now(), anulada_por = auth.uid()
  where id = p_venta_id
  returning * into v_venta;

  insert into public.movimientos
    (producto_id, codigo, nombre, tipo, cantidad, stock_antes, stock_despues, motivo, venta_id, usuario, vendedor)
  values (
    v_venta.producto_id, v_venta.codigo, v_venta.nombre, 'anulacion', v_venta.cantidad,
    v_stock, v_stock + v_venta.cantidad, 'Venta anulada', v_venta.id, public.usuario_actual(), v_venta.vendedor
  );

  return jsonb_build_object('ok', true, 'venta', to_jsonb(v_venta));
end
$$;

-- Entrada o salida de mercancía (administrador con la clave del jefe, o el jefe).
create or replace function public.registrar_movimiento(
  p_producto_id bigint, p_tipo text, p_cantidad integer, p_motivo text, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_error    text;
  v_producto public.productos;
  v_nuevo    integer;
  v_mov      public.movimientos;
begin
  if coalesce(public.rol_actual(), '') not in ('admin', 'jefe') then
    raise exception 'Solo el administrador o el jefe registran entradas y salidas.' using errcode = '42501';
  end if;
  if p_tipo not in ('entrada', 'salida') then
    return jsonb_build_object('ok', false, 'error', 'Tipo de movimiento no válido.');
  end if;
  if p_cantidad is null or p_cantidad < 1 then
    return jsonb_build_object('ok', false, 'error', 'La cantidad debe ser 1 o más.', 'campo', 'cantidad');
  end if;
  if char_length(trim(coalesce(p_motivo, ''))) < 3 then
    return jsonb_build_object('ok', false, 'error', 'Escribe el motivo del movimiento.', 'campo', 'motivo');
  end if;

  v_error := public.autorizar_con_clave_jefe(p_clave_jefe);
  if v_error is not null then
    return jsonb_build_object('ok', false, 'error', v_error, 'campo', 'clave');
  end if;

  select * into v_producto from public.productos where id = p_producto_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'El producto ya no existe.');
  end if;
  v_nuevo := v_producto.cantidad + case when p_tipo = 'entrada' then p_cantidad else -p_cantidad end;
  if v_nuevo < 0 then
    return jsonb_build_object('ok', false, 'campo', 'cantidad',
      'error', format('No se pueden sacar %s: solo hay %s.', p_cantidad, v_producto.cantidad));
  end if;

  update public.productos set cantidad = v_nuevo where id = p_producto_id;

  insert into public.movimientos
    (producto_id, codigo, nombre, tipo, cantidad, stock_antes, stock_despues, motivo, usuario)
  values (
    v_producto.id, v_producto.codigo, v_producto.nombre, p_tipo, p_cantidad,
    v_producto.cantidad, v_nuevo, trim(p_motivo), public.usuario_actual()
  )
  returning * into v_mov;

  return jsonb_build_object('ok', true, 'movimiento', to_jsonb(v_mov));
end
$$;

-- ---------------------------------------------------------------------
-- Productos: crear, editar e importar (todo pasa por estas funciones)
-- ---------------------------------------------------------------------

-- Anota cada precio nuevo o cambiado en historial_precios.
-- La importación marca su origen con set_config('app.origen', 'importacion').
create or replace function public.anotar_cambio_precio()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.precio_cop is distinct from old.precio_cop then
    insert into public.historial_precios (producto_id, codigo, nombre, precio_anterior, precio_nuevo, origen, usuario)
    values (
      new.id, new.codigo, new.nombre,
      case when tg_op = 'UPDATE' then old.precio_cop end,
      new.precio_cop,
      coalesce(nullif(current_setting('app.origen', true), ''),
               case when tg_op = 'INSERT' then 'creacion' else 'edicion' end),
      public.usuario_actual()
    );
  end if;
  return null;
end
$$;

drop trigger if exists productos_historial_precio on public.productos;
create trigger productos_historial_precio
  after insert or update of precio_cop on public.productos
  for each row execute function public.anotar_cambio_precio();

-- Crea (p_id null) o edita un producto. La cantidad no se toca aquí.
-- Si cambia el precio y la configuración lo exige, el administrador necesita
-- la clave del jefe (el jefe no).
drop function if exists public.guardar_producto(bigint, text, text, text, numeric, text);
create or replace function public.guardar_producto(
  p_id bigint, p_codigo text, p_nombre text, p_descripcion text, p_categoria text, p_precio numeric, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := upper(trim(coalesce(p_codigo, '')));
  v_categoria text := public.categoria_valida(p_categoria, p_codigo);
  v_actual public.productos;
  v_prod   public.productos;
  v_error  text;
begin
  if coalesce(public.rol_actual(), '') not in ('admin', 'jefe') then
    raise exception 'Solo el administrador o el jefe modifican productos.' using errcode = '42501';
  end if;
  if v_codigo = '' then
    return jsonb_build_object('ok', false, 'error', 'El código es obligatorio.', 'campo', 'codigo');
  end if;
  if trim(coalesce(p_nombre, '')) = '' then
    return jsonb_build_object('ok', false, 'error', 'El nombre es obligatorio.', 'campo', 'nombre');
  end if;
  if v_categoria is null then
    return jsonb_build_object('ok', false, 'campo', 'categoria',
      'error', format('Elige una categoría válida: %s.', public.texto_categorias()));
  end if;
  if p_precio is null or p_precio < 0 then
    return jsonb_build_object('ok', false, 'error', 'Escribe un precio válido en pesos.', 'campo', 'precio');
  end if;

  if p_id is not null then
    select * into v_actual from public.productos where id = p_id for update;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'El producto ya no existe.');
    end if;
    if v_actual.precio_cop is distinct from p_precio
       and (select precio_requiere_clave from public.configuracion where id = 1) then
      v_error := public.autorizar_con_clave_jefe(p_clave_jefe);
      if v_error is not null then
        return jsonb_build_object('ok', false, 'error', v_error, 'campo', 'clave');
      end if;
    end if;
  end if;

  begin
    if p_id is null then
      insert into public.productos (codigo, nombre, descripcion, categoria, precio_cop)
      values (v_codigo, trim(p_nombre), trim(coalesce(p_descripcion, '')), v_categoria, p_precio)
      returning * into v_prod;
    else
      update public.productos
      set codigo = v_codigo, nombre = trim(p_nombre), descripcion = trim(coalesce(p_descripcion, '')),
          categoria = v_categoria, precio_cop = p_precio
      where id = p_id
      returning * into v_prod;
    end if;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'campo', 'codigo', 'error', format('Ya existe otro producto con el código %s.', v_codigo));
  end;

  return jsonb_build_object('ok', true, 'producto', to_jsonb(v_prod));
end
$$;

-- Importa productos desde Excel en un solo paso (todo o nada).
-- p_filas = [{"fila", "codigo", "nombre", "descripcion", "categoria", "cantidad", "precio"}, ...]
-- Por código: si no existe se crea; si existe se actualiza. Una celda vacía
-- conserva el valor actual. p_modo: 'reemplazar' = la cantidad del archivo es la
-- existencia total; 'sumar' = son unidades que llegan. Cada cambio de cantidad
-- queda como entrada/salida y cada cambio de precio en el historial.
-- El administrador necesita la clave del jefe (una sola vez para todo el archivo).
create or replace function public.importar_productos(p_filas jsonb, p_modo text, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_error      text;
  v_errores    jsonb;
  v_fila       record;
  v_prod       public.productos;
  v_nuevo      integer;
  v_categoria  text;
  v_creados    integer := 0;
  v_cambiados  integer := 0;
  v_iguales    integer := 0;
  v_movs       integer := 0;
begin
  if coalesce(public.rol_actual(), '') not in ('admin', 'jefe') then
    raise exception 'Solo el administrador o el jefe importan productos.' using errcode = '42501';
  end if;
  if p_modo is null or p_modo not in ('reemplazar', 'sumar') then
    return jsonb_build_object('ok', false, 'error', 'Elige qué significa la cantidad del archivo.', 'campo', 'modo');
  end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' or jsonb_array_length(p_filas) = 0 then
    return jsonb_build_object('ok', false, 'error', 'El archivo no tiene productos.');
  end if;
  if jsonb_array_length(p_filas) > 5000 then
    return jsonb_build_object('ok', false, 'error', 'Máximo 5.000 productos por archivo.');
  end if;

  -- Revisar todo el archivo antes de tocar nada.
  select coalesce(jsonb_agg(jsonb_build_object('fila', fila, 'error', error) order by fila), '[]'::jsonb)
  into v_errores
  from (
    select x.fila,
      case
        when upper(trim(coalesce(x.codigo, ''))) = '' then 'Falta el código.'
        when count(*) over (partition by upper(trim(x.codigo))) > 1 then 'Código repetido en el archivo.'
        when x.precio < 0 then 'Precio inválido.'
        when x.cantidad < 0 then 'Cantidad inválida.'
        when trim(coalesce(x.categoria, '')) <> '' and public.categoria_valida(x.categoria, null) is null
          then format('Categoría desconocida: "%s". Usa: %s.', trim(x.categoria), public.texto_categorias())
        when not exists (select 1 from public.productos p where p.codigo = upper(trim(x.codigo)))
             and (trim(coalesce(x.nombre, '')) = '' or x.precio is null)
          then 'Producto nuevo: faltan el nombre o el precio.'
        when public.categoria_valida(x.categoria, x.codigo) is null
             and not exists (select 1 from public.productos p where p.codigo = upper(trim(x.codigo)) and p.categoria is not null)
          then 'Falta la categoría: escríbela, o usa un código que empiece con la letra de una categoría.'
      end as error
    from jsonb_to_recordset(p_filas) as x(fila integer, codigo text, nombre text, descripcion text, categoria text, cantidad integer, precio numeric)
  ) t
  where error is not null;

  if jsonb_array_length(v_errores) > 0 then
    return jsonb_build_object('ok', false, 'errores', v_errores,
      'error', format('Hay %s fila(s) con errores. Corrígelas en el archivo y vuelve a cargarlo.', jsonb_array_length(v_errores)));
  end if;

  v_error := public.autorizar_con_clave_jefe(p_clave_jefe);
  if v_error is not null then
    return jsonb_build_object('ok', false, 'error', v_error, 'campo', 'clave');
  end if;

  perform set_config('app.origen', 'importacion', true);

  for v_fila in
    select upper(trim(x.codigo)) as codigo, nullif(trim(x.nombre), '') as nombre,
           nullif(trim(x.descripcion), '') as descripcion, x.categoria, x.cantidad, x.precio
    from jsonb_to_recordset(p_filas) as x(fila integer, codigo text, nombre text, descripcion text, categoria text, cantidad integer, precio numeric)
    order by 1
  loop
    select * into v_prod from public.productos where codigo = v_fila.codigo for update;

    if not found then
      insert into public.productos (codigo, nombre, descripcion, categoria, precio_cop)
      values (v_fila.codigo, v_fila.nombre, coalesce(v_fila.descripcion, ''), public.categoria_valida(v_fila.categoria, v_fila.codigo), v_fila.precio)
      returning * into v_prod;
      v_creados := v_creados + 1;
      v_nuevo := coalesce(v_fila.cantidad, 0);
    else
      -- Categoría: la escrita; si no hay y el producto no tenía, la de la letra del código.
      v_categoria := case
        when nullif(trim(coalesce(v_fila.categoria, '')), '') is not null then public.categoria_valida(v_fila.categoria, null)
        when v_prod.categoria is null then public.categoria_valida(null, v_fila.codigo)
      end;
      v_nuevo := case
        when v_fila.cantidad is null then v_prod.cantidad
        when p_modo = 'sumar' then v_prod.cantidad + v_fila.cantidad
        else v_fila.cantidad
      end;
      if (v_fila.nombre is not null and v_fila.nombre is distinct from v_prod.nombre)
         or (v_fila.descripcion is not null and v_fila.descripcion is distinct from v_prod.descripcion)
         or (v_fila.precio is not null and v_fila.precio is distinct from v_prod.precio_cop)
         or (v_categoria is not null and v_categoria is distinct from v_prod.categoria)
         or v_nuevo <> v_prod.cantidad then
        v_cambiados := v_cambiados + 1;
      else
        v_iguales := v_iguales + 1;
      end if;
      update public.productos
      set nombre = coalesce(v_fila.nombre, nombre),
          descripcion = coalesce(v_fila.descripcion, descripcion),
          categoria = coalesce(v_categoria, categoria),
          precio_cop = coalesce(v_fila.precio, precio_cop)
      where id = v_prod.id;
    end if;

    if v_nuevo <> v_prod.cantidad then
      update public.productos set cantidad = v_nuevo where id = v_prod.id;
      insert into public.movimientos
        (producto_id, codigo, nombre, tipo, cantidad, stock_antes, stock_despues, motivo, usuario)
      values (
        v_prod.id, v_prod.codigo, coalesce(v_fila.nombre, v_prod.nombre),
        case when v_nuevo > v_prod.cantidad then 'entrada' else 'salida' end,
        abs(v_nuevo - v_prod.cantidad), v_prod.cantidad, v_nuevo,
        case when p_modo = 'sumar' then 'Importación desde Excel' else 'Importación desde Excel (ajuste de existencia)' end,
        public.usuario_actual()
      );
      v_movs := v_movs + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'creados', v_creados, 'actualizados', v_cambiados,
                            'sin_cambios', v_iguales, 'movimientos', v_movs);
end
$$;

-- ---------------------------------------------------------------------
-- Precios en bloque
-- ---------------------------------------------------------------------

-- Precio después de subir o bajar por porcentaje o por monto, redondeado al
-- múltiplo indicado (1 = sin redondeo; 100 = a la centena más cercana).
create or replace function public.precio_ajustado(
  p_precio numeric, p_operacion text, p_tipo text, p_valor numeric, p_redondeo integer)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select round(
    (case when p_tipo = 'porcentaje'
          then p_precio * (1 + (case when p_operacion = 'subir' then 1 else -1 end) * p_valor / 100)
          else p_precio + (case when p_operacion = 'subir' then 1 else -1 end) * p_valor end)
    / greatest(coalesce(p_redondeo, 1), 1)
  ) * greatest(coalesce(p_redondeo, 1), 1)
$$;

-- Sube o baja precios en bloque: una categoría (o todos si p_categoria es null).
-- Solo toca productos con precio mayor que 0. Con p_simular = true no cambia
-- nada: devuelve cómo quedaría cada precio (la vista previa).
-- Sigue la misma regla que un cambio individual: si la configuración lo exige,
-- el administrador necesita la clave del jefe. Todo queda en el historial.
create or replace function public.cambiar_precios_masivo(
  p_categoria text, p_operacion text, p_tipo text, p_valor numeric, p_redondeo integer,
  p_simular boolean, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_categoria text := nullif(trim(coalesce(p_categoria, '')), '');
  v_filas     jsonb;
  v_total     integer;
  v_cambian   integer;
  v_en_cero   integer;
  v_error     text;
begin
  if coalesce(public.rol_actual(), '') not in ('admin', 'jefe') then
    raise exception 'Solo el administrador o el jefe cambian precios.' using errcode = '42501';
  end if;
  if p_operacion is null or p_operacion not in ('subir', 'bajar') or p_tipo is null or p_tipo not in ('porcentaje', 'monto') then
    return jsonb_build_object('ok', false, 'error', 'Elige si se sube o se baja, y si es por porcentaje o por monto.');
  end if;
  if p_valor is null or p_valor <= 0 then
    return jsonb_build_object('ok', false, 'error', 'Escribe un valor mayor que cero.', 'campo', 'valor');
  end if;
  if p_tipo = 'porcentaje' and p_operacion = 'bajar' and p_valor >= 100 then
    return jsonb_build_object('ok', false, 'error', 'No se puede bajar 100 % o más.', 'campo', 'valor');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'codigo', codigo, 'nombre', nombre, 'categoria', categoria,
                                               'antes', precio_cop, 'despues', nuevo) order by nombre), '[]'::jsonb),
         count(*), count(*) filter (where nuevo <> precio_cop), count(*) filter (where nuevo <= 0)
  into v_filas, v_total, v_cambian, v_en_cero
  from (
    select id, codigo, nombre, categoria, precio_cop,
           public.precio_ajustado(precio_cop, p_operacion, p_tipo, p_valor, p_redondeo) as nuevo
    from public.productos
    where precio_cop > 0 and (v_categoria is null or categoria = v_categoria)
  ) t;

  if v_total = 0 then
    return jsonb_build_object('ok', false, 'error', 'No hay productos con precio en esa selección.');
  end if;
  if v_en_cero > 0 then
    return jsonb_build_object('ok', false, 'campo', 'valor', 'filas', v_filas,
      'error', format('%s producto(s) quedarían en $0 o menos. Usa un valor menor.', v_en_cero));
  end if;
  if p_simular then
    return jsonb_build_object('ok', true, 'simulado', true, 'productos', v_total, 'cambian', v_cambian, 'filas', v_filas);
  end if;

  if (select precio_requiere_clave from public.configuracion where id = 1) then
    v_error := public.autorizar_con_clave_jefe(p_clave_jefe);
    if v_error is not null then
      return jsonb_build_object('ok', false, 'error', v_error, 'campo', 'clave');
    end if;
  end if;

  perform set_config('app.origen', 'masivo', true);
  update public.productos
  set precio_cop = public.precio_ajustado(precio_cop, p_operacion, p_tipo, p_valor, p_redondeo)
  where precio_cop > 0 and (v_categoria is null or categoria = v_categoria)
    and public.precio_ajustado(precio_cop, p_operacion, p_tipo, p_valor, p_redondeo) <> precio_cop;
  get diagnostics v_cambian = row_count;

  return jsonb_build_object('ok', true, 'productos', v_total, 'cambiados', v_cambian);
end
$$;

-- ---------------------------------------------------------------------
-- Cierre del día (manual, con el código de una persona autorizada)
-- ---------------------------------------------------------------------

-- ¿Está cerrado el día? Lo puede consultar cualquier usuario con sesión.
create or replace function public.estado_dia(p_fecha date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fecha  date := coalesce(p_fecha, public.dia_negocio(now()));
  v_cierre public.cierres;
begin
  if public.rol_actual() is null then
    raise exception 'No tienes permiso.' using errcode = '42501';
  end if;
  select * into v_cierre from public.cierres where fecha = v_fecha and reabierto_en is null;
  return jsonb_build_object(
    'fecha', v_fecha,
    'hoy', public.dia_negocio(now()),
    'cerrado', found,
    'cerrado_por', v_cierre.cerrado_por,
    'cerrado_en', v_cierre.cerrado_en
  );
end
$$;

create or replace function public.cerrar_dia(p_fecha date, p_codigo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fecha   date := coalesce(p_fecha, public.dia_negocio(now()));
  v_persona jsonb;
  v_totales jsonb;
  v_cierre  public.cierres;
begin
  if public.rol_actual() is null then
    raise exception 'No tienes permiso.' using errcode = '42501';
  end if;
  if v_fecha > public.dia_negocio(now()) then
    return jsonb_build_object('ok', false, 'error', 'No se puede cerrar un día que todavía no ha llegado.');
  end if;
  if exists (select 1 from public.cierres where fecha = v_fecha and reabierto_en is null) then
    return jsonb_build_object('ok', false, 'error', 'Ese día ya está cerrado.');
  end if;

  v_persona := public.identificar_vendedor(p_codigo);
  if v_persona ? 'error' then
    return jsonb_build_object('ok', false, 'error', v_persona ->> 'error', 'campo', 'codigo');
  end if;
  if not (select puede_cerrar from public.vendedores where id = (v_persona ->> 'id')::bigint) then
    return jsonb_build_object('ok', false, 'campo', 'codigo',
      'error', format('%s no tiene permiso para hacer el cierre. El jefe lo puede autorizar en Configuración.', v_persona ->> 'nombre'));
  end if;

  -- Foto de los totales del día en el momento del cierre.
  select jsonb_build_object(
    'total',        coalesce(sum(total) filter (where anulada_en is null), 0),
    'total_usd',    round(coalesce(sum(total / tasa_usd) filter (where anulada_en is null and tasa_usd > 0), 0), 2),
    'ventas',       count(distinct ticket) filter (where anulada_en is null),
    'unidades',     coalesce(sum(cantidad) filter (where anulada_en is null), 0),
    'lineas_anuladas', count(*) filter (where anulada_en is not null),
    'primer_consecutivo', min(ticket),
    'ultimo_consecutivo', max(ticket),
    'por_vendedor', coalesce((
      select jsonb_agg(jsonb_build_object('vendedor', vendedor, 'ventas', n, 'total', t) order by t desc)
      from (select vendedor, count(distinct ticket) n, sum(total) t from public.ventas
            where public.dia_negocio(vendido_en) = v_fecha and anulada_en is null group by vendedor) x
    ), '[]'::jsonb)
  )
  into v_totales
  from public.ventas
  where public.dia_negocio(vendido_en) = v_fecha;

  insert into public.cierres (fecha, cerrado_por, usuario, totales)
  values (v_fecha, v_persona ->> 'nombre', public.usuario_actual(), v_totales)
  returning * into v_cierre;

  return jsonb_build_object('ok', true, 'cierre', to_jsonb(v_cierre));
end
$$;

-- ---------------------------------------------------------------------
-- Tickets del día (pestaña Administración de atención al público)
-- ---------------------------------------------------------------------

-- Tickets de hoy SIN dinero: número, hora, vendedor y productos con cantidad.
create or replace function public.tickets_del_dia()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.rol_actual() is null then
    raise exception 'No tienes permiso.' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(t order by numero desc), '[]'::jsonb)
    from (
      select ticket as numero, jsonb_build_object(
        'ticket', ticket,
        'numero_dia', max(numero_dia),
        'vendido_en', min(vendido_en),
        'vendedor', max(vendedor),
        'anulado', bool_and(anulada_en is not null),
        'lineas_anuladas', count(*) filter (where anulada_en is not null),
        'lineas', jsonb_agg(jsonb_build_object('codigo', codigo, 'nombre', nombre, 'cantidad', cantidad,
                                               'anulada', anulada_en is not null) order by id)
      ) as t
      from public.ventas
      where public.dia_negocio(vendido_en) = public.dia_negocio(now())
      group by ticket
    ) x
  );
end
$$;

-- Anula un ticket completo (todas sus líneas que sigan vendidas) y devuelve
-- las unidades al inventario. Necesita la clave del jefe (el jefe no).
-- Atención al público solo puede anular tickets de hoy; nunca de un día cerrado.
create or replace function public.anular_ticket(p_ticket bigint, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_error text;
  v_dia   date;
  v_linea public.ventas;
  v_stock integer;
  v_n     integer := 0;
begin
  if public.rol_actual() is null then
    raise exception 'No tienes permiso.' using errcode = '42501';
  end if;

  v_error := public.autorizar_con_clave_jefe(p_clave_jefe);
  if v_error is not null then
    return jsonb_build_object('ok', false, 'error', v_error, 'campo', 'clave');
  end if;

  select public.dia_negocio(min(vendido_en)) into v_dia from public.ventas where ticket = p_ticket;
  if v_dia is null then
    return jsonb_build_object('ok', false, 'error', 'Ese ticket no existe.');
  end if;
  if public.rol_actual() = 'atencion' and v_dia <> public.dia_negocio(now()) then
    return jsonb_build_object('ok', false, 'error', 'Solo se pueden anular tickets de hoy.');
  end if;
  if exists (select 1 from public.cierres where fecha = v_dia and reabierto_en is null) then
    return jsonb_build_object('ok', false, 'motivo', 'dia_cerrado',
      'error', 'Ese ticket es de un día que ya se cerró. Para anularlo, el jefe debe reabrir ese día.');
  end if;

  for v_linea in
    select * from public.ventas where ticket = p_ticket and anulada_en is null order by producto_id for update
  loop
    select cantidad into v_stock from public.productos where id = v_linea.producto_id for update;
    update public.productos set cantidad = cantidad + v_linea.cantidad where id = v_linea.producto_id;
    update public.ventas set anulada_en = now(), anulada_por = auth.uid() where id = v_linea.id;
    insert into public.movimientos
      (producto_id, codigo, nombre, tipo, cantidad, stock_antes, stock_despues, motivo, venta_id, usuario, vendedor)
    values (
      v_linea.producto_id, v_linea.codigo, v_linea.nombre, 'anulacion', v_linea.cantidad,
      v_stock, v_stock + v_linea.cantidad, format('Ticket %s anulado', p_ticket), v_linea.id, public.usuario_actual(), v_linea.vendedor
    );
    v_n := v_n + 1;
  end loop;

  if v_n = 0 then
    return jsonb_build_object('ok', false, 'error', 'Ese ticket ya estaba anulado.');
  end if;
  return jsonb_build_object('ok', true, 'lineas', v_n);
end
$$;

-- Reabrir un día cerrado (solo el jefe): se puede volver a vender o anular.
create or replace function public.reabrir_dia(p_fecha date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.solo_jefe();
  update public.cierres set reabierto_por = public.usuario_actual(), reabierto_en = now()
  where fecha = p_fecha and reabierto_en is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Ese día no está cerrado.');
  end if;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------
-- Configuración: solo el usuario con rol "jefe"
-- ---------------------------------------------------------------------

-- Versión anterior (panel abierto con la clave): reemplazada por el rol jefe.
drop function if exists public.jefe_abrir(text);
drop function if exists public.jefe_guardar_vendedor(text, bigint, text, text, boolean);
drop function if exists public.jefe_cambiar_clave(text, text);

-- Lista de vendedores (nunca se devuelven los códigos).
create or replace function public.lista_vendedores()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'activo', activo, 'puede_cerrar', puede_cerrar)
                            order by activo desc, nombre), '[]'::jsonb)
  from public.vendedores
$$;

create or replace function public.solo_jefe()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.rol_actual() is distinct from 'jefe' then
    raise exception 'Solo el jefe puede usar la configuración.' using errcode = '42501';
  end if;
end
$$;

create or replace function public.config_estado()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.solo_jefe();
  return jsonb_build_object(
    'ok', true,
    'vendedores', public.lista_vendedores(),
    'clave_definida', (select clave_jefe_hash is not null from public.seguridad where id = 1),
    'precio_requiere_clave', (select precio_requiere_clave from public.configuracion where id = 1),
    'categorias', (select coalesce(jsonb_agg(jsonb_build_object('prefijo', prefijo, 'nombre', nombre) order by nombre), '[]'::jsonb) from public.categorias)
  );
end
$$;

-- Crea (p_id null) o modifica un vendedor. p_codigo vacío = conservar el actual.
drop function if exists public.config_guardar_vendedor(bigint, text, text, boolean);
create or replace function public.config_guardar_vendedor(
  p_id bigint, p_nombre text, p_codigo text, p_activo boolean, p_puede_cerrar boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := nullif(trim(coalesce(p_codigo, '')), '');
begin
  perform public.solo_jefe();
  if char_length(trim(coalesce(p_nombre, ''))) = 0 then
    return jsonb_build_object('ok', false, 'error', 'Escribe el nombre del vendedor.', 'campo', 'nombre');
  end if;
  if p_id is null and v_codigo is null then
    return jsonb_build_object('ok', false, 'error', 'Asigna un código al vendedor.', 'campo', 'codigo');
  end if;
  if v_codigo is not null then
    if char_length(v_codigo) < 4 then
      return jsonb_build_object('ok', false, 'error', 'El código debe tener al menos 4 caracteres.', 'campo', 'codigo');
    end if;
    if public.codigo_vendedor_en_uso(v_codigo, p_id) then
      return jsonb_build_object('ok', false, 'error', 'Ese código ya lo tiene otro vendedor. Elige otro.', 'campo', 'codigo');
    end if;
  end if;

  if p_id is null then
    insert into public.vendedores (nombre, codigo_hash, activo, puede_cerrar)
    values (trim(p_nombre), extensions.crypt(v_codigo, extensions.gen_salt('bf', 8)), coalesce(p_activo, true), coalesce(p_puede_cerrar, false));
  else
    update public.vendedores set
      nombre = trim(p_nombre),
      activo = coalesce(p_activo, activo),
      puede_cerrar = coalesce(p_puede_cerrar, puede_cerrar),
      codigo_hash = case when v_codigo is null then codigo_hash
                         else extensions.crypt(v_codigo, extensions.gen_salt('bf', 8)) end,
      actualizado_en = now()
    where id = p_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'El vendedor no existe.');
    end if;
  end if;

  return jsonb_build_object('ok', true, 'vendedores', public.lista_vendedores());
end
$$;

-- ¿Cambiar un precio requiere la clave del jefe?
create or replace function public.config_precio_requiere_clave(p_valor boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.solo_jefe();
  update public.configuracion set precio_requiere_clave = coalesce(p_valor, true) where id = 1;
  return jsonb_build_object('ok', true, 'precio_requiere_clave', coalesce(p_valor, true));
end
$$;

-- Crea (p_prefijo_anterior null) o modifica una categoría. Si cambia el nombre,
-- los productos de esa categoría se actualizan solos.
create or replace function public.config_guardar_categoria(p_prefijo_anterior text, p_prefijo text, p_nombre text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefijo text := upper(trim(coalesce(p_prefijo, '')));
  v_nombre  text := regexp_replace(trim(coalesce(p_nombre, '')), '\s+', ' ', 'g');
begin
  perform public.solo_jefe();
  if v_prefijo !~ '^[A-Z]{1,5}$' then
    return jsonb_build_object('ok', false, 'campo', 'prefijo', 'error', 'La letra debe ser de 1 a 5 letras, sin números ni símbolos (ej: L).');
  end if;
  if v_nombre = '' then
    return jsonb_build_object('ok', false, 'campo', 'nombre', 'error', 'Escribe el nombre de la categoría.');
  end if;
  begin
    if p_prefijo_anterior is null then
      insert into public.categorias (prefijo, nombre) values (v_prefijo, v_nombre);
    else
      update public.categorias set prefijo = v_prefijo, nombre = v_nombre where prefijo = upper(p_prefijo_anterior);
      if not found then
        return jsonb_build_object('ok', false, 'error', 'Esa categoría ya no existe.');
      end if;
    end if;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'Ya existe una categoría con esa letra o con ese nombre.');
  end;
  return jsonb_build_object('ok', true, 'categorias',
    (select coalesce(jsonb_agg(jsonb_build_object('prefijo', prefijo, 'nombre', nombre) order by nombre), '[]'::jsonb) from public.categorias));
end
$$;

-- Define o cambia la clave del jefe (la que autoriza al administrador).
-- El jefe ya inició sesión con su usuario, así que no se le pide la anterior.
create or replace function public.config_definir_clave_jefe(p_clave_nueva text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.solo_jefe();
  if char_length(coalesce(p_clave_nueva, '')) < 6 then
    return jsonb_build_object('ok', false, 'error', 'La clave debe tener al menos 6 caracteres.', 'campo', 'nueva');
  end if;
  update public.seguridad
  set clave_jefe_hash = extensions.crypt(p_clave_nueva, extensions.gen_salt('bf', 10)),
      intentos_jefe = 0, jefe_bloqueado_hasta = null
  where id = 1;
  return jsonb_build_object('ok', true);
end
$$;

-- ---------------------------------------------------------------------
-- Privilegios: nada para anónimos; lo mínimo para usuarios con sesión
-- ---------------------------------------------------------------------

revoke all on public.categorias from anon, authenticated;
revoke all on public.perfiles, public.productos, public.configuracion, public.ventas,
              public.seguridad, public.vendedores, public.movimientos, public.historial_precios,
              public.numeracion, public.cierres from anon, authenticated;

grant select on public.perfiles to authenticated;
grant select on public.categorias to authenticated;
-- Los productos no se escriben directamente: se crean y editan con guardar_producto
-- e importar_productos, y la cantidad solo cambia con ventas, anulaciones, entradas
-- y salidas. Así cada precio queda en el historial y se respeta la clave del jefe.
grant select, delete on public.productos to authenticated;
grant select on public.configuracion to authenticated;
grant update (tasa_usd) on public.configuracion to authenticated;
grant select on public.ventas, public.movimientos, public.historial_precios, public.cierres to authenticated;
-- seguridad y vendedores: sin ningún permiso (solo las funciones las usan).

-- Funciones internas: nadie las llama directamente.
revoke execute on function public.usuario_actual() from public, anon, authenticated;
revoke execute on function public.verificar_clave_jefe(text) from public, anon, authenticated;
revoke execute on function public.identificar_vendedor(text) from public, anon, authenticated;
revoke execute on function public.codigo_vendedor_en_uso(text, bigint) from public, anon, authenticated;
revoke execute on function public.lista_vendedores() from public, anon, authenticated;
revoke execute on function public.autorizar_con_clave_jefe(text) from public, anon, authenticated;
revoke execute on function public.solo_jefe() from public, anon, authenticated;
revoke execute on function public.anotar_cambio_precio() from public, anon, authenticated;
revoke execute on function public.categoria_valida(text, text) from public, anon, authenticated;
revoke execute on function public.prefijo_codigo(text) from public, anon, authenticated;
revoke execute on function public.texto_categorias() from public, anon, authenticated;
revoke execute on function public.precio_ajustado(numeric, text, text, numeric, integer) from public, anon, authenticated;
revoke execute on function public.dia_negocio(timestamptz) from public, anon, authenticated;

-- Funciones que usa la app (solo con sesión iniciada; cada una revisa el rol).
revoke execute on function public.rol_actual() from public, anon;
revoke execute on function public.buscar_productos(text, text) from public, anon;
revoke execute on function public.lista_categorias() from public, anon;
revoke execute on function public.cambiar_precios_masivo(text, text, text, numeric, integer, boolean, text) from public, anon;
revoke execute on function public.estado_dia(date) from public, anon;
revoke execute on function public.cerrar_dia(date, text) from public, anon;
revoke execute on function public.reabrir_dia(date) from public, anon;
revoke execute on function public.tickets_del_dia() from public, anon;
revoke execute on function public.anular_ticket(bigint, text) from public, anon;
revoke execute on function public.registrar_venta(bigint, integer, text) from public, anon;
revoke execute on function public.anular_venta(bigint, text) from public, anon;
revoke execute on function public.registrar_movimiento(bigint, text, integer, text, text) from public, anon;
revoke execute on function public.config_estado() from public, anon;
revoke execute on function public.config_guardar_vendedor(bigint, text, text, boolean, boolean) from public, anon;
revoke execute on function public.config_definir_clave_jefe(text) from public, anon;
revoke execute on function public.config_guardar_categoria(text, text, text) from public, anon;
revoke execute on function public.config_precio_requiere_clave(boolean) from public, anon;
revoke execute on function public.registrar_venta_multiple(jsonb, text) from public, anon;
revoke execute on function public.guardar_producto(bigint, text, text, text, text, numeric, text) from public, anon;
revoke execute on function public.importar_productos(jsonb, text, text) from public, anon;
grant execute on function public.rol_actual() to authenticated;
grant execute on function public.buscar_productos(text, text) to authenticated;
grant execute on function public.lista_categorias() to authenticated;
grant execute on function public.cambiar_precios_masivo(text, text, text, numeric, integer, boolean, text) to authenticated;
grant execute on function public.estado_dia(date) to authenticated;
grant execute on function public.cerrar_dia(date, text) to authenticated;
grant execute on function public.reabrir_dia(date) to authenticated;
grant execute on function public.tickets_del_dia() to authenticated;
grant execute on function public.anular_ticket(bigint, text) to authenticated;
grant execute on function public.registrar_venta(bigint, integer, text) to authenticated;
grant execute on function public.anular_venta(bigint, text) to authenticated;
grant execute on function public.registrar_movimiento(bigint, text, integer, text, text) to authenticated;
grant execute on function public.config_estado() to authenticated;
grant execute on function public.config_guardar_vendedor(bigint, text, text, boolean, boolean) to authenticated;
grant execute on function public.config_definir_clave_jefe(text) to authenticated;
grant execute on function public.config_guardar_categoria(text, text, text) to authenticated;
grant execute on function public.config_precio_requiere_clave(boolean) to authenticated;
grant execute on function public.registrar_venta_multiple(jsonb, text) to authenticated;
grant execute on function public.guardar_producto(bigint, text, text, text, text, numeric, text) to authenticated;
grant execute on function public.importar_productos(jsonb, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.perfiles      enable row level security;
alter table public.productos     enable row level security;
alter table public.configuracion enable row level security;
alter table public.ventas        enable row level security;
alter table public.movimientos   enable row level security;
alter table public.historial_precios enable row level security;
alter table public.numeracion    enable row level security;
alter table public.cierres       enable row level security;
alter table public.categorias    enable row level security;   -- sin políticas: solo la usa registrar_venta_multiple
alter table public.seguridad     enable row level security;   -- sin políticas: nadie la lee
alter table public.vendedores    enable row level security;   -- sin políticas: nadie la lee

-- Ventas y movimientos: solo el administrador y el jefe los ven. Nadie los crea, cambia
-- ni borra directamente: se usan las funciones de arriba.
drop policy if exists "ver ventas" on public.ventas;
create policy "ver ventas" on public.ventas
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe'));

drop policy if exists "ver categorias" on public.categorias;
create policy "ver categorias" on public.categorias
  for select to authenticated
  using ((select public.rol_actual()) is not null);

drop policy if exists "ver cierres" on public.cierres;
create policy "ver cierres" on public.cierres
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe'));

drop policy if exists "ver historial de precios" on public.historial_precios;
create policy "ver historial de precios" on public.historial_precios
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe'));

drop policy if exists "ver movimientos" on public.movimientos;
create policy "ver movimientos" on public.movimientos
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe'));

-- Perfiles: cada usuario solo ve el suyo. Los roles se asignan por SQL.
drop policy if exists "ver mi perfil" on public.perfiles;
create policy "ver mi perfil" on public.perfiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Productos: todos ven; administrador y jefe crean, editan y eliminan.
drop policy if exists "ver productos" on public.productos;
create policy "ver productos" on public.productos
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'atencion', 'jefe'));

drop policy if exists "crear productos" on public.productos;
create policy "crear productos" on public.productos
  for insert to authenticated
  with check ((select public.rol_actual()) in ('admin', 'jefe'));

drop policy if exists "editar productos" on public.productos;
create policy "editar productos" on public.productos
  for update to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe'))
  with check ((select public.rol_actual()) in ('admin', 'jefe'));

-- Solo se elimina un producto sin unidades (si tiene, primero va una salida).
drop policy if exists "eliminar productos" on public.productos;
create policy "eliminar productos" on public.productos
  for delete to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe') and cantidad = 0);

-- Tasa de cambio: todos ven; administrador y jefe la cambian.
drop policy if exists "ver configuracion" on public.configuracion;
create policy "ver configuracion" on public.configuracion
  for select to authenticated
  using ((select public.rol_actual()) in ('admin', 'atencion', 'jefe'));

drop policy if exists "editar tasa" on public.configuracion;
create policy "editar tasa" on public.configuracion
  for update to authenticated
  using ((select public.rol_actual()) in ('admin', 'jefe'))
  with check ((select public.rol_actual()) in ('admin', 'jefe'));
