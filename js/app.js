'use strict';

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, DOMINIO_USUARIOS, STOCK_BAJO, ZONA_HORARIA: ZONA } = window.CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const $ = (selector) => document.querySelector(selector);

  const estado = {
    perfil: null,     // { rol }
    tasa: null,       // pesos por 1 USD, o null si no está definida
    productos: [],
    busqueda: '',
    carrito: new Map(),           // producto_id → { producto, cantidad }
    precioRequiereClave: true,    // lo decide el jefe en Configuración
  };

  // ------------------------------------------------------------------
  // Formatos de números y moneda (estilo colombiano)
  // ------------------------------------------------------------------

  // Pesos sin decimales ("$ 28.500"), salvo que el valor tenga centavos ("$ 3.950,50").
  const fmtCOP = new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2,
    trailingZeroDisplay: 'stripIfInteger',
  });
  const fmtUSD = new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const fmtNumero = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  // Todas las fechas y horas se muestran en la zona del sistema (config.js),
  // sin importar la zona horaria configurada en cada equipo.
  const fmtFecha = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, dateStyle: 'medium', timeStyle: 'short' });
  const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
  const fmtDiaLargo = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', dateStyle: 'full' });
  const hoyEnZona = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date());

  // "2026-10-06" → [inicio, fin) de ese día en la zona del sistema (Caracas: UTC-4).
  function rangoDelDia(fecha) {
    const desfase = new Intl.DateTimeFormat('en-US', { timeZone: ZONA, timeZoneName: 'longOffset' })
      .formatToParts(new Date(`${fecha}T12:00:00Z`)).find((p) => p.type === 'timeZoneName').value;   // "GMT-04:00"
    const inicio = new Date(`${fecha}T00:00:00${desfase === 'GMT' ? 'Z' : desfase.slice(3)}`);
    return [inicio.toISOString(), new Date(inicio.getTime() + 86400000).toISOString()];
  }

  const enDolares = (cop) => (estado.tasa ? fmtUSD.format(Number(cop) / estado.tasa) : '—');

  // Acepta números escritos al estilo colombiano: "1.500.000", "3.950,50",
  // y también "3950.50". Devuelve NaN si el texto no es un número válido.
  function leerNumero(texto) {
    let s = String(texto ?? '').replace(/\s|\$|cop|usd/gi, '');
    if (s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.');      // coma = decimales
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, '');                        // puntos = miles
    }
    return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  // ------------------------------------------------------------------
  // Utilidades de interfaz
  // ------------------------------------------------------------------

  function el(tag, props, ...hijos) {
    const nodo = document.createElement(tag);
    for (const [clave, valor] of Object.entries(props || {})) {
      if (clave.startsWith('on')) nodo.addEventListener(clave.slice(2), valor);
      else nodo.setAttribute(clave, valor);
    }
    nodo.append(...hijos.filter((h) => h != null));
    return nodo;
  }

  function mostrarVista(nombre) {
    for (const v of ['cargando', 'login', 'app']) $(`#vista-${v}`).hidden = v !== nombre;
  }

  function mostrarError(selector, mensaje) {
    const nodo = $(selector);
    nodo.textContent = mensaje || '';
    nodo.hidden = !mensaje;
  }

  let temporizadorToast;
  function toast(mensaje, tipo = 'ok') {
    const nodo = $('#toast');
    nodo.textContent = mensaje;
    nodo.dataset.tipo = tipo;
    nodo.hidden = false;
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(() => { nodo.hidden = true; }, 3500);
  }

  async function conBotonOcupado(form, accion) {
    const boton = form.querySelector('[type="submit"]');
    boton.disabled = true;
    try { await accion(); } finally { boton.disabled = false; }
  }

  // ------------------------------------------------------------------
  // Sesión
  // ------------------------------------------------------------------

  async function iniciar() {
    const { data } = await db.auth.getSession();
    if (data.session) await entrar();
    else mostrarVista('login');
  }

  async function entrar() {
    const { data: { user } } = await db.auth.getUser();
    if (!user) { mostrarVista('login'); return; }

    const { data: perfil, error } = await db
      .from('perfiles').select('rol').eq('id', user.id).maybeSingle();

    if (error || !perfil) {
      await db.auth.signOut();
      mostrarError('#login-error', 'Tu usuario no tiene permisos asignados. Contacta al administrador.');
      return;
    }

    estado.perfil = perfil;
    document.body.dataset.rol = perfil.rol;
    $('#usuario-nombre').textContent = user.email.replace(`@${DOMINIO_USUARIOS}`, '');
    $('#usuario-rol').textContent = { admin: 'Administrador', jefe: 'Jefe', atencion: 'Atención al público' }[perfil.rol];

    mostrarVista('app');
    mostrarSeccion('inventario');
    await Promise.all([cargarTasa(), buscar('')]);
    $('#buscar').focus();
  }

  $('#form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const usuario = form.usuario.value.trim().toLowerCase();
    const clave = form.clave.value;
    mostrarError('#login-error', '');

    if (!usuario || !clave) {
      mostrarError('#login-error', 'Escribe tu usuario y contraseña.');
      return;
    }

    conBotonOcupado(form, async () => {
      const email = usuario.includes('@') ? usuario : `${usuario}@${DOMINIO_USUARIOS}`;
      const { error } = await db.auth.signInWithPassword({ email, password: clave });
      if (error) {
        mostrarError('#login-error', error.message === 'Invalid login credentials'
          ? 'Usuario o contraseña incorrectos.'
          : `No se pudo iniciar sesión: ${error.message}`);
        return;
      }
      form.reset();
      await entrar();
    });
  });

  $('#btn-salir').addEventListener('click', () => db.auth.signOut());

  // Al salir no debe quedar nada del usuario anterior en pantalla.
  db.auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT') {
      Object.assign(estado, { perfil: null, tasa: null, productos: [], busqueda: '', carrito: new Map() });
      // Respuestas que aún vengan en camino de la sesión anterior se descartan.
      numeroConsulta++;
      numeroCierre++;
      $('#carrito-barra').hidden = true;
      document.body.classList.remove('con-carrito');
      delete document.body.dataset.rol;
      document.querySelectorAll('dialog[open]').forEach((d) => d.close());
      $('#buscar').value = '';
      $('#tabla-cuerpo').replaceChildren();
      $('#conteo').textContent = '';
      $('#tasa-valor').textContent = '—';
      $('#tasa-fecha').textContent = '';
      cierre = null;
      mostrarSeccion('inventario');
      mostrarVista('login');
    }
  });

  // ------------------------------------------------------------------
  // Secciones (el administrador tiene "Inventario" y "Cierre del día")
  // ------------------------------------------------------------------

  let temporizadorCierre;

  // El jefe tiene todos los permisos del administrador, y además la configuración.
  const puedeAdministrar = () => ['admin', 'jefe'].includes(estado.perfil?.rol);
  const esJefe = () => estado.perfil?.rol === 'jefe';

  function mostrarSeccion(nombre) {
    for (const s of ['inventario', 'cierre', 'configuracion']) $(`#seccion-${s}`).hidden = nombre !== s;
    document.querySelectorAll('.pestana').forEach((p) => {
      if (p.dataset.seccion === nombre) p.setAttribute('aria-current', 'page');
      else p.removeAttribute('aria-current');
    });

    clearInterval(temporizadorCierre);
    if (nombre === 'cierre') {
      cargarCierre();
      // Mientras el reporte incluya el día de hoy, se actualiza solo cada minuto.
      temporizadorCierre = setInterval(() => {
        if (!document.hidden && periodoReporte().hasta >= hoyEnZona()) cargarCierre();
      }, 60000);
    }
    if (nombre === 'configuracion') cargarConfiguracion();
  }

  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => mostrarSeccion(p.dataset.seccion));
  });

  // ------------------------------------------------------------------
  // Tasa del dólar
  // ------------------------------------------------------------------

  async function cargarTasa() {
    const { data, error } = await db
      .from('configuracion').select('tasa_usd, actualizado_en, precio_requiere_clave').eq('id', 1).single();
    if (error) { toast('No se pudo cargar la tasa del dólar.', 'error'); return; }

    estado.tasa = data.tasa_usd ? Number(data.tasa_usd) : null;
    estado.precioRequiereClave = data.precio_requiere_clave !== false;
    $('#tasa-valor').textContent = estado.tasa ? `1 USD = ${fmtCOP.format(estado.tasa)}` : 'Sin definir';
    $('#tasa-fecha').textContent = estado.tasa
      ? `Actualizada: ${fmtFecha.format(new Date(data.actualizado_en))}`
      : 'El administrador debe definir la tasa';
    pintarProductos();   // recalcula la columna en dólares
  }

  function previsualizarTasa() {
    const tasa = leerNumero($('#form-tasa').tasa.value);
    $('#tasa-vista').textContent = tasa > 0
      ? `1 USD = ${fmtCOP.format(tasa)} · Ej: un producto de ${fmtCOP.format(100000)} costará ${fmtUSD.format(100000 / tasa)}`
      : '';
  }

  $('#btn-tasa').addEventListener('click', () => {
    const form = $('#form-tasa');
    form.tasa.value = estado.tasa ? fmtNumero.format(estado.tasa) : '';
    mostrarError('#tasa-error', '');
    previsualizarTasa();
    $('#dlg-tasa').showModal();
    form.tasa.select();
  });

  $('#form-tasa').tasa.addEventListener('input', previsualizarTasa);

  $('#form-tasa').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const tasa = leerNumero(form.tasa.value);
    if (!(tasa > 0)) {
      mostrarError('#tasa-error', 'Escribe un valor válido mayor que cero. Ej: 4.000');
      return;
    }

    conBotonOcupado(form, async () => {
      const { data, error } = await db
        .from('configuracion').update({ tasa_usd: tasa }).eq('id', 1).select('id');
      if (error || !data.length) {
        mostrarError('#tasa-error', error ? error.message : 'No tienes permiso para cambiar la tasa.');
        return;
      }
      $('#dlg-tasa').close();
      toast('Tasa del dólar actualizada');
      cargarTasa();
    });
  });

  // ------------------------------------------------------------------
  // Productos: búsqueda y listado
  // ------------------------------------------------------------------

  let numeroConsulta = 0;

  async function buscar(texto) {
    estado.busqueda = texto;
    const esta = ++numeroConsulta;
    const { data, error } = await db.rpc('buscar_productos', { q: texto });
    if (esta !== numeroConsulta) return;   // ya hay una búsqueda más reciente
    if (error) { toast('Error al buscar productos.', 'error'); return; }
    estado.productos = data;
    // Lo que está en el carrito se actualiza con la existencia y el precio más recientes.
    for (const p of data) {
      const linea = estado.carrito.get(p.id);
      if (!linea) continue;
      linea.producto = p;
      linea.cantidad = Math.min(linea.cantidad, p.cantidad);
      if (linea.cantidad <= 0) estado.carrito.delete(p.id);
    }
    actualizarCarrito();
  }

  let temporizadorBusqueda;
  $('#buscar').addEventListener('input', (e) => {
    clearTimeout(temporizadorBusqueda);
    temporizadorBusqueda = setTimeout(() => buscar(e.target.value), 250);
  });

  // Enter busca de inmediato y deja el texto seleccionado, así el siguiente
  // código (escrito o leído con lector de código de barras) reemplaza al anterior.
  $('#buscar').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    clearTimeout(temporizadorBusqueda);
    buscar(e.target.value);
    e.target.select();
  });

  function etiquetaCantidad(cantidad) {
    if (cantidad <= 0) return el('span', { class: 'stock stock-agotado' }, 'Agotado');
    const clase = cantidad <= STOCK_BAJO ? 'stock stock-bajo' : 'stock';
    return el('span', { class: clase }, fmtNumero.format(cantidad));
  }

  function filaProducto(p) {
    const esAdmin = puedeAdministrar();
    return el('tr', {},
      el('td', { class: 'col-codigo', 'data-label': 'Código' },
        p.codigo
          ? el('span', { class: 'codigo' }, p.codigo)
          : el('span', { class: 'sin-codigo' }, 'Sin código')),
      el('td', { class: 'col-producto', 'data-label': 'Producto' },
        el('div', { class: 'producto-nombre' }, p.nombre),
        p.descripcion ? el('div', { class: 'producto-desc' }, p.descripcion) : null),
      el('td', { class: 'num', 'data-label': 'Cantidad' }, etiquetaCantidad(p.cantidad)),
      el('td', { class: 'num precio', 'data-label': 'Precio COP' }, fmtCOP.format(p.precio_cop)),
      el('td', { class: 'num precio precio-usd', 'data-label': 'Precio USD' }, enDolares(p.precio_cop)),
      el('td', { class: 'col-acciones' },
        botonAgregar(p),
        esAdmin ? el('button', { type: 'button', class: 'btn btn-secundario btn-sm', title: 'Entrada o salida de mercancía', onclick: () => abrirMovimiento(p) }, 'Entrada/Salida') : null,
        esAdmin ? el('button', { type: 'button', class: 'btn btn-secundario btn-sm', onclick: () => abrirProducto(p) }, 'Editar') : null),
    );
  }

  // Las funciones de la base responden {ok, error, campo, ...}.
  // Los errores de permisos o de conexión llegan aparte; aquí se unifican.
  async function llamar(funcion, argumentos) {
    const { data, error } = await db.rpc(funcion, argumentos);
    if (error) return { ok: false, error: error.message };
    return data;
  }

  function pintarProductos() {
    const total = estado.productos.length;
    const hayBusqueda = estado.busqueda.trim() !== '';

    $('#tabla-cuerpo').replaceChildren(...estado.productos.map(filaProducto));

    const vacio = $('#vacio');
    vacio.hidden = total > 0;
    vacio.textContent = hayBusqueda
      ? `No se encontraron productos para “${estado.busqueda.trim()}”.`
      : 'Aún no hay productos registrados.';

    let conteo = total === 1 ? '1 producto' : `${total} productos`;
    if (hayBusqueda) conteo += ' encontrados';
    if (total >= 300) conteo += ' (se muestran los primeros 300, usa el buscador para afinar)';
    $('#conteo').textContent = total ? conteo : '';
  }

  // ------------------------------------------------------------------
  // Productos: crear / editar / eliminar (solo administrador)
  // ------------------------------------------------------------------

  let productoEditando = null;
  let productoEliminando = null;

  function previsualizarPrecio() {
    const precio = leerNumero($('#form-producto').precio_cop.value);
    $('#producto-vista').textContent = precio >= 0
      ? `Precio: ${fmtCOP.format(precio)} COP · ${estado.tasa ? `${enDolares(precio)} USD` : 'tasa del dólar sin definir'}`
      : '';
    // Si el administrador cambia el precio de un producto existente y el jefe
    // lo exige, aparece el campo de la clave.
    $('#producto-clave').hidden = !(productoEditando && !esJefe() && estado.precioRequiereClave
      && precio >= 0 && precio !== Number(productoEditando.precio_cop));
  }

  const ORIGEN_PRECIO = { creacion: 'al crearlo', edicion: 'editado', importacion: 'importación' };

  async function cargarHistorialPrecio(p) {
    const caja = $('#producto-historial');
    caja.hidden = true;
    const { data } = await db.from('historial_precios')
      .select('precio_anterior, precio_nuevo, origen, usuario, creado_en')
      .eq('producto_id', p.id).order('creado_en', { ascending: false }).limit(10);
    if (productoEditando?.id !== p.id || !data?.length) return;
    $('#producto-historial-lista').replaceChildren(...data.map((h) => el('li', {},
      el('span', {}, fmtFecha.format(new Date(h.creado_en))),
      el('span', {}, h.precio_anterior == null ? fmtCOP.format(h.precio_nuevo) : `${fmtCOP.format(h.precio_anterior)} → ${fmtCOP.format(h.precio_nuevo)}`),
      el('span', { class: 'historial-quien' }, `${h.usuario || '—'} · ${ORIGEN_PRECIO[h.origen] || h.origen}`),
    )));
    caja.hidden = false;
  }

  function abrirProducto(p) {
    productoEditando = p || null;
    const form = $('#form-producto');
    form.reset();
    $('#dlg-producto-titulo').textContent = p ? 'Editar producto' : 'Nuevo producto';
    if (p) {
      form.codigo.value = p.codigo || '';
      form.nombre.value = p.nombre;
      form.descripcion.value = p.descripcion;
      form.precio_cop.value = fmtNumero.format(p.precio_cop);
    }
    // La cantidad solo cambia con Entrada/Salida (clave del jefe) o con ventas.
    $('#producto-stock').textContent = p
      ? `Cantidad actual: ${fmtNumero.format(p.cantidad)}. Para cambiarla usa “Entrada/Salida” (requiere la clave del jefe).`
      : 'El producto se crea con 0 unidades. Después usa “Entrada/Salida” para cargar la mercancía (requiere la clave del jefe).';
    $('#btn-eliminar-producto').hidden = !p;
    $('#producto-historial').hidden = true;
    if (p) cargarHistorialPrecio(p);
    mostrarError('#producto-error', '');
    previsualizarPrecio();
    $('#dlg-producto').showModal();
    form.codigo.focus();
  }

  $('#btn-nuevo').addEventListener('click', () => abrirProducto(null));
  $('#form-producto').precio_cop.addEventListener('input', previsualizarPrecio);

  $('#form-producto').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const datos = {
      codigo: form.codigo.value.trim().toUpperCase(),
      nombre: form.nombre.value.trim(),
      descripcion: form.descripcion.value.trim(),
      precio_cop: leerNumero(form.precio_cop.value),
    };

    if (!datos.codigo) return mostrarError('#producto-error', 'El código es obligatorio.');
    if (!datos.nombre) return mostrarError('#producto-error', 'El nombre es obligatorio.');
    if (!(datos.precio_cop >= 0)) {
      return mostrarError('#producto-error', 'Escribe un precio válido en pesos. Ej: 150.000');
    }
    const pideClave = !$('#producto-clave').hidden;
    if (pideClave && !form.clave.value) {
      form.clave.focus();
      return mostrarError('#producto-error', 'Para cambiar el precio hace falta la clave del jefe.');
    }

    conBotonOcupado(form, async () => {
      const r = await llamar('guardar_producto', {
        p_id: productoEditando?.id ?? null, p_codigo: datos.codigo, p_nombre: datos.nombre,
        p_descripcion: datos.descripcion, p_precio: datos.precio_cop, p_clave_jefe: pideClave ? form.clave.value : null,
      });
      form.clave.value = '';
      if (!r.ok) {
        mostrarError('#producto-error', r.error);
        if (r.campo === 'clave') { $('#producto-clave').hidden = false; form.clave.focus(); }
        return;
      }
      $('#dlg-producto').close();
      toast(productoEditando ? 'Producto actualizado' : 'Producto creado');
      // Sin await: el botón se libera de inmediato y la lista se actualiza aparte.
      buscar(estado.busqueda);
    });
  });

  // Solo se elimina un producto sin unidades: si tiene, primero va una salida.
  $('#btn-eliminar-producto').addEventListener('click', () => {
    const p = productoEditando;
    if (p.cantidad > 0) {
      mostrarError('#producto-error', `Este producto tiene ${fmtNumero.format(p.cantidad)} unidades. `
        + 'Para eliminarlo, primero registra una salida (con la clave del jefe) hasta dejarlo en 0.');
      return;
    }
    $('#dlg-producto').close();
    productoEliminando = p;
    $('#eliminar-nombre').textContent = p.nombre;
    $('#dlg-eliminar').showModal();
  });

  $('#form-eliminar').addEventListener('submit', (e) => {
    e.preventDefault();
    conBotonOcupado(e.currentTarget, async () => {
      const { data, error } = await db
        .from('productos').delete().eq('id', productoEliminando.id).select('id');
      $('#dlg-eliminar').close();
      if (error || !data.length) {
        toast(error ? error.message : 'No se pudo eliminar: el producto todavía tiene unidades.', 'error');
        return;
      }
      toast('Producto eliminado');
      buscar(estado.busqueda);
    });
  });

  // ------------------------------------------------------------------
  // Carrito: se agregan varios productos y se cobran juntos
  // ------------------------------------------------------------------

  function botonAgregar(p) {
    const enCarrito = estado.carrito.get(p.id)?.cantidad || 0;
    if (p.cantidad <= 0) {
      return el('button', { type: 'button', class: 'btn btn-secundario btn-sm btn-vender', disabled: '' }, 'Agotado');
    }
    const lleno = enCarrito >= p.cantidad;
    return el('button', {
      type: 'button',
      class: `btn btn-sm btn-vender ${enCarrito ? 'btn-en-carrito' : 'btn-primario'}`,
      title: lleno ? 'Ya están en el carrito todas las unidades disponibles' : 'Agregar una unidad al carrito',
      ...(lleno ? { disabled: '' } : {}),
      onclick: () => agregarAlCarrito(p),
    }, enCarrito ? `Agregar (${enCarrito})` : 'Agregar');
  }

  function agregarAlCarrito(p) {
    const linea = estado.carrito.get(p.id) || { producto: p, cantidad: 0 };
    if (linea.cantidad >= p.cantidad) return;
    linea.producto = p;            // datos más recientes (precio, existencia)
    linea.cantidad += 1;
    estado.carrito.set(p.id, linea);
    actualizarCarrito();
  }

  function totalCarrito() {
    let total = 0;
    for (const { producto, cantidad } of estado.carrito.values()) total += Number(producto.precio_cop) * cantidad;
    return total;
  }

  // Repinta la barra, el diálogo (si está abierto) y los botones "Agregar".
  function actualizarCarrito() {
    const lineas = [...estado.carrito.values()];
    const unidades = lineas.reduce((s, l) => s + l.cantidad, 0);
    const total = totalCarrito();

    $('#carrito-barra').hidden = lineas.length === 0;
    document.body.classList.toggle('con-carrito', lineas.length > 0);
    $('#carrito-conteo').textContent = `${unidades} ${unidades === 1 ? 'unidad' : 'unidades'} · ${lineas.length} ${lineas.length === 1 ? 'producto' : 'productos'}`;
    $('#carrito-total-barra').textContent = fmtCOP.format(total);

    $('#carrito-lineas').replaceChildren(...lineas.map(({ producto: p, cantidad }) => el('li', {},
      el('div', { class: 'carrito-producto' },
        p.codigo ? el('span', { class: 'codigo codigo-sm' }, p.codigo) : null,
        el('div', { class: 'producto-nombre' }, p.nombre),
        el('div', { class: 'carrito-precio' }, `${fmtCOP.format(p.precio_cop)} c/u · disponibles ${fmtNumero.format(p.cantidad)}`)),
      el('div', { class: 'carrito-cantidad' },
        el('button', { type: 'button', class: 'btn btn-secundario btn-sm', 'aria-label': 'Una unidad menos', onclick: () => cambiarCantidad(p.id, -1) }, '−'),
        el('span', { class: 'carrito-n' }, fmtNumero.format(cantidad)),
        el('button', { type: 'button', class: 'btn btn-secundario btn-sm', 'aria-label': 'Una unidad más', ...(cantidad >= p.cantidad ? { disabled: '' } : {}), onclick: () => cambiarCantidad(p.id, 1) }, '+')),
      el('strong', { class: 'carrito-subtotal' }, fmtCOP.format(Number(p.precio_cop) * cantidad)),
      el('button', { type: 'button', class: 'btn btn-peligro-suave btn-sm', 'aria-label': `Quitar ${p.nombre}`, onclick: () => cambiarCantidad(p.id, -Infinity) }, 'Quitar'),
    )));
    $('#carrito-total').textContent = fmtCOP.format(total);
    $('#carrito-total-usd').textContent = estado.tasa && total ? enDolares(total) : '';

    if (!lineas.length && $('#dlg-carrito').open) $('#dlg-carrito').close();
    pintarProductos();   // actualiza los botones "Agregar (n)"
  }

  function cambiarCantidad(id, paso) {
    const linea = estado.carrito.get(id);
    if (!linea) return;
    linea.cantidad = Math.min(linea.cantidad + paso, linea.producto.cantidad);
    if (linea.cantidad <= 0) estado.carrito.delete(id);
    actualizarCarrito();
  }

  function vaciarCarrito() {
    estado.carrito.clear();
    actualizarCarrito();
  }

  $('#btn-ver-carrito').addEventListener('click', () => {
    $('#form-carrito').vendedor.value = '';
    mostrarError('#carrito-error', '');
    actualizarCarrito();
    $('#dlg-carrito').showModal();
    $('#form-carrito').vendedor.focus();
  });

  $('#btn-vaciar-carrito').addEventListener('click', vaciarCarrito);

  $('#form-carrito').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!estado.carrito.size) return;
    if (!form.vendedor.value.trim()) {
      form.vendedor.focus();
      return mostrarError('#carrito-error', 'Escribe tu código de vendedor.');
    }

    conBotonOcupado(form, async () => {
      const items = [...estado.carrito.values()].map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad }));
      const r = await llamar('registrar_venta_multiple', { p_items: items, p_codigo_vendedor: form.vendedor.value.trim() });
      if (!r.ok) {
        mostrarError('#carrito-error', r.error);
        if (r.campo === 'codigo') form.vendedor.select();
        // Alguien más vendió o el producto cambió: ajustar el carrito a lo que hay.
        if (r.producto_id != null) {
          const linea = estado.carrito.get(r.producto_id);
          if (linea && r.stock != null) {
            linea.producto = { ...linea.producto, cantidad: r.stock };
            linea.cantidad = Math.min(linea.cantidad, r.stock);
            if (linea.cantidad <= 0) estado.carrito.delete(r.producto_id);
          } else if (linea) {
            estado.carrito.delete(r.producto_id);
          }
          actualizarCarrito();
          buscar(estado.busqueda);
        }
        return;
      }
      form.vendedor.value = '';
      $('#dlg-carrito').close();
      const n = r.lineas.length;
      toast(`Venta #${r.ticket} registrada (${r.vendedor}): ${n} ${n === 1 ? 'producto' : 'productos'} · ${fmtCOP.format(r.total)}`);
      vaciarCarrito();
      buscar(estado.busqueda);
      if (!$('#seccion-cierre').hidden) cargarCierre();
      // Listo para el siguiente cliente: el buscador queda seleccionado.
      $('#buscar').focus();
      $('#buscar').select();
    });
  });

  // ------------------------------------------------------------------
  // Entradas y salidas de mercancía (administrador + clave del jefe)
  // ------------------------------------------------------------------

  let productoMoviendo = null;

  function tipoMovimiento() {
    return $('#form-movimiento').querySelector('[name="tipo"]:checked').value;
  }

  function cantidadMovimiento() {
    const n = Number($('#form-movimiento').cantidad.value);
    return Number.isInteger(n) ? n : NaN;
  }

  function actualizarVistaMovimiento() {
    const p = productoMoviendo;
    const n = cantidadMovimiento();
    const entrada = tipoMovimiento() === 'entrada';
    const nuevo = p.cantidad + (entrada ? n : -n);
    const vista = $('#mov-vista');
    vista.classList.toggle('vista-error', n >= 1 && nuevo < 0);
    vista.textContent = !(n >= 1) ? ''
      : nuevo < 0 ? `Solo hay ${fmtNumero.format(p.cantidad)} unidades: no se pueden sacar ${fmtNumero.format(n)}.`
        : `${nuevo === 1 ? 'Quedará 1 unidad' : `Quedarán ${fmtNumero.format(nuevo)} unidades`} (ahora hay ${fmtNumero.format(p.cantidad)}).`;
  }

  function abrirMovimiento(p) {
    productoMoviendo = p;
    const form = $('#form-movimiento');
    form.reset();
    $('#mov-codigo').textContent = p.codigo || 'Sin código';
    $('#mov-nombre').textContent = p.nombre;
    $('#mov-disponible').textContent = `Cantidad actual: ${fmtNumero.format(p.cantidad)}`;
    form.cantidad.value = 1;
    mostrarError('#mov-error', '');
    actualizarVistaMovimiento();
    $('#dlg-movimiento').showModal();
    form.cantidad.select();
  }

  $('#form-movimiento').addEventListener('input', actualizarVistaMovimiento);

  document.querySelectorAll('#form-movimiento [data-paso]').forEach((boton) => {
    boton.addEventListener('click', () => {
      const form = $('#form-movimiento');
      form.cantidad.value = Math.max((cantidadMovimiento() || 0) + Number(boton.dataset.paso), 1);
      actualizarVistaMovimiento();
    });
  });

  $('#form-movimiento').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const p = productoMoviendo;
    const tipo = tipoMovimiento();
    const n = cantidadMovimiento();
    if (!(n >= 1)) return mostrarError('#mov-error', 'La cantidad debe ser un número entero, 1 o mayor.');
    if (tipo === 'salida' && n > p.cantidad) return mostrarError('#mov-error', `Solo hay ${fmtNumero.format(p.cantidad)} unidades.`);
    if (form.motivo.value.trim().length < 3) { form.motivo.focus(); return mostrarError('#mov-error', 'Escribe el motivo del movimiento.'); }
    if (!esJefe() && !form.clave.value) { form.clave.focus(); return mostrarError('#mov-error', 'Falta la clave del jefe.'); }

    conBotonOcupado(form, async () => {
      const r = await llamar('registrar_movimiento', {
        p_producto_id: p.id, p_tipo: tipo, p_cantidad: n, p_motivo: form.motivo.value.trim(), p_clave_jefe: form.clave.value,
      });
      if (!r.ok) {
        mostrarError('#mov-error', r.error);
        if (r.campo === 'clave') { form.clave.value = ''; form.clave.focus(); }
        return;
      }
      form.clave.value = '';
      $('#dlg-movimiento').close();
      const m = r.movimiento;
      toast(`${tipo === 'entrada' ? 'Entrada' : 'Salida'} registrada: ${p.nombre} queda con ${fmtNumero.format(m.stock_despues)} unidades`);
      buscar(estado.busqueda);
      if (!$('#seccion-cierre').hidden) cargarCierre();
    });
  });

  // ------------------------------------------------------------------
  // Importar productos desde Excel (administrador con clave del jefe, o jefe)
  // ------------------------------------------------------------------

  let filasImportar = [];              // filas leídas del archivo
  let inventarioImportar = new Map();  // código → producto actual

  function modoImportar() {
    return $('#form-importar').querySelector('[name="modo"]:checked')?.value || null;
  }

  function abrirImportar() {
    const form = $('#form-importar');
    form.reset();
    filasImportar = [];
    $('#importar-vista').hidden = true;
    form.querySelector('[type="submit"]').disabled = true;
    mostrarError('#importar-error', '');
    $('#dlg-importar').showModal();
  }

  $('#btn-importar').addEventListener('click', abrirImportar);

  $('#btn-plantilla').addEventListener('click', async (e) => {
    const boton = e.currentTarget;
    boton.disabled = true;
    try {
      const inventario = await traerTodo(() => db.from('productos')
        .select('codigo, nombre, descripcion, cantidad, precio_cop').order('nombre'));
      await window.Exportar.plantilla(inventario, hoyEnZona());
    } catch (error) {
      mostrarError('#importar-error', `No se pudo generar la plantilla: ${error.message}`);
    } finally {
      boton.disabled = false;
    }
  });

  $('#importar-archivo').addEventListener('change', async (e) => {
    const archivo = e.target.files[0];
    filasImportar = [];
    $('#importar-vista').hidden = true;
    mostrarError('#importar-error', '');
    if (!archivo) return previsualizarImportacion();
    try {
      const [filas, inventario] = await Promise.all([
        window.Exportar.leerProductos(archivo),
        traerTodo(() => db.from('productos').select('id, codigo, nombre, descripcion, cantidad, precio_cop')),
      ]);
      filasImportar = filas;
      inventarioImportar = new Map(inventario.map((p) => [p.codigo, p]));
    } catch (error) {
      mostrarError('#importar-error', error.message);
    }
    previsualizarImportacion();
  });

  $('#form-importar').addEventListener('change', (e) => {
    if (e.target.name === 'modo') previsualizarImportacion();
  });

  // Revisa cada fila igual que lo hará la base de datos y muestra qué va a pasar.
  function previsualizarImportacion() {
    const modo = modoImportar();
    const repetidos = new Set();
    const vistos = new Set();
    for (const f of filasImportar) {
      if (f.codigo && vistos.has(f.codigo)) repetidos.add(f.codigo);
      vistos.add(f.codigo);
    }

    let nuevos = 0, cambios = 0, iguales = 0, errores = 0, comoExistencia = 0, existentes = 0;
    const filasVista = filasImportar.map((f) => {
      const actual = inventarioImportar.get(f.codigo);
      let error = f.error;
      if (!error && !f.codigo) error = 'Falta el código.';
      if (!error && repetidos.has(f.codigo)) error = 'Código repetido en el archivo.';
      if (!error && !actual && (!f.nombre || f.precio == null)) error = 'Producto nuevo: faltan el nombre o el precio.';

      let resultado;
      let clase = '';
      if (error) {
        errores++; resultado = error; clase = 'fila-error';
      } else if (!actual) {
        nuevos++; resultado = `Nuevo · ${fmtNumero.format(f.cantidad ?? 0)} unidades`; clase = 'fila-nueva';
      } else {
        existentes++;
        if (f.cantidad != null && f.cantidad === actual.cantidad && f.cantidad > 0) comoExistencia++;
        const partes = [];
        if (f.nombre && f.nombre !== actual.nombre) partes.push('nombre');
        if (f.descripcion && f.descripcion !== actual.descripcion) partes.push('descripción');
        if (f.precio != null && f.precio !== Number(actual.precio_cop)) {
          partes.push(`precio ${fmtCOP.format(actual.precio_cop)} → ${fmtCOP.format(f.precio)}`);
        }
        if (f.cantidad != null && modo) {
          const nuevo = modo === 'sumar' ? actual.cantidad + f.cantidad : f.cantidad;
          if (nuevo !== actual.cantidad) partes.push(`cantidad ${fmtNumero.format(actual.cantidad)} → ${fmtNumero.format(nuevo)}`);
        }
        if (partes.length) { cambios++; resultado = `Cambia ${partes.join(', ')}`; clase = 'fila-cambio'; } else { iguales++; resultado = 'Sin cambios'; }
      }
      return { f, resultado, clase };
    });

    $('#importar-filas').replaceChildren(...filasVista
      .sort((a, b) => (b.clase === 'fila-error') - (a.clase === 'fila-error'))   // errores primero
      .slice(0, 300)
      .map(({ f, resultado, clase }) => el('tr', clase ? { class: clase } : {},
        celda(String(f.fila)), celda(f.codigo || '—', 'nowrap'), celda(f.nombre || inventarioImportar.get(f.codigo)?.nombre || '—'),
        celda(f.cantidad != null ? fmtNumero.format(f.cantidad) : '—', 'num'),
        celda(f.precio != null ? fmtCOP.format(f.precio) : '—', 'num'),
        celda(resultado))));

    const total = filasImportar.length;
    let resumen = `${total} ${total === 1 ? 'fila' : 'filas'}: ${nuevos} nuevos, ${cambios} con cambios, ${iguales} sin cambios`;
    if (errores) resumen += `, ${errores} con errores (corrígelas en el archivo y vuelve a cargarlo)`;
    if (total > 300) resumen += '. Se muestran las primeras 300.';
    if (!modo && total) resumen += '. Elige qué significa la columna Cantidad.';
    // Si se suman cantidades que parecen ser la existencia actual, se duplicaría el inventario.
    if (modo === 'sumar' && existentes && comoExistencia / existentes >= 0.5) {
      resumen += ' ⚠ Ojo: muchas cantidades son iguales a la existencia actual. Si el archivo trae la existencia total, elige "reemplaza"; con "se suman" el inventario se duplicaría.';
    }
    $('#importar-resumen').textContent = resumen;
    $('#importar-vista').hidden = total === 0;
    $('#form-importar').querySelector('[type="submit"]').disabled = !(total && modo && !errores && (nuevos || cambios));
  }

  $('#form-importar').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!esJefe() && !form.clave.value) { form.clave.focus(); return mostrarError('#importar-error', 'Falta la clave del jefe.'); }

    conBotonOcupado(form, async () => {
      const filas = filasImportar.map(({ fila, codigo, nombre, descripcion, cantidad, precio }) =>
        ({ fila, codigo, nombre, descripcion, cantidad, precio }));
      const r = await llamar('importar_productos', { p_filas: filas, p_modo: modoImportar(), p_clave_jefe: form.clave.value || null });
      form.clave.value = '';
      if (!r.ok) {
        const detalle = r.errores?.slice(0, 5).map((x) => `fila ${x.fila}: ${x.error}`).join(' · ');
        mostrarError('#importar-error', detalle ? `${r.error} ${detalle}` : r.error);
        return;
      }
      $('#dlg-importar').close();
      toast(`Importación lista: ${r.creados} nuevos, ${r.actualizados} actualizados, ${r.sin_cambios} sin cambios`);
      buscar(estado.busqueda);
      if (!$('#seccion-cierre').hidden) cargarCierre();
    });
  });

  // ------------------------------------------------------------------
  // Configuración (solo el jefe): vendedores y clave del jefe
  // ------------------------------------------------------------------

  let vendedorEditando = null;

  async function cargarConfiguracion() {
    const r = await llamar('config_estado', {});
    if (!r.ok) { toast(`No se pudo cargar la configuración: ${r.error}`, 'error'); return; }
    pintarVendedores(r.vendedores);
    pintarEstadoClave(r.clave_definida);
    $('#config-precio-clave').checked = r.precio_requiere_clave !== false;
    editarVendedor(null);
  }

  $('#config-precio-clave').addEventListener('change', async (e) => {
    const casilla = e.currentTarget;
    casilla.disabled = true;
    const r = await llamar('config_precio_requiere_clave', { p_valor: casilla.checked });
    casilla.disabled = false;
    if (!r.ok) { casilla.checked = !casilla.checked; toast(r.error, 'error'); return; }
    estado.precioRequiereClave = r.precio_requiere_clave;
    toast(r.precio_requiere_clave ? 'Cambiar precios ahora pide la clave del jefe' : 'Cambiar precios ya no pide la clave del jefe');
  });

  function pintarEstadoClave(definida) {
    $('#clave-estado').textContent = definida
      ? 'La clave del jefe ya está definida. Puedes cambiarla cuando quieras.'
      : 'Todavía no hay clave del jefe: mientras tanto la administradora no puede registrar entradas, salidas ni anular ventas.';
  }

  function pintarVendedores(vendedores) {
    $('#config-vendedores').replaceChildren(...vendedores.map((v) => el('li', v.activo ? {} : { class: 'inactivo' },
      el('span', { class: 'vendedor-nombre' }, v.nombre),
      el('span', { class: v.activo ? 'estado-vendedor activo' : 'estado-vendedor' }, v.activo ? 'Activo' : 'Inactivo'),
      el('button', { type: 'button', class: 'btn btn-secundario btn-sm', onclick: () => editarVendedor(v) }, 'Editar'),
    )));
    $('#config-sin-vendedores').hidden = vendedores.length > 0;
  }

  function editarVendedor(v) {
    vendedorEditando = v;
    const form = $('#form-vendedor');
    form.reset();
    $('#vendedor-titulo').textContent = v ? `Editar a ${v.nombre}` : 'Nuevo vendedor';
    $('#vendedor-codigo-etiqueta').textContent = v ? 'Nuevo código (vacío = no cambiar)' : 'Código (mínimo 4)';
    $('#vendedor-activo-fila').hidden = !v;
    $('#btn-vendedor-cancelar').hidden = !v;
    if (v) {
      form.nombre.value = v.nombre;
      form.activo.checked = v.activo;
      form.nombre.focus();
    }
    mostrarError('#vendedor-error', '');
  }

  $('#btn-vendedor-cancelar').addEventListener('click', () => editarVendedor(null));

  $('#form-vendedor').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const nombre = form.nombre.value.trim();
    const codigo = form.codigo.value.trim();
    if (!nombre) return mostrarError('#vendedor-error', 'Escribe el nombre del vendedor.');
    if (!vendedorEditando && !codigo) return mostrarError('#vendedor-error', 'Asigna un código al vendedor.');
    if (codigo && codigo.length < 4) return mostrarError('#vendedor-error', 'El código debe tener al menos 4 caracteres.');

    conBotonOcupado(form, async () => {
      const r = await llamar('config_guardar_vendedor', {
        p_id: vendedorEditando?.id ?? null, p_nombre: nombre,
        p_codigo: codigo || null, p_activo: vendedorEditando ? form.activo.checked : true,
      });
      if (!r.ok) return mostrarError('#vendedor-error', r.error);
      toast(vendedorEditando ? `Vendedor ${nombre} actualizado` : `Vendedor ${nombre} creado`);
      pintarVendedores(r.vendedores);
      editarVendedor(null);
    });
  });

  $('#form-clave-jefe').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (form.nueva.value.length < 6) return mostrarError('#clave-jefe-error', 'La clave debe tener al menos 6 caracteres.');
    if (form.nueva.value !== form.repetir.value) return mostrarError('#clave-jefe-error', 'Las dos claves no coinciden.');

    conBotonOcupado(form, async () => {
      const r = await llamar('config_definir_clave_jefe', { p_clave_nueva: form.nueva.value });
      if (!r.ok) return mostrarError('#clave-jefe-error', r.error);
      form.reset();
      mostrarError('#clave-jefe-error', '');
      pintarEstadoClave(true);
      toast('Clave del jefe guardada');
    });
  });

  // ------------------------------------------------------------------
  // Reportes y cierre del día (administrador y jefe)
  // ------------------------------------------------------------------

  let cierre = null;          // datos del periodo mostrado, también se usan para exportar
  let numeroCierre = 0;
  let ventaAnulando = null;

  // Trae todas las filas aunque pasen el límite de 1.000 por consulta.
  async function traerTodo(armarConsulta) {
    const filas = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await armarConsulta().range(desde, desde + 999);
      if (error) throw error;
      filas.push(...data);
      if (data.length < 1000) return filas;
    }
  }

  // Aritmética de fechas "AAAA-MM-DD" (sin horas, así no influye la zona del equipo).
  const aFecha = (texto) => new Date(`${texto}T00:00:00Z`);
  const aTexto = (fecha) => fecha.toISOString().slice(0, 10);
  const sumarDias = (texto, n) => aTexto(new Date(aFecha(texto).getTime() + n * 86400000));
  const diaEnZona = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date(iso));
  const fmtDiaCorto = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
  const fmtFechaCorta = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

  // Periodo elegido → { desde, hasta } (ambos incluidos). La semana empieza el lunes.
  function periodoReporte() {
    const hoy = hoyEnZona();
    const diaSemana = (aFecha(hoy).getUTCDay() + 6) % 7;   // lunes = 0
    const [anio, mes] = hoy.split('-').map(Number);
    const primeroMes = `${hoy.slice(0, 8)}01`;
    switch ($('#reporte-periodo').value) {
      case 'ayer': { const ayer = sumarDias(hoy, -1); return { desde: ayer, hasta: ayer }; }
      case 'semana': return { desde: sumarDias(hoy, -diaSemana), hasta: hoy };
      case 'semana-pasada': return { desde: sumarDias(hoy, -diaSemana - 7), hasta: sumarDias(hoy, -diaSemana - 1) };
      case 'mes': return { desde: primeroMes, hasta: hoy };
      case 'mes-pasado': {
        const desde = aTexto(new Date(Date.UTC(anio, mes - 2, 1)));
        return { desde, hasta: sumarDias(primeroMes, -1) };
      }
      case '7': return { desde: sumarDias(hoy, -6), hasta: hoy };
      case '30': return { desde: sumarDias(hoy, -29), hasta: hoy };
      case 'personalizado': {
        let desde = $('#reporte-desde').value || hoy;
        let hasta = $('#reporte-hasta').value || desde;
        if (hasta < desde) [desde, hasta] = [hasta, desde];
        return { desde, hasta };
      }
      default: return { desde: hoy, hasta: hoy };
    }
  }

  // Al elegir "Personalizado" se muestran las fechas, empezando por el periodo actual.
  $('#reporte-periodo').addEventListener('change', (e) => {
    const personalizado = e.target.value === 'personalizado';
    if (personalizado && cierre) {
      $('#reporte-desde').value = cierre.desde;
      $('#reporte-hasta').value = cierre.hasta;
    }
    $('#reporte-fechas').hidden = !personalizado;
    cargarCierre();
  });
  $('#reporte-desde').addEventListener('change', cargarCierre);
  $('#reporte-hasta').addEventListener('change', cargarCierre);
  $('#btn-actualizar').addEventListener('click', cargarCierre);

  // Las líneas de una misma venta (carrito) comparten número; las antiguas cuentan solas.
  const numeroVenta = (v) => v.ticket ?? `L${v.id}`;

  function resumirCierre({ desde, hasta }, ventas, porAgotarse, movimientos, cambiosPrecio) {
    const validas = ventas.filter((v) => !v.anulada_en);
    const porProducto = new Map();
    const porVendedor = new Map();
    const porDia = new Map();
    for (const v of validas) {
      const clave = v.producto_id ?? `${v.codigo}|${v.nombre}`;
      const fila = porProducto.get(clave) || { codigo: v.codigo, nombre: v.nombre, unidades: 0, total: 0 };
      fila.unidades += v.cantidad;
      fila.total += Number(v.total);
      porProducto.set(clave, fila);

      for (const [mapa, llave, base] of [
        [porVendedor, v.vendedor || 'Sin vendedor', { vendedor: v.vendedor || 'Sin vendedor' }],
        [porDia, diaEnZona(v.vendido_en), { fecha: diaEnZona(v.vendido_en) }],
      ]) {
        const g = mapa.get(llave) || { ...base, tickets: new Set(), unidades: 0, total: 0 };
        g.tickets.add(numeroVenta(v));
        g.unidades += v.cantidad;
        g.total += Number(v.total);
        mapa.set(llave, g);
      }
    }
    const conVentas = (g) => ({ ...g, ventas: g.tickets.size, tickets: undefined });
    const totalCOP = validas.reduce((s, v) => s + Number(v.total), 0);
    const conTasa = validas.filter((v) => v.tasa_usd);
    const unDia = desde === hasta;
    const dias = Math.round((aFecha(hasta) - aFecha(desde)) / 86400000) + 1;
    return {
      desde,
      hasta,
      unDia,
      dias,
      fecha: desde,
      fechaLarga: fmtDiaLargo.format(aFecha(desde)),
      periodoTexto: unDia
        ? fmtDiaLargo.format(aFecha(desde))
        : `del ${fmtFechaCorta.format(aFecha(desde))} al ${fmtFechaCorta.format(aFecha(hasta))} (${dias} días)`,
      generadoEn: new Date(),
      generadoPor: $('#usuario-nombre').textContent,
      ventas,
      totalCOP,
      // Cada venta se convierte con la tasa que había cuando se hizo.
      totalUSD: conTasa.length ? conTasa.reduce((s, v) => s + Number(v.total) / Number(v.tasa_usd), 0) : null,
      ventasSinTasa: validas.length - conTasa.length,
      numVentas: new Set(validas.map(numeroVenta)).size,
      numAnuladas: ventas.length - validas.length,
      unidades: validas.reduce((s, v) => s + v.cantidad, 0),
      porProducto: [...porProducto.values()].sort((a, b) => b.unidades - a.unidades || b.total - a.total),
      porVendedor: [...porVendedor.values()].map(conVentas).sort((a, b) => b.total - a.total),
      porDia: [...porDia.values()].map(conVentas).sort((a, b) => a.fecha.localeCompare(b.fecha)),
      movimientos,      // entradas, salidas y anulaciones (las ventas ya están arriba)
      cambiosPrecio,
      porAgotarse,
      stockBajo: STOCK_BAJO,
      tasaActual: estado.tasa,
    };
  }

  async function cargarCierre() {
    const periodo = periodoReporte();
    const [inicio] = rangoDelDia(periodo.desde);
    const [, fin] = rangoDelDia(periodo.hasta);
    const esta = ++numeroCierre;
    $('#cierre-subtitulo').textContent = 'Cargando…';
    try {
      const [ventas, porAgotarse, movimientos, cambiosPrecio] = await Promise.all([
        traerTodo(() => db.from('ventas').select('*')
          .gte('vendido_en', inicio).lt('vendido_en', fin).order('vendido_en', { ascending: false }).order('id')),
        traerTodo(() => db.from('productos').select('id, codigo, nombre, cantidad')
          .lte('cantidad', STOCK_BAJO).order('cantidad').order('nombre')),
        traerTodo(() => db.from('movimientos').select('*').neq('tipo', 'venta')
          .gte('creado_en', inicio).lt('creado_en', fin).order('creado_en', { ascending: false })),
        traerTodo(() => db.from('historial_precios').select('*').neq('origen', 'creacion')
          .gte('creado_en', inicio).lt('creado_en', fin).order('creado_en', { ascending: false })),
      ]);
      if (esta !== numeroCierre) return;   // se pidió otro periodo mientras tanto
      cierre = resumirCierre(periodo, ventas, porAgotarse, movimientos, cambiosPrecio);
      pintarCierre();
    } catch (error) {
      if (esta !== numeroCierre) return;
      $('#cierre-subtitulo').textContent = '';
      toast(`No se pudo cargar el reporte: ${error.message}`, 'error');
    }
  }

  function celda(texto, clase) {
    return el('td', clase ? { class: clase } : {}, texto);
  }

  function pintarCierre() {
    const c = cierre;
    const hoy = hoyEnZona();
    // Un solo día: hora. Varios días: día y hora.
    const cuando = (iso) => (c.unDia ? fmtHora.format(new Date(iso))
      : `${fmtDiaCorto.format(aFecha(diaEnZona(iso)))} ${fmtHora.format(new Date(iso))}`);

    $('#cierre-titulo').textContent = c.unDia ? 'Cierre del día' : 'Reporte de ventas';
    $('#cierre-subtitulo').textContent =
      `${c.periodoTexto}${c.unDia && c.desde === hoy ? ' (hoy)' : ''} · actualizado ${fmtHora.format(c.generadoEn)}`;

    $('#kpi-total').textContent = fmtCOP.format(c.totalCOP);
    $('#kpi-total-usd').textContent = c.totalUSD != null ? `≈ ${fmtUSD.format(c.totalUSD)}` : '';
    $('#kpi-ventas').textContent = fmtNumero.format(c.numVentas);
    $('#kpi-anuladas').textContent = c.numAnuladas
      ? `${c.numAnuladas} ${c.numAnuladas === 1 ? 'línea anulada' : 'líneas anuladas'}` : 'Ninguna anulada';
    $('#kpi-unidades').textContent = fmtNumero.format(c.unidades);
    $('#kpi-productos').textContent = c.porProducto.length === 1
      ? 'De 1 producto' : `De ${c.porProducto.length} productos`;
    const agotados = c.porAgotarse.filter((p) => p.cantidad <= 0).length;
    $('#kpi-agotarse').textContent = fmtNumero.format(c.porAgotarse.length);
    $('#kpi-agotados').textContent = agotados ? `${agotados} ya ${agotados === 1 ? 'agotado' : 'agotados'}` : 'Ninguno agotado';
    $('#umbral-agotarse').textContent = fmtNumero.format(c.stockBajo);

    $('#tarjeta-por-dia').hidden = c.unDia;
    $('#tabla-por-dia').replaceChildren(...c.porDia.map((d) => el('tr', {},
      celda(fmtDiaLargo.format(aFecha(d.fecha))),
      celda(fmtNumero.format(d.ventas), 'num'),
      celda(fmtNumero.format(d.unidades), 'num'),
      celda(fmtCOP.format(d.total), 'num'),
    )));

    $('#tabla-top').replaceChildren(...c.porProducto.map((p) => el('tr', {},
      celda(p.codigo ? el('span', { class: 'codigo codigo-sm' }, p.codigo) : '—'),
      celda(p.nombre),
      celda(fmtNumero.format(p.unidades), 'num'),
      celda(fmtCOP.format(p.total), 'num'),
    )));
    $('#vacio-top').hidden = c.porProducto.length > 0;

    $('#tabla-vendedores').replaceChildren(...c.porVendedor.map((v) => el('tr', {},
      celda(v.vendedor),
      celda(fmtNumero.format(v.ventas), 'num'),
      celda(fmtNumero.format(v.unidades), 'num'),
      celda(fmtCOP.format(v.total), 'num'),
    )));
    $('#vacio-vendedores').hidden = c.porVendedor.length > 0;

    $('#tabla-movimientos').replaceChildren(...c.movimientos.map((m) => el('tr', {},
      celda(cuando(m.creado_en), 'nowrap'),
      celda(el('div', {}, m.codigo ? el('span', { class: 'codigo codigo-sm' }, m.codigo) : null, ` ${m.nombre}`)),
      celda(el('span', { class: `mov mov-${m.tipo}` }, `${m.tipo === 'salida' ? '−' : '+'}${fmtNumero.format(m.cantidad)}`), 'num'),
      celda(`${m.tipo === 'anulacion' ? 'Venta anulada' : m.motivo} · ${m.stock_antes ?? '—'} → ${m.stock_despues ?? '—'}`),
    )));
    $('#vacio-movimientos').hidden = c.movimientos.length > 0;

    $('#tabla-precios').replaceChildren(...c.cambiosPrecio.map((h) => el('tr', {},
      celda(cuando(h.creado_en), 'nowrap'),
      celda(el('div', {}, h.codigo ? el('span', { class: 'codigo codigo-sm' }, h.codigo) : null, ` ${h.nombre}`)),
      celda(h.precio_anterior == null ? '—' : fmtCOP.format(h.precio_anterior), 'num'),
      celda(el('strong', {}, fmtCOP.format(h.precio_nuevo)), 'num'),
      celda(`${h.usuario || '—'}${h.origen === 'importacion' ? ' (Excel)' : ''}`),
    )));
    $('#vacio-precios').hidden = c.cambiosPrecio.length > 0;

    $('#tabla-agotarse').replaceChildren(...c.porAgotarse.map((p) => el('tr', {},
      celda(p.codigo ? el('span', { class: 'codigo codigo-sm' }, p.codigo) : '—'),
      celda(p.nombre),
      celda(etiquetaCantidad(p.cantidad), 'num'),
    )));
    $('#vacio-agotarse').hidden = c.porAgotarse.length > 0;

    $('#tabla-ventas').replaceChildren(...c.ventas.map((v) => el('tr', v.anulada_en ? { class: 'anulada' } : {},
      celda(v.ticket ? `#${v.ticket}` : '—', 'nowrap'),
      celda(cuando(v.vendido_en), 'nowrap'),
      celda(v.codigo ? el('span', { class: 'codigo codigo-sm' }, v.codigo) : '—'),
      celda(v.nombre),
      celda(fmtNumero.format(v.cantidad), 'num'),
      celda(fmtCOP.format(v.precio_unitario), 'num'),
      celda(fmtCOP.format(v.total), 'num'),
      celda(v.vendedor || '—'),
      v.anulada_en
        ? celda(el('span', { class: 'etiqueta-anulada' }, 'Anulada'), 'col-acciones')
        : celda(el('button', { type: 'button', class: 'btn btn-peligro-suave btn-sm', onclick: () => abrirAnular(v) }, 'Anular'), 'col-acciones'),
    )));
    $('#vacio-ventas').hidden = c.ventas.length > 0;
  }

  function abrirAnular(v) {
    ventaAnulando = v;
    $('#form-anular').reset();
    mostrarError('#anular-error', '');
    $('#anular-detalle').textContent = `${v.cantidad} × ${v.nombre} (${fmtCOP.format(v.total)})${v.ticket ? ` de la venta #${v.ticket}` : ''}, ${fmtFecha.format(new Date(v.vendido_en))}`;
    $('#dlg-anular').showModal();
    // El jefe no teclea clave (con su usuario ya está autorizado).
    (esJefe() ? $('#form-anular [type="submit"]') : $('#form-anular').clave).focus();
  }

  // Anular devuelve unidades al inventario: necesita la clave del jefe.
  $('#form-anular').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!esJefe() && !form.clave.value) return mostrarError('#anular-error', 'Falta la clave del jefe.');
    conBotonOcupado(form, async () => {
      const r = await llamar('anular_venta', { p_venta_id: ventaAnulando.id, p_clave_jefe: form.clave.value });
      form.clave.value = '';
      if (!r.ok) {
        mostrarError('#anular-error', r.error);
        form.clave.focus();
        return;
      }
      $('#dlg-anular').close();
      toast('Venta anulada: las unidades volvieron al inventario');
      cargarCierre();
      buscar(estado.busqueda);
    });
  });

  // Descargas: Excel incluye además el inventario completo.
  async function exportar(boton, tipo) {
    if (!cierre) return;
    const texto = boton.textContent;
    boton.disabled = true;
    boton.textContent = 'Preparando…';
    try {
      if (tipo === 'excel') {
        const inventario = await traerTodo(() => db.from('productos')
          .select('codigo, nombre, descripcion, cantidad, precio_cop').order('nombre'));
        await window.Exportar.excel(cierre, inventario);
      } else {
        await window.Exportar.pdf(cierre);
      }
    } catch (error) {
      toast(`No se pudo generar el archivo: ${error.message}`, 'error');
    } finally {
      boton.disabled = false;
      boton.textContent = texto;
    }
  }

  $('#btn-excel').addEventListener('click', (e) => exportar(e.currentTarget, 'excel'));
  $('#btn-pdf').addEventListener('click', (e) => exportar(e.currentTarget, 'pdf'));

  // Botones "Cancelar" de todos los diálogos
  document.querySelectorAll('[data-cerrar]').forEach((boton) => {
    boton.addEventListener('click', () => boton.closest('dialog').close());
  });

  iniciar();
})();
