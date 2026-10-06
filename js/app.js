'use strict';

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, DOMINIO_USUARIOS, STOCK_BAJO } = window.CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const $ = (selector) => document.querySelector(selector);

  const estado = {
    perfil: null,     // { rol }
    tasa: null,       // pesos por 1 USD, o null si no está definida
    productos: [],
    busqueda: '',
  };

  // ------------------------------------------------------------------
  // Formatos (Colombia)
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
  const fmtFecha = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

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
    $('#usuario-rol').textContent = perfil.rol === 'admin' ? 'Administrador' : 'Atención al público';

    mostrarVista('app');
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
      mostrarVista('login');
    }
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
    const esAdmin = estado.perfil?.rol === 'admin';
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
      esAdmin
        ? el('td', { class: 'col-acciones' },
            el('button', { type: 'button', class: 'btn btn-secundario btn-sm', onclick: () => abrirProducto(p) }, 'Editar'),
            el('button', { type: 'button', class: 'btn btn-peligro-suave btn-sm', onclick: () => abrirEliminar(p) }, 'Eliminar'))
        : null,
    );
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
      form.cantidad.value = p.cantidad;
      form.precio_cop.value = fmtNumero.format(p.precio_cop);
    }
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
      cantidad: Number(form.cantidad.value),
      precio_cop: leerNumero(form.precio_cop.value),
    };

    if (!datos.codigo) return mostrarError('#producto-error', 'El código es obligatorio.');
    if (!datos.nombre) return mostrarError('#producto-error', 'El nombre es obligatorio.');
    if (form.cantidad.value === '' || !Number.isInteger(datos.cantidad) || datos.cantidad < 0) {
      return mostrarError('#producto-error', 'La cantidad debe ser un número entero, 0 o mayor.');
    }
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

  function abrirEliminar(p) {
    productoEliminando = p;
    $('#eliminar-nombre').textContent = p.nombre;
    $('#dlg-eliminar').showModal();
  }

  $('#form-eliminar').addEventListener('submit', (e) => {
    e.preventDefault();
    conBotonOcupado(e.currentTarget, async () => {
      const { data, error } = await db
        .from('productos').delete().eq('id', productoEliminando.id).select('id');
      $('#dlg-eliminar').close();
      if (error || !data.length) {
        toast(error ? error.message : 'No tienes permiso para eliminar productos.', 'error');
        return;
      }
      toast('Producto eliminado');
      buscar(estado.busqueda);
    });
  });

  // Botones "Cancelar" de todos los diálogos
  document.querySelectorAll('[data-cerrar]').forEach((boton) => {
    boton.addEventListener('click', () => boton.closest('dialog').close());
  });

  iniciar();
})();
