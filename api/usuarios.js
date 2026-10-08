'use strict';

// Usuarios de la app, solo para el jefe: listar, crear, cambiar contraseña, cambiar nombre o rol,
// y quitar o devolver el acceso.
//
// Corre en Vercel (no en el navegador) porque necesita la clave secreta de Supabase, que vive
// solo en la variable de entorno SUPABASE_SECRET_KEY del proyecto en Vercel y nunca llega al
// navegador ni al repositorio. Usa la API oficial de Supabase Auth (contraseñas cifradas por
// Supabase) y en cada llamada comprueba que quien la usa haya iniciado sesión como jefe.

const URL_SUPABASE = process.env.SUPABASE_URL || 'https://hclsiolhjnivdnlzrcha.supabase.co';
const CLAVE = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DOMINIO = 'sistema-mayor.local';
const ROLES = ['jefe', 'admin', 'atencion'];
const BLOQUEO = '876000h';   // "sin acceso" (unos 100 años); se quita con ban_duration "none"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Las claves nuevas (sb_secret_…) van solo en "apikey"; la antigua (service_role, un JWT),
// también como Bearer.
function cabeceras(extra = {}) {
  const h = { apikey: CLAVE, 'Content-Type': 'application/json', ...extra };
  if (!CLAVE.startsWith('sb_') && !h.Authorization) h.Authorization = `Bearer ${CLAVE}`;
  return h;
}

async function pedir(ruta, opciones = {}) {
  const r = await fetch(`${URL_SUPABASE}${ruta}`, { ...opciones, headers: cabeceras(opciones.headers) });
  const texto = await r.text();
  let datos = null;
  try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
  return { ok: r.ok, estado: r.status, datos };
}

const mensaje = (r) => (r.datos && (r.datos.msg || r.datos.message || r.datos.error_description || r.datos.error)) || `error ${r.estado}`;
const usuarioDe = (email) => (String(email || '').endsWith(`@${DOMINIO}`) ? email.slice(0, -DOMINIO.length - 1) : String(email || ''));

function validarClave(clave) {
  if (typeof clave !== 'string' || clave.length < 6) return 'La contraseña debe tener al menos 6 caracteres (mejor 8 o más).';
  if (clave.length > 72) return 'La contraseña es demasiado larga (máximo 72 caracteres).';
  return null;
}

async function listar() {
  const u = await pedir('/auth/v1/admin/users?page=1&per_page=1000');
  if (!u.ok) throw new Error(mensaje(u));
  const p = await pedir('/rest/v1/perfiles?select=id,nombre,rol');
  if (!p.ok) throw new Error(mensaje(p));
  const perfiles = new Map((p.datos || []).map((x) => [x.id, x]));
  const orden = { jefe: 0, admin: 1, atencion: 2 };
  return (u.datos.users || []).map((x) => ({
    id: x.id,
    usuario: usuarioDe(x.email),
    nombre: perfiles.get(x.id)?.nombre || '',
    rol: perfiles.get(x.id)?.rol || null,
    ultimo_ingreso: x.last_sign_in_at || null,
    creado_en: x.created_at || null,
    sin_acceso: Boolean(x.banned_until && Date.parse(x.banned_until) > Date.now()),
  })).sort((a, b) => (orden[a.rol] ?? 9) - (orden[b.rol] ?? 9) || a.usuario.localeCompare(b.usuario));
}

// Nombre y rol en la tabla de perfiles (crea el perfil si no existía).
const guardarPerfil = (id, nombre, rol) => pedir('/rest/v1/perfiles', {
  method: 'POST',
  headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify({ id, nombre, rol }),
});

module.exports = async function usuarios(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const falla = (estado, error, campo) => res.status(estado).json({ ok: false, error, ...(campo ? { campo } : {}) });
  if (req.method !== 'POST') return falla(405, 'Método no permitido.');
  if (!CLAVE) return falla(503, 'Falta un paso: configurar la clave secreta de Supabase en Vercel (SUPABASE_SECRET_KEY). Ver el README.');

  try {
    // 1. ¿Quién llama? Su sesión y que sea el jefe.
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return falla(401, 'Inicia sesión de nuevo.');
    const yo = await pedir('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } });
    if (!yo.ok || !yo.datos || !yo.datos.id) return falla(401, 'Tu sesión venció. Sal e inicia sesión de nuevo.');
    const miPerfil = await pedir(`/rest/v1/perfiles?id=eq.${yo.datos.id}&select=rol`);
    if (!miPerfil.ok || !Array.isArray(miPerfil.datos) || miPerfil.datos[0]?.rol !== 'jefe') return falla(403, 'Solo el jefe administra los usuarios.');

    const b = (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) || {};
    const id = b.id == null ? null : String(b.id);
    if (id !== null && !UUID.test(id)) return falla(400, 'Usuario no válido.');
    const esYo = id === yo.datos.id;

    switch (b.accion) {
      case 'listar':
        return res.status(200).json({ ok: true, usuarios: await listar(), yo: yo.datos.id });

      case 'crear': {
        const usuario = String(b.usuario || '').trim().toLowerCase();
        const nombre = String(b.nombre || '').trim();
        if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(usuario)) {
          return falla(400, 'El usuario debe tener de 3 a 30 letras o números, sin espacios ni tildes (puede llevar . _ -).', 'usuario');
        }
        if (!nombre || nombre.length > 60) return falla(400, 'Escribe el nombre de la persona (máximo 60 letras).', 'nombre');
        if (!ROLES.includes(b.rol)) return falla(400, 'Elige el rol.', 'rol');
        const errorClave = validarClave(b.clave);
        if (errorClave) return falla(400, errorClave, 'clave');
        const creado = await pedir('/auth/v1/admin/users', {
          method: 'POST',
          body: JSON.stringify({ email: `${usuario}@${DOMINIO}`, password: b.clave, email_confirm: true }),
        });
        if (!creado.ok) {
          const yaExiste = creado.estado === 422 || /already|registered|exists/i.test(mensaje(creado));
          return falla(400, yaExiste ? `Ya existe el usuario "${usuario}".` : `No se pudo crear: ${mensaje(creado)}`, yaExiste ? 'usuario' : 'clave');
        }
        const perfil = await guardarPerfil(creado.datos.id, nombre, b.rol);
        if (!perfil.ok) {
          await pedir(`/auth/v1/admin/users/${creado.datos.id}`, { method: 'DELETE' });   // sin rol no sirve: se deshace
          return falla(500, `No se pudo guardar el rol: ${mensaje(perfil)}`);
        }
        return res.status(200).json({ ok: true, usuarios: await listar(), yo: yo.datos.id });
      }

      case 'contrasena': {
        if (!id) return falla(400, 'Falta el usuario.');
        const errorClave = validarClave(b.clave);
        if (errorClave) return falla(400, errorClave, 'clave');
        const r = await pedir(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: JSON.stringify({ password: b.clave }) });
        if (!r.ok) return falla(400, `No se pudo cambiar la contraseña: ${mensaje(r)}`, 'clave');
        return res.status(200).json({ ok: true, usuarios: await listar(), yo: yo.datos.id });
      }

      case 'editar': {
        if (!id) return falla(400, 'Falta el usuario.');
        const nombre = String(b.nombre || '').trim();
        if (!nombre || nombre.length > 60) return falla(400, 'Escribe el nombre de la persona (máximo 60 letras).', 'nombre');
        if (!ROLES.includes(b.rol)) return falla(400, 'Elige el rol.', 'rol');
        if (esYo && b.rol !== 'jefe') return falla(400, 'No puedes quitarte a ti mismo el rol de jefe.', 'rol');
        const r = await guardarPerfil(id, nombre, b.rol);
        if (!r.ok) return falla(400, `No se pudo guardar: ${mensaje(r)}`);
        return res.status(200).json({ ok: true, usuarios: await listar(), yo: yo.datos.id });
      }

      case 'acceso': {
        if (!id) return falla(400, 'Falta el usuario.');
        if (esYo) return falla(400, 'No puedes quitarte el acceso a ti mismo.');
        const r = await pedir(`/auth/v1/admin/users/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ ban_duration: b.quitar ? BLOQUEO : 'none' }),
        });
        if (!r.ok) return falla(400, `No se pudo cambiar el acceso: ${mensaje(r)}`);
        return res.status(200).json({ ok: true, usuarios: await listar(), yo: yo.datos.id });
      }

      default:
        return falla(400, 'Acción no válida.');
    }
  } catch (error) {
    return falla(500, `No se pudo completar: ${error.message}`);
  }
};
