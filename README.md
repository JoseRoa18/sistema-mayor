# Sistema Mayor · Inventario

Sistema sencillo para consultar y administrar productos, con inicio de sesión y permisos por rol.
Precios en **pesos colombianos (COP)** con su equivalente en **dólares (USD)** según la tasa que defina el administrador.

## Roles

| Puede…                                             | Jefe (`roa`)  | Administrador | Atención al público |
|----------------------------------------------------|:-------------:|:-------------:|:-------------------:|
| Buscar productos por código o nombre               | ✅            | ✅            | ✅                  |
| Ver código, nombre, descripción, cantidad, precio COP y USD | ✅   | ✅            | ✅                  |
| Vender con carrito (con el **código del vendedor**) | ✅            | ✅            | ✅                  |
| Descargar la **lista de precios** en PDF           | ✅            | ✅            | ✅                  |
| **Imprimir el ticket** de la venta en la impresora Bluetooth | ✅  | ✅            | ✅                  |
| Reimprimir el ticket de cualquier venta (desde Reportes) | ✅       | ✅            | ❌                  |
| **Cerrar el día** (con el código de una persona autorizada) | ✅   | ✅            | ✅                  |
| **Administración**: ver los tickets de hoy (sin dinero) y anular un ticket | ❌ | ❌ | Con la **clave del jefe** |
| Crear y editar productos (código, nombre, descripción) | ✅      | ✅            | ❌                  |
| Cambiar precios (uno por uno o **en bloque**)      | ✅            | Con la **clave del jefe** (si el jefe lo exige) | ❌ |
| Importar productos desde Excel                     | ✅            | Con la **clave del jefe** | ❌      |
| Entradas y salidas de mercancía                    | ✅            | Con la **clave del jefe** | ❌      |
| Anular ventas                                      | ✅            | Con la **clave del jefe** | ❌      |
| Ver y cambiar la tasa del dólar                    | ✅            | ✅            | ❌                  |
| Reportes (por día o por rango) y Excel/PDF         | ✅            | ✅            | ❌                  |
| **Reabrir** un día cerrado                         | ✅            | ❌            | ❌                  |
| **Configuración**: personal (vendedores y quién cierra el día), categorías, clave del jefe y si el precio pide clave | ✅ | ❌ | ❌ |

Atención al público ve el precio en dólares ya calculado, pero no la tasa usada (tampoco en
la lista de precios en PDF).

### El jefe

El jefe entra con su propio usuario (`roa`) y tiene todos los permisos. En la pestaña
**Configuración**:

- Crea vendedores y les asigna su **código** (mínimo 4 caracteres, no se repiten).
- Cambia el código de un vendedor o lo desactiva (su código deja de servir).
- Marca quién **puede hacer el cierre del día** (casilla "Puede hacer el cierre del día").
- Agrega o cambia **categorías** (letra y nombre).
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
css/styles.css        Estilos (tema claro y oscuro, adaptado a celular)
js/config.js          URL y clave pública (anon) de Supabase
js/app.js             Lógica de la aplicación
js/tema.js            Tema claro / oscuro / automático
js/exportar.js        Reportes en Excel y PDF (resumen y detallado), PDF de cada venta,
                      lista de precios, plantilla e importación de Excel
js/impresora.js       Tickets en la mini impresora térmica Bluetooth ("gatito")
supabase/schema.sql   Tablas, permisos, búsqueda, ventas, cierres y clave del jefe
```

No necesita instalación ni compilación: son archivos estáticos.

## Uso

- **En el computador:** abrir `index.html` con doble clic.
- **Publicado en internet:** subir la carpeta a cualquier hosting estático
  (GitHub Pages, Netlify, Vercel…). En GitHub: *Settings → Pages → Deploy from a branch → `main` / root*.

Para entrar se escribe solo el **usuario** (por ejemplo `admin`); el sistema completa
internamente el correo `admin@sistema-mayor.local`. También se puede escribir el correo completo.

### Búsqueda

Busca por **código**, nombre o descripción, sin importar mayúsculas, tildes ni guiones
(`cafe` encuentra "Café"; `v3013` encuentra "V-3013" y al revés). Si se escriben varias palabras, deben aparecer todas
(`nevera plata` encuentra "Nevera Samsung — color plata").

- Primero aparece el producto cuyo código es **exactamente** el buscado, luego los
  que **empiezan** por ese código, y después el resto.
- Con **Enter** busca de inmediato y deja el texto seleccionado: el siguiente código
  reemplaza al anterior (sirve también con lector de código de barras).

### Código del producto

- Es obligatorio al crear o editar un producto y no se puede repetir.
- Se guarda en mayúsculas y sin espacios al inicio o al final (`abc-12` → `ABC-12`).

### Categorías

Todo producto tiene una categoría. Vienen cuatro, y la **letra con la que empieza el código**
la elige sola:

| Letra | Categoría      |
|:-----:|----------------|
| V     | Varios         |
| L     | Lavadora       |
| R     | Refrigeración  |
| C     | Cocina         |

Al escribir el código de un producto nuevo (`L-2054`) la categoría se pone sola (Lavadora);
se puede cambiar a mano. En el inventario se filtra por categoría con la lista que está junto
al conteo de productos. El jefe agrega o renombra categorías en **Configuración** (al renombrar,
los productos de esa categoría se actualizan solos).

La vista de **Atención al público** usa letra más grande y todo el ancho de la pantalla,
para leer la información de un vistazo o mostrársela al cliente.

### Ventas con carrito

El botón **Agregar** de cada producto lo pone en el carrito (cada clic suma una unidad, sin
pasar de lo disponible). Cuando ya están en el carrito todas las unidades disponibles, el botón
se ve apagado y, si se toca, un aviso explica que no hay más unidades. Abajo aparece la barra del carrito con el total; con **Ver carrito y
cobrar** se ajustan las cantidades, se quitan productos y el vendedor escribe **su código** una
sola vez. Al confirmar, toda la venta queda registrada con **un mismo número (#)** a su nombre
y se **descuenta del inventario automáticamente**.

La venta se registra completa o no se registra: si a un producto le faltan unidades (por
ejemplo, otro vendedor se llevó la última), no se vende nada y el carrito se ajusta a lo que
hay. Nunca se vende más de lo disponible.

**Numeración:** cada día las ventas empiezan en **#1** (#1, #2, #3… del día). Además, cada venta
tiene un **consecutivo** interno que nunca se reinicia ni salta números (una venta que no se
completa no gasta número). Los tickets, reportes y PDF muestran los dos.

### Impresora de tickets (mini impresora térmica Bluetooth "gatito")

Después de cada venta se imprime un ticket de 57 mm con: **número del ticket** (el del día) y
consecutivo, **fecha y hora**, el **código de cada producto en grande** con su cantidad, el
nombre del producto recortado a dos renglones, el **total** y el **vendedor**.

**Conectarla (una vez por equipo):** encender la impresora, tocar el botón de la impresora en la
barra de arriba y luego **Conectar impresora**; aparece en la lista con un nombre como GB02,
MX06 o MXW01. Si no aparece, **Ver todos los equipos Bluetooth**. Con **Imprimir prueba** se
comprueba que todo sale bien.

- Con la impresora conectada, el ticket sale **solo** al registrar cada venta (se puede apagar en
  el mismo botón). Si se apaga y se vuelve a encender, el sistema la reconecta solo.
- Si no hay impresora, el aviso de la venta trae el botón **Imprimir ticket**.
- **Reimprimir último ticket** (en el botón de la impresora) y, para administración y el jefe,
  **Imprimir ticket** en el detalle de cualquier venta en Reportes. Las reimpresiones dicen
  "REIMPRESIÓN" al final.
- **Intensidad** (clara, normal u oscura) y **modo compatible** (más lento, por si el ticket sale
  cortado o con rayas). Se guardan en cada equipo.

**En el computador (impresión automática todo el día):**

1. La impresora no se agrega en *Configuración de Windows → Bluetooth*: se conecta desde la página.
   Si ya está agregada ahí, quitarla. Tampoco debe estar conectada al teléfono al mismo tiempo
   (la impresora acepta una sola conexión).
2. En Chrome, abrir `chrome://flags/#enable-web-bluetooth-new-permissions-backend`, ponerlo en
   **Enabled** y tocar **Relaunch**. Con eso Chrome recuerda la impresora y la página la
   reconecta sola cada vez que se abre o se recarga. Sin ese ajuste también funciona, pero
   después de recargar la página hay que tocar una vez **Conectar e imprimir**.
3. Conectarla una vez desde el botón de la impresora y dejar marcado **Imprimir el ticket
   automáticamente**. Desde ahí cada venta imprime sola.

Funciona con **Google Chrome** (o Edge) en Android o en el computador, que pueden usar Bluetooth
desde una página web. En **iPhone** no se puede: ahí **Guardar o compartir imagen** manda la
imagen del ticket a la app de la impresora para imprimirla desde allí.

Modelos: los "gatito" clásicos (GB01, GB02, GB03, MX05, MX06, MX08, MX10, YT01, X6…) y la versión
nueva MXW01. La impresora se elige con el nombre que muestra en Bluetooth.

### Cierre del día

El cierre es **manual**: botón **Cerrar el día** en el inventario (o **Cerrar este día** en
Reportes). Se escribe el **código** de una persona autorizada por el jefe para cerrar (en
Configuración). Al cerrar se guarda una foto de los totales del día (total vendido, ventas,
unidades, anulaciones, rango de consecutivos y ventas por vendedor) y quién cerró y a qué hora.

Con el día cerrado **no se pueden registrar más ventas ni anular ventas de ese día**. Solo el
jefe puede **reabrirlo** desde Reportes (queda registrado quién lo reabrió).

### Administración (atención al público)

Pestaña con los **tickets de hoy**: número del día, hora, vendedor y productos con su cantidad,
**sin precios ni totales** y sin acceso al inventario. Un ticket completo se puede **anular**
con la clave del jefe: las unidades vuelven al inventario. Solo se pueden anular tickets de
hoy y mientras el día no esté cerrado.

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
- **Precios en bloque** (botón en el inventario): sube o baja los precios de una categoría o de
  todos los productos, **por porcentaje** o **por un monto en pesos**, y redondea el resultado.
  Primero se ve **cómo quedan** todos los precios y luego se aplica. No deja aplicar un cambio
  que deje algún precio en $ 0 o menos. Cada cambio queda en el historial como "en bloque".
- **Lista de precios** (botón en el inventario, para todos): PDF sencillo con código,
  descripción y precio (pesos y dólares), agrupado por categoría. Sirve de respaldo por si el
  sistema no está disponible.

### Importar productos desde Excel

Botón **Importar Excel** en el inventario (administrador y jefe):

1. **Descargar plantilla**: un Excel con todos los productos actuales (código, nombre,
   descripción, categoría, cantidad, precio). Se corrige lo necesario o se agregan filas nuevas.
2. Se elige el archivo y qué significa la columna **Cantidad**: la **existencia total**
   (reemplaza lo que hay) o **unidades que llegan** (se suman).
3. Antes de importar se ve fila por fila qué va a pasar: productos nuevos, cambios
   (precio antes → después, cantidad antes → después), sin cambios y errores.
4. El administrador autoriza todo el archivo una sola vez con la clave del jefe.

Reglas: los productos se buscan por código (si no existe, se crea con nombre y precio
obligatorios); la categoría se escribe con su nombre o su letra, y si se deja vacía se toma de
la letra del código; una celda vacía deja ese dato como está; si hay alguna fila con error no se
importa nada. Cada cambio de cantidad queda como entrada/salida y cada cambio de precio en
el historial. Máximo 5.000 productos por archivo.

### Reportes (administrador y jefe)

La pestaña **Reportes** muestra por defecto el **cierre del día** de hoy. Se puede elegir
**Ayer, Esta semana, Semana pasada, Este mes, Mes pasado, Últimos 7 días, Últimos 30 días**
o un periodo **personalizado** (desde – hasta). Las semanas empiezan el lunes.

- Total vendido en pesos (y su equivalente en dólares con la tasa de cada venta),
  número de ventas (cada carrito cuenta como una), unidades vendidas y productos por agotarse.
- Ventas por día (cuando el periodo tiene varios días), productos más vendidos, ventas por
  vendedor, entradas y salidas, cambios de precio, **ventas por carrito**, detalle de cada línea
  vendida y productos con 5 unidades o menos (`STOCK_BAJO` en `js/config.js`).
- **Estado del día**: si el día está cerrado, quién lo cerró y cuándo (en un periodo de varios
  días, cuántos están cerrados).
- **Reporte por carrito**: una fila por venta (número del día, consecutivo, fecha, vendedor,
  productos, unidades, total y si fue anulada). Al tocar una venta, o al buscarla por su número con **Ver venta**,
  se abre su detalle completo con el total en pesos y en dólares (con la tasa de ese momento)
  y se puede **descargar en PDF**.
- **Anular** una línea de venta equivocada, o la venta completa desde su detalle (con la clave
  del jefe): las unidades vuelven al inventario y queda marcada como anulada (no se borra).
  En un día cerrado no se ofrece anular.
- **PDF detallado**: cada venta con sus productos, categoría, cantidad, precio y subtotal, y el
  total de cada venta y del periodo.
- **PDF resumen**: un **resumen** de una página para un día normal (indicadores, entradas,
  salidas, anulaciones y cambios de precio, ventas por vendedor y por día, los 10 productos más
  vendidos y los 10 por agotarse).
- **Excel detallado**: todo el detalle (Resumen con el estado del cierre, Ventas línea por
  línea, **Ventas detalladas** agrupadas por venta, Por carrito, Por día, Por producto, Por
  vendedor, Entradas y salidas, Cambios de precio, Por agotarse e Inventario con categoría).

Mientras el periodo incluya el día de hoy, los datos se actualizan solos cada minuto.

### Tema claro y oscuro

El botón de sol/luna (arriba, y también en la pantalla de inicio de sesión) permite elegir
**Claro**, **Oscuro** o **Automático** (sigue el modo del equipo y cambia solo si el equipo
cambia). Cada equipo recuerda su elección. Los colores de ambos temas cumplen el contraste
mínimo recomendado para leer bien (WCAG AA).

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
| `productos`     | Código (único), nombre, descripción, categoría, cantidad y precio en COP |
| `categorias`    | Letra (prefijo del código) y nombre de cada categoría           |
| `configuracion` | Tasa del dólar (pesos por 1 USD), cuándo y quién la cambió       |
| `ventas`        | Cada línea vendida: consecutivo, n.º del día, producto, categoría, cantidad, precio, tasa, vendedor, hora y si fue anulada |
| `numeracion`    | Último consecutivo usado y último número del día (consecutivos y sin saltos) |
| `cierres`       | Cierre de cada día: quién cerró, cuándo, totales en ese momento y si el jefe lo reabrió |
| `historial_precios` | Cada cambio de precio: antes, después, quién, cuándo y si fue por Excel |
| `movimientos`   | Historial de todo lo que mueve el inventario (ventas, anulaciones, entradas, salidas) |
| `vendedores`    | Nombre, código cifrado (nadie lo puede leer) y si puede cerrar el día |
| `seguridad`     | Clave del jefe cifrada e intentos fallidos (nadie la puede leer) |

## Seguridad

- `js/config.js` solo contiene la clave **anon**, que es pública por diseño en Supabase.
- **Nunca** pongas en este repositorio la clave `service_role` ni la contraseña de la base de datos:
  saltan todos los permisos.
- Recomendado: en *Authentication → Sign In / Providers* desactivar **Allow new users to sign up**,
  para que nadie pueda crear cuentas por su cuenta (de todas formas, una cuenta sin rol no ve nada).
- Quien tenga acceso al **panel de Supabase** (o a la clave `service_role`) puede modificar la base
  de datos directamente, saltándose la clave del jefe. Ese acceso debe tenerlo solo el dueño o el jefe.
