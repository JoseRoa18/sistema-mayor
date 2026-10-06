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
      Object.assign(estado, { perfil: null, tasa: null, productos: [], busqueda: '' });
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
      if (!$('#cierre-fecha').value) $('#cierre-fecha').value = hoyEnZona();
      cargarCierre();
      // Mientras el panel de hoy esté abierto, se actualiza solo cada minuto.
      temporizadorCierre = setInterval(() => {
        if (!document.hidden && $('#cierre-fecha').value === hoyEnZona()) cargarCierre();
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
      .from('configuracion').select('tasa_usd, actualizado_en').eq('id', 1).single();
    if (error) { toast('No se pudo cargar la tasa del dólar.', 'error'); return; }

    estado.tasa = data.tasa_usd ? Number(data.tasa_usd) : null;
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
    pintarProductos();
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
        p.cantidad > 0
          ? el('button', { type: 'button', class: 'btn btn-primario btn-sm btn-vender', onclick: () => abrirVenta(p) }, 'Vender')
          : el('button', { type: 'button', class: 'btn btn-secundario btn-sm btn-vender', disabled: '' }, 'Agotado'),
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

    conBotonOcupado(form, async () => {
      const consulta = productoEditando
        ? db.from('productos').update(datos).eq('id', productoEditando.id)
        : db.from('productos').insert(datos);
      const { data, error } = await consulta.select('id');

      if (error?.code === '23505') {
        mostrarError('#producto-error', `Ya existe otro producto con el código ${datos.codigo}.`);
        return;
      }
      if (error || !data.length) {
        mostrarError('#producto-error', error ? error.message : 'No tienes permiso para modificar productos.');
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
  // Ventas: el vendedor marca un producto como vendido
  // ------------------------------------------------------------------

  let productoVendiendo = null;

  function cantidadVenta() {
    const n = Number($('#form-vender').cantidad.value);
    return Number.isInteger(n) ? n : NaN;
  }

  function actualizarTotalVenta() {
    const p = productoVendiendo;
    const n = cantidadVenta();
    const valida = n >= 1 && n <= p.cantidad;
    $('#venta-unitario').textContent = fmtCOP.format(p.precio_cop);
    $('#venta-total').textContent = valida ? fmtCOP.format(p.precio_cop * n) : '—';
    $('#venta-total-usd').textContent = valida && estado.tasa ? enDolares(p.precio_cop * n) : '';
  }

  function abrirVenta(p) {
    productoVendiendo = p;
    const form = $('#form-vender');
    $('#venta-codigo').textContent = p.codigo || 'Sin código';
    $('#venta-nombre').textContent = p.nombre;
    $('#venta-disponible').textContent = `Disponibles: ${fmtNumero.format(p.cantidad)}`;
    form.cantidad.max = p.cantidad;
    form.cantidad.value = 1;
    form.vendedor.value = '';
    mostrarError('#vender-error', '');
    actualizarTotalVenta();
    $('#dlg-vender').showModal();
    form.cantidad.select();
  }

  $('#form-vender').cantidad.addEventListener('input', actualizarTotalVenta);

  document.querySelectorAll('#form-vender [data-paso]').forEach((boton) => {
    boton.addEventListener('click', () => {
      const actual = cantidadVenta() || 0;
      const nueva = Math.min(Math.max(actual + Number(boton.dataset.paso), 1), productoVendiendo.cantidad);
      $('#form-vender').cantidad.value = nueva;
      actualizarTotalVenta();
    });
  });

  $('#form-vender').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = productoVendiendo;
    const n = cantidadVenta();
    const form = e.currentTarget;
    if (!(n >= 1)) return mostrarError('#vender-error', 'La cantidad debe ser un número entero, 1 o mayor.');
    if (n > p.cantidad) return mostrarError('#vender-error', `Solo hay ${fmtNumero.format(p.cantidad)} disponibles.`);
    if (!form.vendedor.value.trim()) {
      form.vendedor.focus();
      return mostrarError('#vender-error', 'Escribe tu código de vendedor.');
    }

    conBotonOcupado(form, async () => {
      const r = await llamar('registrar_venta', {
        p_producto_id: p.id, p_cantidad: n, p_codigo_vendedor: form.vendedor.value.trim(),
      });
      if (!r.ok) {
        mostrarError('#vender-error', r.error);
        if (r.campo === 'codigo') form.vendedor.select();
        if (r.stock != null) buscar(estado.busqueda);   // alguien más vendió: refrescar
        return;
      }
      const venta = r.venta;
      $('#dlg-vender').close();
      toast(`Venta registrada (${venta.vendedor}): ${venta.cantidad} × ${venta.nombre} · ${fmtCOP.format(venta.total)}`);
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
  // Configuración (solo el jefe): vendedores y clave del jefe
  // ------------------------------------------------------------------

  let vendedorEditando = null;

  async function cargarConfiguracion() {
    const r = await llamar('config_estado', {});
    if (!r.ok) { toast(`No se pudo cargar la configuración: ${r.error}`, 'error'); return; }
    pintarVendedores(r.vendedores);
    pintarEstadoClave(r.clave_definida);
    editarVendedor(null);
  }

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
  // Cierre del día (solo administrador)
  // ------------------------------------------------------------------

  let cierre = null;          // datos del día mostrado, también se usan para exportar
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

  function resumirCierre(fecha, ventas, porAgotarse, movimientos) {
    const validas = ventas.filter((v) => !v.anulada_en);
    const porProducto = new Map();
    const porVendedor = new Map();
    for (const v of validas) {
      const clave = v.producto_id ?? `${v.codigo}|${v.nombre}`;
      const fila = porProducto.get(clave) || { codigo: v.codigo, nombre: v.nombre, unidades: 0, total: 0 };
      fila.unidades += v.cantidad;
      fila.total += Number(v.total);
      porProducto.set(clave, fila);

      const nombre = v.vendedor || 'Sin vendedor';
      const vend = porVendedor.get(nombre) || { vendedor: nombre, ventas: 0, unidades: 0, total: 0 };
      vend.ventas += 1;
      vend.unidades += v.cantidad;
      vend.total += Number(v.total);
      porVendedor.set(nombre, vend);
    }
    const totalCOP = validas.reduce((s, v) => s + Number(v.total), 0);
    const conTasa = validas.filter((v) => v.tasa_usd);
    return {
      fecha,
      fechaLarga: fmtDiaLargo.format(new Date(`${fecha}T00:00:00Z`)),
      generadoEn: new Date(),
      generadoPor: $('#usuario-nombre').textContent,
      ventas,
      totalCOP,
      // Cada venta se convierte con la tasa que había cuando se hizo.
      totalUSD: conTasa.length ? conTasa.reduce((s, v) => s + Number(v.total) / Number(v.tasa_usd), 0) : null,
      ventasSinTasa: validas.length - conTasa.length,
      numVentas: validas.length,
      numAnuladas: ventas.length - validas.length,
      unidades: validas.reduce((s, v) => s + v.cantidad, 0),
      porProducto: [...porProducto.values()].sort((a, b) => b.unidades - a.unidades || b.total - a.total),
      porVendedor: [...porVendedor.values()].sort((a, b) => b.total - a.total),
      movimientos,   // entradas, salidas y anulaciones del día (las ventas ya están arriba)
      porAgotarse,
      stockBajo: STOCK_BAJO,
      tasaActual: estado.tasa,
    };
  }

  async function cargarCierre() {
    const fecha = $('#cierre-fecha').value || hoyEnZona();
    const [inicio, fin] = rangoDelDia(fecha);
    const esta = ++numeroCierre;
    $('#cierre-subtitulo').textContent = 'Cargando…';
    try {
      const [ventas, porAgotarse, movimientos] = await Promise.all([
        traerTodo(() => db.from('ventas').select('*')
          .gte('vendido_en', inicio).lt('vendido_en', fin).order('vendido_en', { ascending: false })),
        traerTodo(() => db.from('productos').select('id, codigo, nombre, cantidad')
          .lte('cantidad', STOCK_BAJO).order('cantidad').order('nombre')),
        traerTodo(() => db.from('movimientos').select('*').neq('tipo', 'venta')
          .gte('creado_en', inicio).lt('creado_en', fin).order('creado_en', { ascending: false })),
      ]);
      if (esta !== numeroCierre) return;   // se pidió otra fecha mientras tanto
      cierre = resumirCierre(fecha, ventas, porAgotarse, movimientos);
      pintarCierre();
    } catch (error) {
      if (esta !== numeroCierre) return;
      $('#cierre-subtitulo').textContent = '';
      toast(`No se pudo cargar el cierre: ${error.message}`, 'error');
    }
  }

  function celda(texto, clase) {
    return el('td', clase ? { class: clase } : {}, texto);
  }

  function pintarCierre() {
    const c = cierre;
    const esHoy = c.fecha === hoyEnZona();
    $('#cierre-subtitulo').textContent =
      `${c.fechaLarga}${esHoy ? ' (hoy)' : ''} · actualizado ${fmtHora.format(c.generadoEn)}`;

    $('#kpi-total').textContent = fmtCOP.format(c.totalCOP);
    $('#kpi-total-usd').textContent = c.totalUSD != null ? `≈ ${fmtUSD.format(c.totalUSD)}` : '';
    $('#kpi-ventas').textContent = fmtNumero.format(c.numVentas);
    $('#kpi-anuladas').textContent = c.numAnuladas
      ? `${c.numAnuladas} ${c.numAnuladas === 1 ? 'anulada' : 'anuladas'}` : 'Ninguna anulada';
    $('#kpi-unidades').textContent = fmtNumero.format(c.unidades);
    $('#kpi-productos').textContent = c.porProducto.length === 1
      ? 'De 1 producto' : `De ${c.porProducto.length} productos`;
    const agotados = c.porAgotarse.filter((p) => p.cantidad <= 0).length;
    $('#kpi-agotarse').textContent = fmtNumero.format(c.porAgotarse.length);
    $('#kpi-agotados').textContent = agotados ? `${agotados} ya ${agotados === 1 ? 'agotado' : 'agotados'}` : 'Ninguno agotado';
    $('#umbral-agotarse').textContent = fmtNumero.format(c.stockBajo);

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
      celda(fmtHora.format(new Date(m.creado_en)), 'nowrap'),
      celda(el('div', {}, m.codigo ? el('span', { class: 'codigo codigo-sm' }, m.codigo) : null, ` ${m.nombre}`)),
      celda(el('span', { class: `mov mov-${m.tipo}` }, `${m.tipo === 'salida' ? '−' : '+'}${fmtNumero.format(m.cantidad)}`), 'num'),
      celda(`${m.tipo === 'anulacion' ? 'Venta anulada' : m.motivo} · ${m.stock_antes ?? '—'} → ${m.stock_despues ?? '—'}`),
    )));
    $('#vacio-movimientos').hidden = c.movimientos.length > 0;

    $('#tabla-agotarse').replaceChildren(...c.porAgotarse.map((p) => el('tr', {},
      celda(p.codigo ? el('span', { class: 'codigo codigo-sm' }, p.codigo) : '—'),
      celda(p.nombre),
      celda(etiquetaCantidad(p.cantidad), 'num'),
    )));
    $('#vacio-agotarse').hidden = c.porAgotarse.length > 0;

    $('#tabla-ventas').replaceChildren(...c.ventas.map((v) => el('tr', v.anulada_en ? { class: 'anulada' } : {},
      celda(fmtHora.format(new Date(v.vendido_en)), 'nowrap'),
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

  $('#cierre-fecha').addEventListener('change', cargarCierre);
  $('#btn-actualizar').addEventListener('click', cargarCierre);

  function abrirAnular(v) {
    ventaAnulando = v;
    $('#form-anular').reset();
    mostrarError('#anular-error', '');
    $('#anular-detalle').textContent = `${v.cantidad} × ${v.nombre} (${fmtCOP.format(v.total)}) de las ${fmtHora.format(new Date(v.vendido_en))}`;
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
