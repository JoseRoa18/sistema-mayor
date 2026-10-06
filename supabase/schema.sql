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

alter table public.ventas add column if not exists vendedor_id bigint references public.vendedores (id) on delete set null;

-- Número de venta: agrupa los productos que se cobraron juntos (carrito).
create sequence if not exists public.ventas_ticket_seq;
alter table public.ventas add column if not exists ticket bigint;
create index if not exists ventas_ticket on public.ventas (ticket);

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

-- Búsqueda por código, nombre o descripción, sin importar mayúsculas ni
-- tildes ("cafe" encuentra "Café"). Cada palabra escrita debe aparecer.
-- Primero salen los productos cuyo código es exactamente el buscado,
-- luego los que empiezan por él, y después el resto por nombre.
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
      and strpos(unaccent(lower(coalesce(p.codigo, '') || ' ' || p.nombre || ' ' || p.descripcion)), palabra) = 0
  )
  order by
    coalesce(p.codigo = upper(trim(q)), false) desc,
    coalesce(trim(q) <> '' and starts_with(p.codigo, upper(trim(q))), false) desc,
    p.nombre
  limit 300
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
  v_tasa     numeric;
  v_lineas   jsonb := '[]'::jsonb;
  v_total    numeric := 0;
begin
  if public.rol_actual() is null then
    raise exception 'No tienes permiso para registrar ventas.' using errcode = '42501';
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

  -- 2) Registrar cada línea con el mismo número de venta.
  v_ticket := nextval('public.ventas_ticket_seq');
  v_tasa := (select tasa_usd from public.configuracion where id = 1);
  for v_item in
    select producto_id, sum(cantidad)::integer as cantidad
    from jsonb_to_recordset(p_items) as x(producto_id bigint, cantidad integer)
    group by producto_id order by producto_id
  loop
    select * into v_producto from public.productos where id = v_item.producto_id;
    update public.productos set cantidad = cantidad - v_item.cantidad where id = v_producto.id;

    insert into public.ventas
      (ticket, producto_id, codigo, nombre, cantidad, precio_unitario, total, tasa_usd, vendedor, vendedor_id, vendido_por)
    values (
      v_ticket, v_producto.id, v_producto.codigo, v_producto.nombre, v_item.cantidad, v_producto.precio_cop,
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

  return jsonb_build_object('ok', true, 'ticket', v_ticket, 'vendedor', v_vendedor ->> 'nombre',
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
create or replace function public.guardar_producto(
  p_id bigint, p_codigo text, p_nombre text, p_descripcion text, p_precio numeric, p_clave_jefe text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_codigo text := upper(trim(coalesce(p_codigo, '')));
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
      insert into public.productos (codigo, nombre, descripcion, precio_cop)
      values (v_codigo, trim(p_nombre), trim(coalesce(p_descripcion, '')), p_precio)
      returning * into v_prod;
    else
      update public.productos
      set codigo = v_codigo, nombre = trim(p_nombre), descripcion = trim(coalesce(p_descripcion, '')), precio_cop = p_precio
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
-- p_filas = [{"fila", "codigo", "nombre", "descripcion", "cantidad", "precio"}, ...]
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
        when not exists (select 1 from public.productos p where p.codigo = upper(trim(x.codigo)))
             and (trim(coalesce(x.nombre, '')) = '' or x.precio is null)
          then 'Producto nuevo: faltan el nombre o el precio.'
      end as error
    from jsonb_to_recordset(p_filas) as x(fila integer, codigo text, nombre text, descripcion text, cantidad integer, precio numeric)
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
           nullif(trim(x.descripcion), '') as descripcion, x.cantidad, x.precio
    from jsonb_to_recordset(p_filas) as x(fila integer, codigo text, nombre text, descripcion text, cantidad integer, precio numeric)
    order by 1
  loop
    select * into v_prod from public.productos where codigo = v_fila.codigo for update;

    if not found then
      insert into public.productos (codigo, nombre, descripcion, precio_cop)
      values (v_fila.codigo, v_fila.nombre, coalesce(v_fila.descripcion, ''), v_fila.precio)
      returning * into v_prod;
      v_creados := v_creados + 1;
      v_nuevo := coalesce(v_fila.cantidad, 0);
    else
      v_nuevo := case
        when v_fila.cantidad is null then v_prod.cantidad
        when p_modo = 'sumar' then v_prod.cantidad + v_fila.cantidad
        else v_fila.cantidad
      end;
      if (v_fila.nombre is not null and v_fila.nombre is distinct from v_prod.nombre)
         or (v_fila.descripcion is not null and v_fila.descripcion is distinct from v_prod.descripcion)
         or (v_fila.precio is not null and v_fila.precio is distinct from v_prod.precio_cop)
         or v_nuevo <> v_prod.cantidad then
        v_cambiados := v_cambiados + 1;
      else
        v_iguales := v_iguales + 1;
      end if;
      update public.productos
      set nombre = coalesce(v_fila.nombre, nombre),
          descripcion = coalesce(v_fila.descripcion, descripcion),
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
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'activo', activo)
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
    'precio_requiere_clave', (select precio_requiere_clave from public.configuracion where id = 1)
  );
end
$$;

-- Crea (p_id null) o modifica un vendedor. p_codigo vacío = conservar el actual.
create or replace function public.config_guardar_vendedor(p_id bigint, p_nombre text, p_codigo text, p_activo boolean)
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
    insert into public.vendedores (nombre, codigo_hash, activo)
    values (trim(p_nombre), extensions.crypt(v_codigo, extensions.gen_salt('bf', 8)), coalesce(p_activo, true));
  else
    update public.vendedores set
      nombre = trim(p_nombre),
      activo = coalesce(p_activo, activo),
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

revoke all on public.perfiles, public.productos, public.configuracion, public.ventas,
              public.seguridad, public.vendedores, public.movimientos, public.historial_precios from anon, authenticated;
revoke all on sequence public.ventas_ticket_seq from anon, authenticated;

grant select on public.perfiles to authenticated;
-- Los productos no se escriben directamente: se crean y editan con guardar_producto
-- e importar_productos, y la cantidad solo cambia con ventas, anulaciones, entradas
-- y salidas. Así cada precio queda en el historial y se respeta la clave del jefe.
grant select, delete on public.productos to authenticated;
grant select on public.configuracion to authenticated;
grant update (tasa_usd) on public.configuracion to authenticated;
grant select on public.ventas, public.movimientos, public.historial_precios to authenticated;
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

-- Funciones que usa la app (solo con sesión iniciada; cada una revisa el rol).
revoke execute on function public.rol_actual() from public, anon;
revoke execute on function public.buscar_productos(text) from public, anon;
revoke execute on function public.registrar_venta(bigint, integer, text) from public, anon;
revoke execute on function public.anular_venta(bigint, text) from public, anon;
revoke execute on function public.registrar_movimiento(bigint, text, integer, text, text) from public, anon;
revoke execute on function public.config_estado() from public, anon;
revoke execute on function public.config_guardar_vendedor(bigint, text, text, boolean) from public, anon;
revoke execute on function public.config_definir_clave_jefe(text) from public, anon;
revoke execute on function public.config_precio_requiere_clave(boolean) from public, anon;
revoke execute on function public.registrar_venta_multiple(jsonb, text) from public, anon;
revoke execute on function public.guardar_producto(bigint, text, text, text, numeric, text) from public, anon;
revoke execute on function public.importar_productos(jsonb, text, text) from public, anon;
grant execute on function public.rol_actual() to authenticated;
grant execute on function public.buscar_productos(text) to authenticated;
grant execute on function public.registrar_venta(bigint, integer, text) to authenticated;
grant execute on function public.anular_venta(bigint, text) to authenticated;
grant execute on function public.registrar_movimiento(bigint, text, integer, text, text) to authenticated;
grant execute on function public.config_estado() to authenticated;
grant execute on function public.config_guardar_vendedor(bigint, text, text, boolean) to authenticated;
grant execute on function public.config_definir_clave_jefe(text) to authenticated;
grant execute on function public.config_precio_requiere_clave(boolean) to authenticated;
grant execute on function public.registrar_venta_multiple(jsonb, text) to authenticated;
grant execute on function public.guardar_producto(bigint, text, text, text, numeric, text) to authenticated;
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
alter table public.seguridad     enable row level security;   -- sin políticas: nadie la lee
alter table public.vendedores    enable row level security;   -- sin políticas: nadie la lee

-- Ventas y movimientos: solo el administrador y el jefe los ven. Nadie los crea, cambia
-- ni borra directamente: se usan las funciones de arriba.
drop policy if exists "ver ventas" on public.ventas;
create policy "ver ventas" on public.ventas
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
