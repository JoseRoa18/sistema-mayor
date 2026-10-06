# Sistema Mayor · Inventario

Sistema sencillo para consultar y administrar productos, con inicio de sesión y permisos por rol.
Precios en **pesos colombianos (COP)** con su equivalente en **dólares (USD)** según la tasa que defina el administrador.

## Roles

| Puede…                                         | Administrador | Atención al público |
|------------------------------------------------|:-------------:|:-------------------:|
| Buscar productos por código o nombre           | ✅            | ✅                  |
| Ver código, nombre, descripción, cantidad, precio COP y USD | ✅ | ✅               |
| Crear, editar y eliminar productos             | ✅            | ❌                  |
| Ver y cambiar la tasa del dólar                | ✅            | ❌                  |

Atención al público ve el precio en dólares ya calculado, pero no la tasa usada.

Los permisos se aplican **en la base de datos** (Row Level Security de Supabase), no solo ocultando botones:
aunque alguien intente modificar datos sin ser administrador, la base de datos lo rechaza.

## Estructura

```
index.html            Página única (login + aplicación)
css/styles.css        Estilos (modo claro/oscuro automático, adaptado a celular)
js/config.js          URL y clave pública (anon) de Supabase
js/app.js             Lógica de la aplicación
supabase/schema.sql   Tablas, permisos y búsqueda
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

**2. Asignarle un rol:** *SQL Editor*, cambiando el correo y el rol (`admin` o `atencion`):

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
| `perfiles`      | Rol de cada usuario (`admin` / `atencion`)                       |
| `productos`     | Código (único), nombre, descripción, cantidad y precio en COP    |
| `configuracion` | Tasa del dólar (pesos por 1 USD), cuándo y quién la cambió       |

## Seguridad

- `js/config.js` solo contiene la clave **anon**, que es pública por diseño en Supabase.
- **Nunca** pongas en este repositorio la clave `service_role` ni la contraseña de la base de datos:
  saltan todos los permisos.
- Recomendado: en *Authentication → Sign In / Providers* desactivar **Allow new users to sign up**,
  para que nadie pueda crear cuentas por su cuenta (de todas formas, una cuenta sin rol no ve nada).
