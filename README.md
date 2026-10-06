# Sistema Mayor · Inventario

Sistema sencillo para consultar y administrar productos, con inicio de sesión y permisos por rol.
Precios en **pesos colombianos (COP)** con su equivalente en **dólares (USD)** según la tasa que defina el administrador.

## Roles

| Puede…                                             | Jefe (`roa`)  | Administrador | Atención al público |
|----------------------------------------------------|:-------------:|:-------------:|:-------------------:|
| Buscar productos por código o nombre               | ✅            | ✅            | ✅                  |
| Ver código, nombre, descripción, cantidad, precio COP y USD | ✅   | ✅            | ✅                  |
| Vender con carrito (con el **código del vendedor**) | ✅            | ✅            | ✅                  |
| Crear y editar productos (código, nombre, descripción) | ✅      | ✅            | ❌                  |
| Cambiar precios                                    | ✅            | Con la **clave del jefe** (si el jefe lo exige) | ❌ |
| Importar productos desde Excel                     | ✅            | Con la **clave del jefe** | ❌      |
| Entradas y salidas de mercancía                    | ✅            | Con la **clave del jefe** | ❌      |
| Anular ventas                                      | ✅            | Con la **clave del jefe** | ❌      |
| Ver y cambiar la tasa del dólar                    | ✅            | ✅            | ❌                  |
| Reportes (por día o por rango) y Excel/PDF         | ✅            | ✅            | ❌                  |
| **Configuración**: vendedores, clave del jefe y si el precio pide clave | ✅            | ❌            | ❌                  |

Atención al público ve el precio en dólares ya calculado, pero no la tasa usada.

### El jefe

El jefe entra con su propio usuario (`roa`) y tiene todos los permisos. En la pestaña
**Configuración**:

- Crea vendedores y les asigna su **código** (mínimo 4 caracteres, no se repiten).
- Cambia el código de un vendedor o lo desactiva (su código deja de servir).
- Define la **clave del jefe** (mínimo 6 caracteres): es la que teclea en el computador de la
  administradora para autorizar una entrada, una salida o la anulación de una venta.
  Con su propio usuario no se la pide.

La clave del jefe y los códigos se guardan **cifrados**: nadie puede leerlos, ni desde la app
ni desde la base de datos; si alguien olvida su código, el jefe le asigna uno nuevo.
Por seguridad, 5 claves del jefe incorrectas seguidas la bloquean 15 minutos (el jefe la
desbloquea definiendo una nueva), y 10 códigos de vendedor incorrectos seguidos bloquean las
ventas 5 minutos. Los campos de clave y código se ven como puntos, pero el navegador no
ofrece guardarlos.

Los permisos se aplican **en la base de datos** (Row Level Security de Supabase), no solo ocultando botones:
aunque alguien intente hacer algo que su rol no permite, la base de datos lo rechaza.

## Estructura

```
index.html            Página única (login + aplicación)
css/styles.css        Estilos (modo claro/oscuro automático, adaptado a celular)
js/config.js          URL y clave pública (anon) de Supabase
js/app.js             Lógica de la aplicación
js/exportar.js        Descargas del cierre en Excel y PDF
supabase/schema.sql   Tablas, permisos, búsqueda, ventas y clave del jefe
```

No necesita instalación ni compilación: son archivos estáticos.

## Uso

- **En el computador:** abrir `index.html` con doble clic.
- **Publicado en internet:** subir la carpeta a cualquier hosting estático
  (GitHub Pages, Netlify, Vercel…). En GitHub: *Settings → Pages → Deploy from a branch → `main` / root*.

Para entrar se escribe solo el **usuario** (por ejemplo `admin`); el sistema completa
internamente el correo `admin@sistema-mayor.local`. También se puede escribir el correo completo.

### Búsqueda

Busca por **código**, nombre o descripción, sin importar mayúsculas ni tildes
(`cafe` encuentra "Café"). Si se escriben varias palabras, deben aparecer todas
(`nevera plata` encuentra "Nevera Samsung — color plata").

- Primero aparece el producto cuyo código es **exactamente** el buscado, luego los
  que **empiezan** por ese código, y después el resto.
- Con **Enter** busca de inmediato y deja el texto seleccionado: el siguiente código
  reemplaza al anterior (sirve también con lector de código de barras).

### Código del producto

- Es obligatorio al crear o editar un producto y no se puede repetir.
- Se guarda en mayúsculas y sin espacios al inicio o al final (`abc-12` → `ABC-12`).

La vista de **Atención al público** usa letra más grande y todo el ancho de la pantalla,
para leer la información de un vistazo o mostrársela al cliente.

### Ventas con carrito

El botón **Agregar** de cada producto lo pone en el carrito (cada clic suma una unidad, sin
pasar de lo disponible). Abajo aparece la barra del carrito con el total; con **Ver carrito y
cobrar** se ajustan las cantidades, se quitan productos y el vendedor escribe **su código** una
sola vez. Al confirmar, toda la venta queda registrada con **un mismo número (#)** a su nombre
y se **descuenta del inventario automáticamente**.

La venta se registra completa o no se registra: si a un producto le faltan unidades (por
ejemplo, otro vendedor se llevó la última), no se vende nada y el carrito se ajusta a lo que
hay. Nunca se vende más de lo disponible.

### Entradas y salidas de mercancía

La cantidad de un producto **no se edita a mano**. Solo cambia con:

- **Ventas** (descuentan).
- **Entrada/Salida** (botón en cada producto, administrador y jefe): cantidad, motivo
  (compra a proveedor, producto dañado, devolución…) y, para el administrador, la
  **clave del jefe**.
- **Anulación de una venta** (devuelve las unidades; el administrador necesita la clave del jefe).
- **Importación desde Excel** (ver abajo).

Un producto nuevo se crea con 0 unidades; la mercancía se carga después con una entrada.
Solo se puede eliminar un producto que tenga 0 unidades.
Cada movimiento queda en el historial con la hora, el motivo, quién lo hizo y cuánto
había antes y después.

### Precios

- Todo cambio de precio queda en el **historial**: quién, cuándo, de cuánto a cuánto y si fue
  editando o por Excel. Se ve al editar el producto ("Historial de precio") y en Reportes.
- El jefe decide en **Configuración** si cambiar un precio requiere su clave (viene activado).
  Si está activado, al administrador se le pide la clave del jefe solo cuando cambia el precio.

### Importar productos desde Excel

Botón **Importar Excel** en el inventario (administrador y jefe):

1. **Descargar plantilla**: un Excel con todos los productos actuales (código, nombre,
   descripción, cantidad, precio). Se corrige lo necesario o se agregan filas nuevas.
2. Se elige el archivo y qué significa la columna **Cantidad**: la **existencia total**
   (reemplaza lo que hay) o **unidades que llegan** (se suman).
3. Antes de importar se ve fila por fila qué va a pasar: productos nuevos, cambios
   (precio antes → después, cantidad antes → después), sin cambios y errores.
4. El administrador autoriza todo el archivo una sola vez con la clave del jefe.

Reglas: los productos se buscan por código (si no existe, se crea con nombre y precio
obligatorios); una celda vacía deja ese dato como está; si hay alguna fila con error no se
importa nada. Cada cambio de cantidad queda como entrada/salida y cada cambio de precio en
el historial. Máximo 5.000 productos por archivo.

### Reportes (administrador y jefe)

La pestaña **Reportes** muestra por defecto el **cierre del día** de hoy. Se puede elegir
**Ayer, Esta semana, Semana pasada, Este mes, Mes pasado, Últimos 7 días, Últimos 30 días**
o un periodo **personalizado** (desde – hasta). Las semanas empiezan el lunes.

- Total vendido en pesos (y su equivalente en dólares con la tasa de cada venta),
  número de ventas (cada carrito cuenta como una), unidades vendidas y productos por agotarse.
- Ventas por día (cuando el periodo tiene varios días), productos más vendidos, ventas por
  vendedor, entradas y salidas, cambios de precio, detalle de cada venta (n.º, fecha/hora,
  producto, cantidad, vendedor) y productos con 5 unidades o menos (`STOCK_BAJO` en `js/config.js`).
- **Anular** una línea de venta equivocada (con la clave del jefe): las unidades vuelven al
  inventario y queda marcada como anulada (no se borra).
- **Descargar Excel** (Resumen, Ventas, Por día, Por producto, Por vendedor, Entradas y salidas,
  Cambios de precio, Por agotarse e Inventario) o **Descargar PDF** (listo para imprimir).

Mientras el periodo incluya el día de hoy, los datos se actualizan solos cada minuto.

### Zona horaria

Todo el sistema usa la hora de **Caracas (UTC-4)**: las horas que se muestran, a qué día
pertenece cada venta y las fechas de los reportes. Se cambia en `js/config.js` (`ZONA_HORARIA`).

### Precios

- Se escriben en pesos, con o sin puntos de miles: `1.500.000`, `1500000` o `3.950,50`.
- El precio en dólares se calcula automáticamente: `precio COP ÷ tasa`.
- Mientras el administrador no defina la tasa, la columna USD muestra "—".

## Administración de usuarios

Los usuarios se gestionan desde el panel de Supabase.

**1. Crear el usuario:** *Authentication → Users → Add user → Create new user*
- Email: `nombre@sistema-mayor.local` (o un correo real)
- Contraseña
- Marcar **Auto Confirm User**

**2. Asignarle un rol:** *SQL Editor*, cambiando el correo y el rol (`jefe`, `admin` o `atencion`):

```sql
insert into public.perfiles (id, nombre, rol)
select id, 'María - caja 1', 'atencion'
from auth.users where email = 'maria@sistema-mayor.local';
```

Un usuario **sin rol asignado no puede ver nada**, aunque tenga contraseña.

**Cambiar el rol de alguien:**

```sql
update public.perfiles set rol = 'admin'
where id = (select id from auth.users where email = 'maria@sistema-mayor.local');
```

**Quitar el acceso:** eliminar el usuario en *Authentication → Users*
(su rol se borra automáticamente).

**Cambiar una contraseña:** *Authentication → Users → (usuario) → Reset password*,
o eliminar y volver a crear el usuario.

## Base de datos

El archivo [`supabase/schema.sql`](supabase/schema.sql) crea todo lo necesario.
Se puede ejecutar en *SQL Editor* en un proyecto nuevo, y es seguro volver a ejecutarlo.

| Tabla           | Contenido                                                        |
|-----------------|------------------------------------------------------------------|
| `perfiles`      | Rol de cada usuario (`jefe` / `admin` / `atencion`)              |
| `productos`     | Código (único), nombre, descripción, cantidad y precio en COP    |
| `configuracion` | Tasa del dólar (pesos por 1 USD), cuándo y quién la cambió       |
| `ventas`        | Cada línea vendida: n.º de venta, producto, cantidad, precio, tasa, vendedor, hora y si fue anulada |
| `historial_precios` | Cada cambio de precio: antes, después, quién, cuándo y si fue por Excel |
| `movimientos`   | Historial de todo lo que mueve el inventario (ventas, anulaciones, entradas, salidas) |
| `vendedores`    | Nombre y código cifrado de cada vendedor (nadie lo puede leer)   |
| `seguridad`     | Clave del jefe cifrada e intentos fallidos (nadie la puede leer) |

## Seguridad

- `js/config.js` solo contiene la clave **anon**, que es pública por diseño en Supabase.
- **Nunca** pongas en este repositorio la clave `service_role` ni la contraseña de la base de datos:
  saltan todos los permisos.
- Recomendado: en *Authentication → Sign In / Providers* desactivar **Allow new users to sign up**,
  para que nadie pueda crear cuentas por su cuenta (de todas formas, una cuenta sin rol no ve nada).
- Quien tenga acceso al **panel de Supabase** (o a la clave `service_role`) puede modificar la base
  de datos directamente, saltándose la clave del jefe. Ese acceso debe tenerlo solo el dueño o el jefe.
