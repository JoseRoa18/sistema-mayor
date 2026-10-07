'use strict';

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY, DOMINIO_USUARIOS, STOCK_BAJO, ZONA_HORARIA: ZONA } = window.CONFIG;
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const $ = (selector) => document.querySelector(selector);

  const estado = {
    perfil: null,     // { rol }
    tasa: null,       // pesos por 1 USD, o null si no está definida
    productos: [],                // los de la página que se ve
    resultados: [],               // todo lo que coincide con la búsqueda
    pagina: 1,
    busqueda: '',
    carrito: new Map(),           // producto_id → { producto, cantidad }
    precioRequiereClave: true,    // lo decide el jefe en Configuración
    categoria: '',                // filtro del inventario ('' = todas)
    categorias: [],               // [{ prefijo, nombre }]
    estadoDia: null,              // { fecha, hoy, cerrado, cerrado_por, cerrado_en }
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

  // Mensaje de error de un formulario. Con `campo` (su nombre o el elemento), ese campo queda
  // marcado (borde rojo, aria-invalid) y enlazado al mensaje para los lectores de pantalla.
  // Las funciones de la base dicen qué campo falló en `campo`; "codigo" en el carrito es el del vendedor.
  const ALIAS_CAMPO = { precio: 'precio_cop', codigo: 'vendedor' };
  function mostrarError(selector, mensaje, campo = null) {
    const nodo = $(selector);
    nodo.textContent = mensaje || '';
    nodo.hidden = !mensaje;
    const contenedor = nodo.closest('form') || nodo.closest('dialog');
    contenedor?.querySelectorAll('[aria-invalid="true"]').forEach(desmarcarCampo);
    if (!mensaje || !campo || !contenedor) return;
    const elemento = typeof campo === 'string'
      ? contenedor.querySelector(`[name="${campo}"]`) || contenedor.querySelector(`[name="${ALIAS_CAMPO[campo]}"]`)
      : campo;
    if (!elemento) return;
    elemento.setAttribute('aria-invalid', 'true');
    elemento.setAttribute('aria-describedby', nodo.id);
  }

  function desmarcarCampo(elemento) {
    elemento.removeAttribute('aria-invalid');
    if (elemento.getAttribute('aria-describedby')?.endsWith('-error')) elemento.removeAttribute('aria-describedby');
  }

  // Al corregir el campo deja de verse como erróneo.
  document.addEventListener('input', (e) => {
    if (e.target.getAttribute?.('aria-invalid') === 'true') desmarcarCampo(e.target);
  });

  let temporizadorToast;
  // Aviso flotante. Puede llevar un botón (accion = { texto, alHacer }), por ejemplo "Imprimir ticket".
  function toast(mensaje, tipo = 'ok', accion = null) {
    const nodo = $('#toast');
    // (replaceChildren escribiría "null": por eso se filtran los vacíos)
    nodo.replaceChildren(...[el('span', {}, mensaje), accion
      ? el('button', { type: 'button', class: 'toast-accion', onclick: () => { ocultarToast(); accion.alHacer(); } }, accion.texto)
      : null].filter(Boolean));
    nodo.dataset.tipo = tipo;
    nodo.hidden = false;
    // En la capa superior: así se ve también encima de un diálogo abierto.
    if (nodo.showPopover) {
      try { nodo.hidePopover(); } catch { /* no estaba visible */ }
      nodo.showPopover();
    }
    clearTimeout(temporizadorToast);
    temporizadorToast = setTimeout(ocultarToast, accion ? 10000 : 3500);
  }

  function ocultarToast() {
    const nodo = $('#toast');
    nodo.hidden = true;
    try { nodo.hidePopover?.(); } catch { /* ya estaba oculto */ }
  }

  async function conBotonOcupado(form, accion) {
    const boton = form.querySelector('[type="submit"]');
    boton.disabled = true;
    boton.setAttribute('aria-busy', 'true');   // muestra el indicador de "trabajando"
    try { await accion(); } finally { boton.disabled = false; boton.removeAttribute('aria-busy'); }
  }

  // Avisos solo para lectores de pantalla (sin mover el foco): producto agregado, resultados…
  function anunciar(texto) {
    const nodo = $('#anuncio');
    nodo.textContent = '';
    setTimeout(() => { nodo.textContent = texto; }, 60);   // vaciar y escribir: se repite aunque sea igual
  }

  // Cada ventana se anuncia con su título.
  document.querySelectorAll('dialog').forEach((d) => {
    if (d.hasAttribute('aria-labelledby') || d.hasAttribute('aria-label')) return;
    const titulo = d.querySelector('h2');
    if (!titulo) return;
    titulo.id ||= `${d.id}-titulo`;
    d.setAttribute('aria-labelledby', titulo.id);
  });

  // Mostrar u ocultar la contraseña al iniciar sesión.
  $('#btn-ver-clave').addEventListener('click', (e) => {
    const campo = $('#form-login').clave;
    const ver = campo.type === 'password';
    campo.type = ver ? 'text' : 'password';
    e.currentTarget.textContent = ver ? 'Ocultar' : 'Mostrar';
    e.currentTarget.setAttribute('aria-pressed', String(ver));
    campo.focus();
  });

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
    const seccion = seccionDelEnlace();
    mostrarSeccion(seccion);
    // El cursor va al buscador de una vez (no al terminar de cargar: para entonces la persona
    // puede estar usando otro botón y se lo quitaría).
    if (seccion === 'inventario') $('#buscar').focus();
    // La impresora de este equipo se reconecta sola (sin abrir la lista) si el navegador lo permite.
    if (window.Impresora?.ajustes().id) window.Impresora.reconectar();
    iniciarSincronizacion();
    await Promise.all([cargarTasa(), cargarCategorias(), cargarEstadoDia(), cargarInventario()]);
  }

  $('#form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const usuario = form.usuario.value.trim().toLowerCase();
    const clave = form.clave.value;
    mostrarError('#login-error', '');

    if (!usuario || !clave) {
      const falta = usuario ? form.clave : form.usuario;
      falta.focus();
      mostrarError('#login-error', 'Escribe tu usuario y contraseña.', falta);
      return;
    }

    conBotonOcupado(form, async () => {
      const email = usuario.includes('@') ? usuario : `${usuario}@${DOMINIO_USUARIOS}`;
      const { error } = await db.auth.signInWithPassword({ email, password: clave });
      if (error) {
        const credenciales = error.message === 'Invalid login credentials';
        mostrarError('#login-error', credenciales
          ? 'Usuario o contraseña incorrectos. Revisa los dos y vuelve a intentar.'
          : `No se pudo iniciar sesión: ${error.message}. Revisa la conexión a internet y vuelve a intentar.`,
        credenciales ? form.clave : null);
        if (credenciales) form.clave.select();
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
      Object.assign(estado, { perfil: null, tasa: null, productos: [], resultados: [], pagina: 1, busqueda: '', carrito: new Map(), categoria: '', estadoDia: null });
      clearInterval(temporizadorInventario);
      Object.assign(inventario, { porId: new Map(), normal: new Map(), listo: false, cursor: null });
      $('#filtro-categoria').value = '';
      $('#aviso-dia-cerrado').hidden = true;
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

  const ENLACE_SECCION = { inventario: '', cierre: 'reportes', administracion: 'administracion', configuracion: 'configuracion' };

  // Sección pedida en el enlace (#reportes…), si este usuario la puede ver.
  function seccionDelEnlace() {
    const pedida = Object.keys(ENLACE_SECCION).find((k) => ENLACE_SECCION[k] && `#${ENLACE_SECCION[k]}` === location.hash);
    const pestana = pedida && document.querySelector(`.pestana[data-seccion="${pedida}"]`);
    return pestana && getComputedStyle(pestana).display !== 'none' ? pedida : 'inventario';
  }

  function mostrarSeccion(nombre, { enfocar = false } = {}) {
    for (const s of ['inventario', 'cierre', 'administracion', 'configuracion']) $(`#seccion-${s}`).hidden = nombre !== s;
    history.replaceState(null, '', ENLACE_SECCION[nombre] ? `#${ENLACE_SECCION[nombre]}` : location.pathname + location.search);
    if (enfocar) {
      if (nombre === 'inventario') $('#buscar').focus();
      else {
        const titulo = $(`#seccion-${nombre} h1`);
        titulo.tabIndex = -1;
        titulo.focus({ preventScroll: true });
      }
    }
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
    if (nombre === 'administracion') {
      cargarTickets();
      temporizadorCierre = setInterval(() => { if (!document.hidden) cargarTickets(); }, 60000);
    }
  }

  document.querySelectorAll('.pestana').forEach((p) => {
    p.addEventListener('click', () => mostrarSeccion(p.dataset.seccion, { enfocar: true }));
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
    // Solo se recalcula la columna en dólares: la lista no se redibuja, así no se pierde un toque
    // que llegue justo cuando carga la tasa.
    document.querySelectorAll('#tabla-cuerpo .precio-usd').forEach((td) => { td.textContent = enDolares(td.dataset.cop); });
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
  // Productos: búsqueda instantánea y paginación
  // ------------------------------------------------------------------
  // El inventario se carga una vez al entrar y se busca en este equipo, sin esperar al
  // servidor en cada tecla. Cada pocos segundos se traen solo los productos que cambiaron
  // (existencias y precios que mueven los demás usuarios).

  const POR_PAGINA = 10;
  const SINCRONIZAR_CADA = 15000;      // cada cuánto se traen los cambios de los demás usuarios
  const inventario = { porId: new Map(), normal: new Map(), listo: false, cursor: null };
  let numeroConsulta = 0;              // descarta respuestas que lleguen de una sesión anterior
  let temporizadorInventario;
  const ordenNombres = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

  // Texto para comparar: sin mayúsculas, tildes ni guiones ("v3013" encuentra "V-3013").
  const normalizar = (texto) => sinTildes(texto ?? '').replace(/[-–—]/g, '');

  function guardarEnInventario(p) {
    inventario.porId.set(p.id, p);
    inventario.normal.set(p.id, {
      codigo: normalizar(p.codigo),
      texto: normalizar(`${p.codigo || ''} ${p.nombre} ${p.descripcion || ''} ${p.categoria || ''}`),
    });
  }

  // La base responde con los productos (todos, o los que cambiaron desde `desde`), la hora del
  // servidor y el total. La siguiente consulta parte de esa hora, con 5 segundos de margen por
  // si algo se estaba guardando justo en ese momento.
  async function pedirInventario(desde) {
    const { data, error } = await db.rpc('productos_cambiados', { p_desde: desde });
    if (error) throw error;
    inventario.cursor = new Date(Date.parse(data.ahora) - 5000).toISOString();
    return data;
  }

  let cargandoInventario = null;
  function cargarInventario() {
    cargandoInventario ||= (async () => {
      const esta = numeroConsulta;
      try {
        const r = await pedirInventario(null);
        if (esta !== numeroConsulta) return;
        inventario.porId = new Map();
        inventario.normal = new Map();
        r.productos.forEach(guardarEnInventario);
        inventario.listo = true;
        aplicarBusqueda({ conservarPagina: true });
      } catch {
        if (esta === numeroConsulta) toast('No se pudieron cargar los productos. Revisa la conexión a internet.', 'error');
      }
    })().finally(() => { cargandoInventario = null; });
    return cargandoInventario;
  }

  // Solo lo que cambió. Si el total no coincide (se eliminó algún producto), se recarga todo.
  async function traerCambios() {
    const esta = numeroConsulta;
    const r = await pedirInventario(inventario.cursor);
    if (esta !== numeroConsulta) return;
    let hubo = false;
    for (const p of r.productos) {
      if (inventario.porId.get(p.id)?.actualizado_en === p.actualizado_en) continue;
      guardarEnInventario(p);
      hubo = true;
    }
    if (r.total !== inventario.porId.size) { await cargarInventario(); return; }
    if (hubo) aplicarBusqueda({ conservarPagina: true });
  }

  let sincronizando = null;
  function sincronizarInventario() {
    if (!inventario.listo) return cargarInventario();
    if (!sincronizando) sincronizando = traerCambios().catch(() => {}).finally(() => { sincronizando = null; });
    return sincronizando;
  }

  function iniciarSincronizacion() {
    clearInterval(temporizadorInventario);
    temporizadorInventario = setInterval(() => { if (!document.hidden && estado.perfil) sincronizarInventario(); }, SINCRONIZAR_CADA);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && estado.perfil) sincronizarInventario();
  });

  // Coincidencias: todas las palabras deben aparecer en el código, nombre, descripción o
  // categoría. Primero el código exacto, luego los que empiezan por ese código, luego por nombre.
  function resultadosDe(texto, categoria) {
    const q = normalizar(texto);
    const palabras = q.split(/\s+/).filter(Boolean);
    const salida = [];
    for (const [id, p] of inventario.porId) {
      if (categoria && p.categoria !== categoria) continue;
      const n = inventario.normal.get(id);
      if (palabras.every((w) => n.texto.includes(w))) salida.push(p);
    }
    const rango = (p) => {
      if (!q) return 2;
      const c = inventario.normal.get(p.id).codigo;
      return c === q ? 0 : c && c.startsWith(q) ? 1 : 2;
    };
    return salida.sort((a, b) => rango(a) - rango(b) || ordenNombres.compare(a.nombre, b.nombre));
  }

  function aplicarBusqueda({ conservarPagina = false } = {}) {
    estado.resultados = inventario.listo ? resultadosDe(estado.busqueda, estado.categoria) : [];
    const paginas = Math.max(1, Math.ceil(estado.resultados.length / POR_PAGINA));
    estado.pagina = conservarPagina ? Math.min(estado.pagina, paginas) : 1;
    // Lo que está en el carrito se actualiza con la existencia y el precio más recientes.
    if (inventario.listo) {
      for (const [id, linea] of estado.carrito) {
        const p = inventario.porId.get(id);
        if (!p) { estado.carrito.delete(id); continue; }
        linea.producto = p;
        linea.cantidad = Math.min(linea.cantidad, p.cantidad);
        if (linea.cantidad <= 0) estado.carrito.delete(id);
      }
    }
    mostrarPagina();
  }

  function mostrarPagina() {
    const inicio = (estado.pagina - 1) * POR_PAGINA;
    estado.productos = estado.resultados.slice(inicio, inicio + POR_PAGINA);
    actualizarCarrito();   // repinta la lista (botones "Agregar") y la barra del carrito
  }

  let temporizadorAnuncio;
  function buscar(texto) {
    estado.busqueda = texto;
    aplicarBusqueda();
    clearTimeout(temporizadorAnuncio);
    temporizadorAnuncio = setTimeout(() => {
      const n = estado.resultados.length;
      anunciar(n ? (n === 1 ? '1 producto encontrado' : `${fmtNumero.format(n)} productos encontrados`) : 'No se encontraron productos');
    }, 800);
  }

  function irAPagina(n) {
    const paginas = Math.max(1, Math.ceil(estado.resultados.length / POR_PAGINA));
    const destino = Math.min(Math.max(1, n), paginas);
    if (destino === estado.pagina) return;
    estado.pagina = destino;
    mostrarPagina();
    // Si la tabla quedó arriba (fuera de la vista), se sube para ver la página desde el inicio.
    const tabla = $('.tabla-contenedor');
    if (tabla.getBoundingClientRect().top < 0) tabla.scrollIntoView({ block: 'start' });
  }

  // Números de página: siempre la primera y la última, y las vecinas de la actual
  // (1 … 4 5 6 … 32). Un solo número saltado se muestra en vez de "…".
  function numerosDePagina(actual, total) {
    const elegidas = new Set([1, total, actual - 1, actual, actual + 1]);
    if (actual <= 3) [2, 3, 4].forEach((n) => elegidas.add(n));
    if (actual >= total - 2) [total - 3, total - 2, total - 1].forEach((n) => elegidas.add(n));
    const lista = [...elegidas].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
    const salida = [];
    let anterior = 0;
    for (const n of lista) {
      if (n - anterior === 2) salida.push(anterior + 1);
      else if (n - anterior > 2) salida.push('…');
      salida.push(n);
      anterior = n;
    }
    return salida;
  }

  function pintarPaginacion(total) {
    const paginas = Math.ceil(total / POR_PAGINA);
    $('#paginacion').hidden = paginas <= 1;
    $('#paginacion-mini').hidden = paginas <= 1;   // flechas junto al conteo, para no bajar hasta el final
    if (paginas <= 1) return;
    $('#pagina-anterior').disabled = $('#mini-anterior').disabled = estado.pagina <= 1;
    $('#pagina-siguiente').disabled = $('#mini-siguiente').disabled = estado.pagina >= paginas;
    $('#pagina-texto').textContent = `Página ${estado.pagina} de ${paginas}`;
    $('#paginas').replaceChildren(...numerosDePagina(estado.pagina, paginas).map((n) => (n === '…'
      ? el('span', { class: 'pagina-salto', 'aria-hidden': 'true' }, '…')
      : el('button', {
        type: 'button',
        class: n === estado.pagina ? 'pagina actual' : 'pagina',
        'aria-label': `Página ${n}`,
        ...(n === estado.pagina ? { 'aria-current': 'page' } : {}),
        onclick: () => irAPagina(n),
      }, String(n)))));
  }

  $('#pagina-anterior').addEventListener('click', () => irAPagina(estado.pagina - 1));
  $('#pagina-siguiente').addEventListener('click', () => irAPagina(estado.pagina + 1));
  $('#mini-anterior').addEventListener('click', () => irAPagina(estado.pagina - 1));
  $('#mini-siguiente').addEventListener('click', () => irAPagina(estado.pagina + 1));

  // Categorías: llenan el filtro del inventario, el formulario y "Precios en bloque".
  // Color pastel de cada categoría: las cuatro de siempre tienen el suyo; las que cree el jefe
  // toman los que quedan, en orden.
  const COLOR_FIJO = { L: 'azul', R: 'cian', C: 'durazno', V: 'lila' };
  const COLORES_EXTRA = ['rosa', 'lima', 'indigo', 'piedra'];
  function colorDeCategoria(nombre, lista = estado.categorias) {
    const c = lista.find((x) => x.nombre === nombre);
    if (!c) return '';
    if (COLOR_FIJO[c.prefijo]) return COLOR_FIJO[c.prefijo];
    const extras = lista.filter((x) => !COLOR_FIJO[x.prefijo]);
    return COLORES_EXTRA[extras.indexOf(c) % COLORES_EXTRA.length];
  }

  async function cargarCategorias() {
    const { data, error } = await db.rpc('lista_categorias');
    if (error) return;
    estado.categorias = data;
    // Los productos ya dibujados toman su color sin redibujar la lista.
    document.querySelectorAll('#tabla-cuerpo .producto-categoria[data-categoria]').forEach((chip) => {
      chip.dataset.color = colorDeCategoria(chip.dataset.categoria);
    });
    const opciones = (primera) => [el('option', { value: '' }, primera),
      ...data.map((c) => el('option', { value: c.nombre }, `${c.prefijo} · ${c.nombre}`))];
    const filtro = $('#filtro-categoria');
    filtro.replaceChildren(...opciones('Todas las categorías'));
    filtro.value = data.some((c) => c.nombre === estado.categoria) ? estado.categoria : '';
    $('#form-producto').categoria.replaceChildren(...opciones('Elige la categoría…'));
    $('#precios-categoria').replaceChildren(...opciones('Todos los productos'));
  }

  const sinTildes = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Categoría a partir de lo escrito: el nombre (sin importar mayúsculas ni tildes) o la letra.
  function categoriaDeTexto(texto) {
    const t = sinTildes(texto);
    return estado.categorias.find((c) => sinTildes(c.nombre) === t || c.prefijo.toLowerCase() === t)?.nombre || null;
  }

  // Categoría que corresponde a la letra del código (L-2054 → Lavadora).
  function categoriaPorCodigo(codigo) {
    const letra = (String(codigo || '').toUpperCase().match(/^[A-Z]+/) || [''])[0];
    return estado.categorias.find((c) => c.prefijo === letra)?.nombre || '';
  }

  $('#filtro-categoria').addEventListener('change', (e) => {
    estado.categoria = e.target.value;
    aplicarBusqueda();
  });

  // ¿Ya se cerró el día de hoy? Si sí, se avisa y no se puede vender.
  async function cargarEstadoDia() {
    const { data, error } = await db.rpc('estado_dia', { p_fecha: null });
    if (error) return;
    estado.estadoDia = data;
    const aviso = $('#aviso-dia-cerrado');
    aviso.hidden = !data.cerrado;
    if (data.cerrado) {
      aviso.textContent = `El día de hoy ya se cerró (lo cerró ${data.cerrado_por} a las ${fmtHora.format(new Date(data.cerrado_en))}). `
        + 'No se pueden registrar más ventas hoy; solo el jefe puede reabrirlo.';
    }
    $('#btn-cerrar-dia').hidden = data.cerrado;
  }

  $('#buscar').addEventListener('input', (e) => buscar(e.target.value));

  // Enter deja el texto seleccionado, así el siguiente código (escrito o leído con lector
  // de código de barras) reemplaza al anterior.
  $('#buscar').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    buscar(e.target.value);
    e.target.select();
  });

  // Atajos del inventario (para todos los usuarios):
  // · Escribir en cualquier parte de la pantalla va directo al buscador y reemplaza el código
  //   anterior (también funciona con lector de código de barras).
  // · Esc vuelve al buscador y selecciona lo escrito (dentro del buscador, Esc lo borra).
  // · Av Pág / Re Pág pasan a la página siguiente o anterior.
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if ($('#vista-app').hidden || $('#seccion-inventario').hidden) return;
    if (document.querySelector('dialog[open]') || !$('#menu-tema').hidden) return;
    const buscador = $('#buscar');
    const objetivo = e.target instanceof Element ? e.target : null;

    if (e.key === 'PageDown' || e.key === 'PageUp') {
      if (!$('#paginacion').hidden) {
        e.preventDefault();
        irAPagina(estado.pagina + (e.key === 'PageDown' ? 1 : -1));
      }
      return;
    }
    if (objetivo === buscador) return;   // ya está escribiendo en el buscador
    if (e.key === 'Escape') {
      e.preventDefault();
      buscador.focus();
      buscador.select();
      return;
    }
    // En otro campo de texto se escribe normal (el filtro de categorías no cuenta:
    // ahí una letra cambiaría la categoría en vez de buscar).
    const enCampo = objetivo?.closest('input, textarea, select, [contenteditable="true"]');
    if (enCampo && objetivo !== $('#filtro-categoria')) return;
    if (e.key.length !== 1 || e.key === ' ') return;   // solo letras, números y signos
    e.preventDefault();
    buscador.focus();
    buscador.value = e.key;
    buscar(buscador.value);
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
        p.descripcion ? el('div', { class: 'producto-desc' }, p.descripcion) : null,
        p.categoria
          ? el('div', { class: 'producto-categoria', 'data-categoria': p.categoria, 'data-color': colorDeCategoria(p.categoria) }, p.categoria)
          : el('div', { class: 'producto-categoria sin-categoria' }, 'Sin categoría')),
      el('td', { class: 'num', 'data-label': 'Cantidad' }, etiquetaCantidad(p.cantidad)),
      el('td', { class: 'num precio', 'data-label': 'Precio COP' }, fmtCOP.format(p.precio_cop)),
      el('td', { class: 'num precio precio-usd', 'data-label': 'Precio USD', 'data-cop': p.precio_cop }, enDolares(p.precio_cop)),
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
    const total = estado.resultados.length;
    const hayBusqueda = estado.busqueda.trim() !== '';

    // Al repintar, el foco sigue en el mismo botón (Agregar o −) para seguir con el teclado.
    const activo = document.activeElement?.closest?.('#tabla-cuerpo [data-accion]');
    const clave = activo && { id: activo.dataset.id, accion: activo.dataset.accion };
    $('#tabla-cuerpo').replaceChildren(...estado.productos.map(filaProducto));
    if (clave) {
      const cuerpo = $('#tabla-cuerpo');
      (cuerpo.querySelector(`[data-id="${clave.id}"][data-accion="${clave.accion}"]`)
        || cuerpo.querySelector(`[data-id="${clave.id}"][data-accion="agregar"]`))?.focus({ preventScroll: true });
    }

    const vacio = $('#vacio');
    vacio.hidden = total > 0;
    const mensajeVacio = !inventario.listo ? 'Cargando productos…'
      : hayBusqueda ? `No se encontraron productos para “${estado.busqueda.trim()}”.`
        : estado.categoria ? `No hay productos en ${estado.categoria}.`
          : 'Aún no hay productos registrados.';
    const puedeLimpiar = inventario.listo && !total && (hayBusqueda || estado.categoria);
    vacio.replaceChildren(...[el('span', {}, mensajeVacio), puedeLimpiar ? el('button', {
      type: 'button',
      class: 'btn btn-secundario btn-sm vacio-accion',
      onclick: () => {
        $('#buscar').value = '';
        estado.categoria = '';
        $('#filtro-categoria').value = '';
        buscar('');
        $('#buscar').focus();
      },
    }, 'Ver todos los productos') : null].filter(Boolean));

    // "Mostrando 11–20 de 320 productos" cuando hay más de una página
    const nombre = `${total === 1 ? 'producto' : 'productos'}${hayBusqueda ? (total === 1 ? ' encontrado' : ' encontrados') : ''}`;
    const inicio = (estado.pagina - 1) * POR_PAGINA;
    $('#conteo').textContent = !total ? ''
      : total <= POR_PAGINA ? `${fmtNumero.format(total)} ${nombre}`
        : `Mostrando ${inicio + 1}–${inicio + estado.productos.length} de ${fmtNumero.format(total)} ${nombre}`;
    pintarPaginacion(total);
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
    categoriaElegidaAMano = Boolean(p?.categoria);
    $('#dlg-producto-titulo').textContent = p ? 'Editar producto' : 'Nuevo producto';
    if (p) {
      form.codigo.value = p.codigo || '';
      form.nombre.value = p.nombre;
      form.descripcion.value = p.descripcion;
      form.categoria.value = p.categoria || categoriaPorCodigo(p.codigo);
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

  // Al escribir el código, la categoría se elige sola por su letra (si aún no se eligió otra a mano).
  let categoriaElegidaAMano = false;
  $('#form-producto').categoria.addEventListener('change', () => { categoriaElegidaAMano = true; });
  $('#form-producto').codigo.addEventListener('input', (e) => {
    const sugerida = categoriaPorCodigo(e.target.value);
    if (sugerida && !categoriaElegidaAMano) $('#form-producto').categoria.value = sugerida;
  });

  $('#form-producto').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const datos = {
      codigo: form.codigo.value.trim().toUpperCase(),
      nombre: form.nombre.value.trim(),
      descripcion: form.descripcion.value.trim(),
      categoria: form.categoria.value,
      precio_cop: leerNumero(form.precio_cop.value),
    };

    if (!datos.codigo) return mostrarError('#producto-error', 'El código es obligatorio.');
    if (!datos.nombre) return mostrarError('#producto-error', 'El nombre es obligatorio.');
    if (!datos.categoria) { form.categoria.focus(); return mostrarError('#producto-error', 'Elige la categoría del producto.'); }
    if (!(datos.precio_cop >= 0)) {
      return mostrarError('#producto-error', 'Escribe un precio válido en pesos. Ej: 150.000');
    }
    const pideClave = !$('#producto-clave').hidden;
    if (pideClave && !form.clave.value) {
      form.clave.focus();
      return mostrarError('#producto-error', 'Para cambiar el precio hace falta la clave del jefe.', 'clave');
    }

    conBotonOcupado(form, async () => {
      const r = await llamar('guardar_producto', {
        p_id: productoEditando?.id ?? null, p_codigo: datos.codigo, p_nombre: datos.nombre,
        p_descripcion: datos.descripcion, p_categoria: datos.categoria, p_precio: datos.precio_cop, p_clave_jefe: pideClave ? form.clave.value : null,
      });
      form.clave.value = '';
      if (!r.ok) {
        mostrarError('#producto-error', r.error, r.campo);
        if (r.campo === 'clave') { $('#producto-clave').hidden = false; form.clave.focus(); }
        return;
      }
      $('#dlg-producto').close();
      toast(productoEditando ? 'Producto actualizado' : 'Producto creado');
      cargarCategorias();
      // Sin await: el botón se libera de inmediato y la lista se actualiza aparte.
      sincronizarInventario();
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
      inventario.porId.delete(productoEliminando.id);
      inventario.normal.delete(productoEliminando.id);
      aplicarBusqueda({ conservarPagina: true });
    });
  });

  // ------------------------------------------------------------------
  // Carrito: se agregan varios productos y se cobran juntos
  // ------------------------------------------------------------------

  // Siempre dentro de un espacio de ancho fijo: al aparecer el "−" o cambiar el número
  // nada en la tabla se mueve.
  function botonAgregar(p) {
    const enCarrito = estado.carrito.get(p.id)?.cantidad || 0;
    if (p.cantidad <= 0) {
      return el('span', { class: 'grupo-carrito' },
        el('button', { type: 'button', class: 'btn btn-secundario btn-sm btn-vender', disabled: '' }, 'Agotado'));
    }
    const lleno = enCarrito >= p.cantidad;
    // Lleno no se desactiva: al tocarlo explica por qué no deja agregar más.
    const agregar = el('button', {
      type: 'button',
      class: `btn btn-sm btn-vender ${enCarrito ? 'btn-en-carrito' : 'btn-primario'}${lleno ? ' btn-lleno' : ''}`,
      title: lleno ? 'Ya están en el carrito todas las unidades disponibles' : 'Agregar una unidad al carrito',
      'data-id': p.id,
      'data-accion': 'agregar',
      onclick: () => agregarAlCarrito(p),
    }, enCarrito ? `Agregar (${enCarrito})` : 'Agregar');
    if (!enCarrito) return el('span', { class: 'grupo-carrito' }, agregar);
    // Ya está en el carrito: "−" al lado para quitar una unidad sin abrir el carrito.
    return el('span', { class: 'grupo-carrito' },
      el('button', {
        type: 'button',
        class: 'btn btn-sm btn-quitar',
        title: 'Quitar una unidad del carrito',
        'aria-label': `Quitar una unidad de ${p.nombre} del carrito`,
        'data-id': p.id,
        'data-accion': 'quitar',
        onclick: () => quitarDelCarrito(p),
      }, '−'),
      agregar);
  }

  function quitarDelCarrito(p) {
    cambiarCantidad(p.id, -1);
    const queda = estado.carrito.get(p.id)?.cantidad || 0;
    anunciar(queda ? `${p.nombre}: ${queda} en el carrito.` : `${p.nombre} quitado del carrito.`);
  }

  // Aviso cuando el carrito ya tiene todas las unidades disponibles de un producto.
  function avisarTope(p) {
    const n = fmtNumero.format(p.cantidad);
    const mensaje = p.cantidad === 1
      ? `Solo hay 1 unidad de ${p.nombre} y ya está en el carrito. No se pueden agregar más.`
      : `Solo hay ${n} unidades de ${p.nombre} y ya están todas en el carrito. No se pueden agregar más.`;
    if ($('#dlg-carrito').open) mostrarError('#carrito-error', mensaje);   // el aviso flotante quedaría detrás del diálogo
    else toast(mensaje, 'aviso');
  }

  function agregarAlCarrito(p) {
    const linea = estado.carrito.get(p.id) || { producto: p, cantidad: 0 };
    if (linea.cantidad >= p.cantidad) { avisarTope(p); return; }
    linea.producto = p;            // datos más recientes (precio, existencia)
    linea.cantidad += 1;
    estado.carrito.set(p.id, linea);
    actualizarCarrito();
    const unidades = [...estado.carrito.values()].reduce((suma, l) => suma + l.cantidad, 0);
    anunciar(`${p.nombre}: ${linea.cantidad} en el carrito. ${unidades} ${unidades === 1 ? 'unidad' : 'unidades'} en total.`);
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
        el('button', { type: 'button', class: 'btn btn-secundario btn-sm', 'aria-label': 'Una unidad más', onclick: () => cambiarCantidad(p.id, 1) }, '+')),
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
    if (paso > 0 && linea.cantidad >= linea.producto.cantidad) { avisarTope(linea.producto); return; }
    mostrarError('#carrito-error', '');
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

  $('#btn-vaciar-carrito').addEventListener('click', () => {
    const antes = new Map([...estado.carrito].map(([id, linea]) => [id, { ...linea }]));
    vaciarCarrito();
    toast('Carrito vaciado', 'ok', {
      texto: 'Deshacer',
      alHacer: () => { estado.carrito = antes; aplicarBusqueda({ conservarPagina: true }); toast('Carrito recuperado'); },
    });
  });

  $('#form-carrito').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!estado.carrito.size) return;
    if (!form.vendedor.value.trim()) {
      form.vendedor.focus();
      return mostrarError('#carrito-error', 'Escribe tu código de vendedor.', 'vendedor');
    }

    conBotonOcupado(form, async () => {
      const carrito = new Map(estado.carrito);   // copia: el ticket usa sus códigos y nombres
      const items = [...estado.carrito.values()].map((l) => ({ producto_id: l.producto.id, cantidad: l.cantidad }));
      const r = await llamar('registrar_venta_multiple', { p_items: items, p_codigo_vendedor: form.vendedor.value.trim() });
      if (!r.ok) {
        mostrarError('#carrito-error', r.error, r.campo);
        if (r.motivo === 'dia_cerrado') cargarEstadoDia();
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
          sincronizarInventario();
        }
        return;
      }
      form.vendedor.value = '';
      $('#dlg-carrito').close();
      const n = r.lineas.length;
      despuesDeVender(r, carrito, `Venta #${r.numero_dia} del día registrada (${r.vendedor}): ${n} ${n === 1 ? 'producto' : 'productos'} · ${fmtCOP.format(r.total)} · consecutivo ${r.ticket}`);
      vaciarCarrito();
      sincronizarInventario();
      if (!$('#seccion-cierre').hidden) cargarCierre();
      // Listo para el siguiente cliente: el buscador queda seleccionado.
      $('#buscar').focus();
      $('#buscar').select();
    });
  });

  // ------------------------------------------------------------------
  // Impresora de tickets (mini impresora térmica Bluetooth): ver js/impresora.js
  // ------------------------------------------------------------------

  const Impresora = window.Impresora;
  let ultimoTicket = null;   // el último ticket vendido en este equipo (para reimprimirlo)
  let ticketVista = null;    // el que se ve en la vista previa del diálogo

  const ticketDePrueba = () => ({
    prueba: true, numeroDia: 1, consecutivo: null, fecha: new Date().toISOString(),
    lineas: [
      { codigo: 'L-2054', nombre: 'CAMISA LAVADORA MABE FLOTADOR ALADO', cantidad: 2, precio: 73000, subtotal: 146000 },
      { codigo: 'V-3013', nombre: 'CUCHILLA LICUADORA OSTER ORIGINAL + CUADRANTE', cantidad: 1, precio: 30000, subtotal: 30000 },
    ],
    total: 176000, vendedor: 'Prueba',
  });

  // Ticket a partir de lo que devuelve la venta (el carrito completa lo que falte).
  function ticketDeVenta(r, carrito) {
    return {
      numeroDia: r.numero_dia,
      consecutivo: r.ticket,
      fecha: r.lineas[0]?.vendido_en || new Date().toISOString(),
      lineas: r.lineas.map((l) => {
        const p = carrito.get(l.producto_id)?.producto || {};
        const precio = Number(l.precio_unitario ?? p.precio_cop);
        return {
          codigo: l.codigo ?? p.codigo, nombre: l.nombre ?? p.nombre, cantidad: l.cantidad,
          precio, subtotal: Number(l.total ?? precio * l.cantidad),
        };
      }),
      total: r.total,
      vendedor: r.vendedor,
    };
  }

  // Ticket de una venta ya registrada (reimpresión desde Reportes): solo lo que sigue vendido.
  function ticketDeVentaAbierta(v) {
    const vigentes = v.lineas.filter((l) => !l.anulada_en);
    return {
      numeroDia: v.numero_dia ?? v.numero,
      consecutivo: v.numero,
      fecha: v.vendido_en,
      lineas: vigentes.map((l) => ({
        codigo: l.codigo, nombre: l.nombre, cantidad: l.cantidad,
        precio: Number(l.precio_unitario), subtotal: Number(l.total),
      })),
      total: v.total,
      vendedor: v.vendedor,
      reimpresion: true,
    };
  }

  function pintarBotonImpresora(e = Impresora.estado()) {
    const boton = $('#btn-impresora');
    boton.classList.toggle('conectada', e.conectada);
    boton.classList.toggle('ocupada', e.ocupada);
    const texto = e.ocupada ? 'imprimiendo' : e.conectada ? `conectada (${e.nombre})` : 'sin conectar';
    boton.setAttribute('aria-label', `Impresora de tickets: ${texto}`);
    boton.title = `Impresora de tickets: ${texto}`;
    if ($('#dlg-impresora').open) pintarImpresora();
  }
  Impresora.alCambiar(pintarBotonImpresora);
  pintarBotonImpresora();

  // Conecta si hace falta: primero la impresora de siempre sin preguntar; si no, abre la lista.
  async function asegurarImpresora() {
    if (Impresora.estado().conectada || await Impresora.reconectar()) return true;
    return Impresora.conectar();
  }

  async function imprimirTicket(ticket, { conectarSiFalta = false, mensaje = '' } = {}) {
    const antes = mensaje ? `${mensaje} · ` : '';
    const n = ticket.numeroDia;
    if (!Impresora.estado().soportada) { abrirImpresora(ticket); return; }   // sin Bluetooth: imagen del ticket
    try {
      if (conectarSiFalta && !(await asegurarImpresora())) return;   // cerró la lista sin elegir
      toast(`${antes}Imprimiendo ticket #${n}…`);
      await Impresora.imprimir(ticket);
      toast(`${antes}Ticket #${n} impreso`);
    } catch (error) {
      const reintentar = { texto: error.sinImpresora ? 'Conectar e imprimir' : 'Reintentar', alHacer: () => imprimirTicket(ticket, { conectarSiFalta: true }) };
      if (error.sinImpresora) toast(`${antes}La impresora no está conectada`, 'aviso', reintentar);
      else toast(`No se pudo imprimir el ticket #${n}: ${error.message}`, 'error', reintentar);
    }
  }

  // Después de cada venta: imprime solo si este equipo ya tiene impresora; si no, ofrece imprimir.
  function despuesDeVender(r, carrito, mensaje) {
    const ticket = ticketDeVenta(r, carrito);
    ultimoTicket = ticket;
    const e = Impresora.estado();
    if (Impresora.ajustes().auto && e.soportada && (e.conectada || e.recordada)) {
      imprimirTicket(ticket, { mensaje: `Venta #${r.numero_dia} del día registrada` });
    } else {
      toast(mensaje, 'ok', { texto: 'Imprimir ticket', alHacer: () => imprimirTicket(ticket, { conectarSiFalta: true }) });
    }
  }

  function pintarImpresora() {
    const e = Impresora.estado();
    const a = Impresora.ajustes();
    const form = $('#form-impresora');
    $('#impresora-no-soportada').hidden = e.soportada;
    if (!e.soportada) pintarSinBluetooth();
    const estadoTexto = $('#impresora-estado');
    estadoTexto.textContent = !e.soportada ? 'Sin Bluetooth en este navegador.'
      : e.ocupada ? `Imprimiendo en ${e.nombre}…`
        : e.conectada ? `Conectada: ${e.nombre}`
          : e.recordada ? `${e.nombre}: sin conexión. Enciéndela y toca "Conectar impresora".`
            : 'Ninguna impresora conectada en este equipo.';
    estadoTexto.classList.toggle('conectada', e.conectada);
    $('#btn-impresora-conectar').hidden = e.conectada || !e.soportada;
    $('#btn-impresora-desconectar').hidden = !e.conectada;
    $('#btn-impresora-prueba').hidden = !e.soportada;
    $('#btn-impresora-prueba').disabled = e.ocupada;
    $('#btn-impresora-ultimo').hidden = !e.soportada || !ultimoTicket;
    $('#btn-impresora-ultimo').disabled = e.ocupada;
    $('#impresora-ayuda').hidden = !e.soportada || e.conectada;
    $('#impresora-ajustes').hidden = !e.soportada;   // sin Bluetooth solo sirve la imagen
    form.auto.checked = a.auto;
    form.compatible.checked = a.compatible;
    form.querySelector(`[name="intensidad"][value="${a.intensidad}"]`).checked = true;
  }

  // Sin Bluetooth: por qué y qué hacer, según el navegador (en Android, abrir la página en Chrome).
  function pintarSinBluetooth() {
    const n = Impresora.navegador();
    const enChrome = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;`
      + `S.browser_fallback_url=${encodeURIComponent('https://play.google.com/store/apps/details?id=com.android.chrome')};end`;
    let texto;
    if (n.ios) {
      texto = 'En iPhone y iPad no se puede conectar la impresora desde una página web: Apple no lo permite, ni en Safari ni en Chrome. '
        + 'Toca "Guardar o compartir imagen" y elige la app de la impresora para imprimir el ticket.';
    } else if (n.brave) {
      texto = 'En Brave el Bluetooth para páginas viene apagado. Abre la página en Google Chrome '
        + '(o en Brave: escribe brave://flags, busca "Web Bluetooth API", ponlo en Enabled y reinicia Brave).';
    } else if (!n.seguro) {
      texto = 'La página debe abrirse con https:// para poder usar Bluetooth.';
    } else {
      texto = `Estás usando ${n.nombre}, que no puede conectarse a la impresora por Bluetooth. `
        + (n.android ? 'Abre la página en Google Chrome:' : 'Abre la página en Google Chrome o Microsoft Edge.');
    }
    $('#impresora-no-soportada').replaceChildren(...[el('span', {}, texto),
      n.android ? el('a', { class: 'btn btn-primario btn-sm btn-abrir-chrome', href: enChrome }, 'Abrir en Chrome') : null].filter(Boolean));
  }

  function abrirImpresora(ticket) {
    ticketVista = ticket || ultimoTicket || ticketDePrueba();
    mostrarError('#impresora-error', '');
    $('#impresora-ok').hidden = true;
    pintarImpresora();
    $('#impresora-vista').src = Impresora.imagenTicket(ticketVista).toDataURL('image/png');
    $('#impresora-vista-texto').textContent = ticketVista.prueba ? 'Así sale el ticket (ejemplo)'
      : `Ticket #${ticketVista.numeroDia}${ticketVista.reimpresion ? ' (reimpresión)' : ''}`;
    if (!$('#dlg-impresora').open) $('#dlg-impresora').showModal();
  }

  $('#btn-impresora').addEventListener('click', () => abrirImpresora());

  async function conectarDesdeDialogo(todos) {
    mostrarError('#impresora-error', '');
    $('#impresora-ok').hidden = true;
    try {
      if (await Impresora.conectar({ todos })) {
        $('#impresora-ok').textContent = `Listo: ${Impresora.estado().nombre} conectada. Puedes imprimir una prueba.`;
        $('#impresora-ok').hidden = false;
      }
    } catch (error) {
      mostrarError('#impresora-error', error.message);
    }
  }
  $('#btn-impresora-conectar').addEventListener('click', () => conectarDesdeDialogo(false));
  $('#btn-impresora-todos').addEventListener('click', () => conectarDesdeDialogo(true));
  $('#btn-impresora-desconectar').addEventListener('click', () => Impresora.desconectar());

  async function imprimirDesdeDialogo(ticket) {
    mostrarError('#impresora-error', '');
    $('#impresora-ok').hidden = true;
    try {
      if (!(await asegurarImpresora())) return;
      await Impresora.imprimir(ticket);
      $('#impresora-ok').textContent = ticket.prueba ? 'Prueba impresa.' : `Ticket #${ticket.numeroDia} impreso.`;
      $('#impresora-ok').hidden = false;
    } catch (error) {
      mostrarError('#impresora-error', error.sinImpresora ? 'No hay impresora conectada.' : `No se pudo imprimir: ${error.message}`);
    }
  }
  $('#btn-impresora-prueba').addEventListener('click', () => imprimirDesdeDialogo(ticketDePrueba()));
  $('#btn-impresora-ultimo').addEventListener('click', () => {
    if (ultimoTicket) imprimirDesdeDialogo({ ...ultimoTicket, reimpresion: true });
  });

  $('#form-impresora').addEventListener('submit', (e) => e.preventDefault());
  $('#form-impresora').addEventListener('change', (e) => {
    const form = e.currentTarget;
    Impresora.guardarAjustes({
      auto: form.auto.checked,
      compatible: form.compatible.checked,
      intensidad: form.querySelector('[name="intensidad"]:checked').value,
    });
  });

  // Sin Bluetooth (por ejemplo en iPhone): la imagen del ticket se comparte con la app de la
  // impresora o se descarga.
  $('#btn-impresora-imagen').addEventListener('click', async () => {
    const t = ticketVista;
    const blob = await new Promise((r) => Impresora.imagenTicket(t).toBlob(r, 'image/png'));
    const dia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(new Date(t.fecha));
    const nombre = t.prueba ? 'Ticket-prueba.png' : `Ticket-${t.numeroDia}-${dia}.png`;
    const archivo = new File([blob], nombre, { type: 'image/png' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: nombre }); return; }
      catch (error) { if (error.name === 'AbortError') return; }
    }
    const enlace = el('a', { href: URL.createObjectURL(blob), download: nombre });
    document.body.append(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(enlace.href), 10000);
  });

  // Reimprimir una venta desde su detalle (Reportes)
  $('#btn-venta-imprimir').addEventListener('click', () => {
    if (ventaAbierta) imprimirTicket(ticketDeVentaAbierta(ventaAbierta), { conectarSiFalta: true });
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
    if (!esJefe() && !form.clave.value) { form.clave.focus(); return mostrarError('#mov-error', 'Falta la clave del jefe.', 'clave'); }

    conBotonOcupado(form, async () => {
      const r = await llamar('registrar_movimiento', {
        p_producto_id: p.id, p_tipo: tipo, p_cantidad: n, p_motivo: form.motivo.value.trim(), p_clave_jefe: form.clave.value,
      });
      if (!r.ok) {
        mostrarError('#mov-error', r.error, r.campo);
        if (r.campo === 'clave') { form.clave.value = ''; form.clave.focus(); }
        return;
      }
      form.clave.value = '';
      $('#dlg-movimiento').close();
      const m = r.movimiento;
      toast(`${tipo === 'entrada' ? 'Entrada' : 'Salida'} registrada: ${p.nombre} queda con ${fmtNumero.format(m.stock_despues)} unidades`);
      sincronizarInventario();
      if (!$('#seccion-cierre').hidden) cargarCierre();
    });
  });

  // ------------------------------------------------------------------
  // Precios en bloque (administrador y jefe)
  // ------------------------------------------------------------------

  function datosPreciosBloque() {
    const f = $('#form-precios');
    return {
      p_categoria: f.categoria.value || null,
      p_operacion: f.querySelector('[name="operacion"]:checked').value,
      p_tipo: f.querySelector('[name="tipo"]:checked').value,
      p_valor: leerNumero(f.valor.value),
      p_redondeo: Number(f.redondeo.value),
    };
  }

  // Cualquier cambio en el formulario obliga a ver de nuevo la vista previa.
  function invalidarVistaPrecios() {
    const f = $('#form-precios');
    $('#precios-valor-etiqueta').textContent = datosPreciosBloque().p_tipo === 'porcentaje' ? 'Porcentaje (%)' : 'Monto en pesos';
    f.valor.placeholder = datosPreciosBloque().p_tipo === 'porcentaje' ? 'Ej: 10' : 'Ej: 5.000';
    $('#precios-vista').hidden = true;
    f.querySelector('[type="submit"]').disabled = true;
    mostrarError('#precios-error', '');
  }

  $('#btn-precios-bloque').addEventListener('click', () => {
    const f = $('#form-precios');
    f.reset();
    f.categoria.value = estado.categoria;   // empieza con la categoría que se está viendo
    $('#precios-clave').hidden = !estado.precioRequiereClave;
    invalidarVistaPrecios();
    $('#dlg-precios').showModal();
    f.valor.focus();
  });

  // La clave del jefe no cambia el resultado: escribirla no obliga a ver de nuevo la vista previa.
  $('#form-precios').addEventListener('input', (e) => { if (e.target.name !== 'clave') invalidarVistaPrecios(); });
  $('#form-precios').addEventListener('change', (e) => { if (e.target.name !== 'clave') invalidarVistaPrecios(); });

  function pintarFilasPrecios(filas) {
    $('#precios-filas').replaceChildren(...filas.slice(0, 300).map((p) => el('tr', Number(p.despues) <= 0 ? { class: 'fila-error' } : {},
      celda(p.codigo ? el('span', { class: 'codigo codigo-sm' }, p.codigo) : '—', 'nowrap'),
      celda(p.nombre),
      celda(p.categoria || '—'),
      celda(fmtCOP.format(p.antes), 'num'),
      celda(el('strong', {}, fmtCOP.format(p.despues)), 'num'),
    )));
  }

  $('#btn-precios-vista').addEventListener('click', async (e) => {
    const datos = datosPreciosBloque();
    if (!(datos.p_valor > 0)) return mostrarError('#precios-error', 'Escribe un valor mayor que cero.');
    const boton = e.currentTarget;
    boton.disabled = true;
    const r = await llamar('cambiar_precios_masivo', { ...datos, p_simular: true, p_clave_jefe: null });
    boton.disabled = false;
    if (!r.ok) {
      mostrarError('#precios-error', r.error, r.campo);
      if (r.filas) { pintarFilasPrecios(r.filas.filter((p) => Number(p.despues) <= 0)); $('#precios-vista').hidden = false; $('#precios-resumen').textContent = 'Estos productos quedarían sin precio:'; }
      return;
    }
    const accion = datos.p_operacion === 'subir' ? 'Subir' : 'Bajar';
    const cuanto = datos.p_tipo === 'porcentaje' ? `${fmtNumero.format(datos.p_valor)} %` : fmtCOP.format(datos.p_valor);
    $('#precios-resumen').textContent = `${accion} ${cuanto} a ${r.productos} ${r.productos === 1 ? 'producto' : 'productos'}`
      + `${datos.p_categoria ? ` de ${datos.p_categoria}` : ''}: cambian ${r.cambian}.${r.productos > 300 ? ' Se muestran los primeros 300.' : ''}`;
    pintarFilasPrecios(r.filas);
    $('#precios-vista').hidden = false;
    $('#form-precios').querySelector('[type="submit"]').disabled = r.cambian === 0;
  });

  $('#form-precios').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!esJefe() && estado.precioRequiereClave && !form.clave.value) {
      form.clave.focus();
      return mostrarError('#precios-error', 'Falta la clave del jefe.', 'clave');
    }
    conBotonOcupado(form, async () => {
      const r = await llamar('cambiar_precios_masivo', { ...datosPreciosBloque(), p_simular: false, p_clave_jefe: form.clave.value || null });
      form.clave.value = '';
      if (!r.ok) { mostrarError('#precios-error', r.error, r.campo); return; }
      $('#dlg-precios').close();
      toast(`Precios actualizados: ${r.cambiados} ${r.cambiados === 1 ? 'producto' : 'productos'}`);
      sincronizarInventario();
      if (!$('#seccion-cierre').hidden) cargarCierre();
    });
  });

  // ------------------------------------------------------------------
  // Cierre del día (manual, con el código de una persona autorizada)
  // ------------------------------------------------------------------

  let fechaCerrando = null;
  const mayuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  function abrirCierreDia(fecha, resumen) {
    fechaCerrando = fecha;
    const form = $('#form-cierre');
    form.reset();
    form.hidden = false;
    $('#cierre-hecho').hidden = true;
    mostrarError('#cierre-dlg-error', '');
    const esHoy = fecha === (estado.estadoDia?.hoy || hoyEnZona());
    $('#cierre-dlg-titulo').textContent = esHoy ? 'Cerrar el día de hoy' : 'Cerrar el día';
    $('#cierre-dlg-texto').textContent = `${mayuscula(fmtDiaLargo.format(aFecha(fecha)))}${resumen ? ` · ${resumen}` : ''}`;
    $('#dlg-cierre').showModal();
    form.codigo.focus();
  }

  $('#btn-cerrar-dia').addEventListener('click', () => abrirCierreDia(estado.estadoDia?.hoy || hoyEnZona()));

  $('#form-cierre').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.codigo.value.trim()) return mostrarError('#cierre-dlg-error', 'Escribe el código de quien hace el cierre.');
    conBotonOcupado(form, async () => {
      const r = await llamar('cerrar_dia', { p_fecha: fechaCerrando, p_codigo: form.codigo.value.trim() });
      form.codigo.value = '';
      if (!r.ok) { mostrarError('#cierre-dlg-error', r.error, r.campo); form.codigo.focus(); return; }

      const c = r.cierre;
      const t = c.totales;
      form.hidden = true;
      $('#cierre-hecho').hidden = false;
      $('#cierre-hecho-texto').textContent =
        `${mayuscula(fmtDiaLargo.format(aFecha(c.fecha)))} · cerrado por ${c.cerrado_por} a las ${fmtHora.format(new Date(c.cerrado_en))}`;
      $('#cierre-hecho-totales').replaceChildren(...[
        el('li', {}, el('span', {}, 'Total vendido'), el('strong', {}, fmtCOP.format(t.total))),
        el('li', {}, el('span', {}, 'Ventas'), el('strong', {}, fmtNumero.format(t.ventas))),
        el('li', {}, el('span', {}, 'Unidades'), el('strong', {}, fmtNumero.format(t.unidades))),
        t.lineas_anuladas ? el('li', {}, el('span', {}, 'Líneas anuladas'), el('strong', {}, fmtNumero.format(t.lineas_anuladas))) : null,
        t.primer_consecutivo ? el('li', {}, el('span', {}, 'Consecutivos'), el('strong', {}, `${t.primer_consecutivo} a ${t.ultimo_consecutivo}`)) : null,
        ...t.por_vendedor.map((v) => el('li', { class: 'cierre-vendedor' }, el('span', {}, v.vendedor), el('strong', {}, `${fmtNumero.format(v.ventas)} · ${fmtCOP.format(v.total)}`))),
      ].filter(Boolean));
      cargarEstadoDia();
      if (!$('#seccion-cierre').hidden) cargarCierre();
    });
  });

  // Reabrir (solo el jefe): pide un segundo toque para confirmar.
  $('#btn-reabrir').addEventListener('click', async (e) => {
    const boton = e.currentTarget;
    if (boton.dataset.confirmar !== '1') {
      boton.dataset.confirmar = '1';
      boton.textContent = '¿Seguro? Toca otra vez para reabrir';
      setTimeout(() => { boton.dataset.confirmar = ''; boton.textContent = 'Reabrir el día'; }, 4000);
      return;
    }
    boton.dataset.confirmar = '';
    boton.textContent = 'Reabrir el día';
    const r = await llamar('reabrir_dia', { p_fecha: cierre.desde });
    if (!r.ok) { toast(r.error, 'error'); return; }
    toast('Día reabierto: se puede volver a vender y anular');
    cargarEstadoDia();
    cargarCierre();
  });

  $('#btn-reporte-cerrar').addEventListener('click', () => {
    abrirCierreDia(cierre.desde, `${fmtNumero.format(cierre.numVentas)} ventas · ${fmtCOP.format(cierre.totalCOP)}`);
  });

  // ------------------------------------------------------------------
  // Lista de precios en PDF (para todos: por si el sistema no está disponible)
  // ------------------------------------------------------------------

  $('#btn-lista-precios').addEventListener('click', async (e) => {
    const boton = e.currentTarget;
    boton.disabled = true;
    try {
      const productos = await traerTodo(() => db.from('productos')
        .select('codigo, nombre, descripcion, categoria, precio_cop').order('categoria').order('nombre'));
      await window.Exportar.listaPrecios(productos, {
        tasa: estado.tasa, generadoPor: $('#usuario-nombre').textContent, mostrarTasa: document.body.dataset.rol !== 'atencion',
      });
    } catch (error) {
      toast(`No se pudo generar la lista de precios: ${error.message}`, 'error');
    } finally {
      boton.disabled = false;
    }
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
        .select('codigo, nombre, descripcion, categoria, cantidad, precio_cop').order('nombre'));
      await window.Exportar.plantilla(inventario, hoyEnZona(), { categorias: estado.categorias });
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
        traerTodo(() => db.from('productos').select('id, codigo, nombre, descripcion, categoria, cantidad, precio_cop')),
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
      // Categoría como la resolverá la base: la escrita (nombre o letra) o, si no hay
      // y el producto no tenía, la de la letra del código.
      let categoria = null;
      if (f.categoria) {
        categoria = categoriaDeTexto(f.categoria);
        if (!categoria && !error) error = `Categoría desconocida: "${f.categoria}". Usa: ${estado.categorias.map((c) => `${c.prefijo} ${c.nombre}`).join(', ')}.`;
      } else if (!actual?.categoria) {
        categoria = categoriaPorCodigo(f.codigo) || null;
      }
      if (!error && !f.codigo) error = 'Falta el código.';
      if (!error && repetidos.has(f.codigo)) error = 'Código repetido en el archivo.';
      if (!error && !actual && (!f.nombre || f.precio == null)) error = 'Producto nuevo: faltan el nombre o el precio.';
      if (!error && !categoria && !actual?.categoria) error = 'Falta la categoría: escríbela, o usa un código que empiece con la letra de una categoría.';
      f.categoriaFinal = categoria || actual?.categoria || null;

      let resultado;
      let clase = '';
      if (error) {
        errores++; resultado = error; clase = 'fila-error';
      } else if (!actual) {
        nuevos++; resultado = `Nuevo · ${categoria} · ${fmtNumero.format(f.cantidad ?? 0)} unidades`; clase = 'fila-nueva';
      } else {
        existentes++;
        if (f.cantidad != null && f.cantidad === actual.cantidad && f.cantidad > 0) comoExistencia++;
        const partes = [];
        if (f.nombre && f.nombre !== actual.nombre) partes.push('nombre');
        if (f.descripcion && f.descripcion !== actual.descripcion) partes.push('descripción');
        if (categoria && categoria !== actual.categoria) partes.push(`categoría → ${categoria}`);
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
        celda(f.categoriaFinal || '—'),
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
    if (!esJefe() && !form.clave.value) { form.clave.focus(); return mostrarError('#importar-error', 'Falta la clave del jefe.', 'clave'); }

    conBotonOcupado(form, async () => {
      const filas = filasImportar.map(({ fila, codigo, nombre, descripcion, categoria, cantidad, precio }) =>
        ({ fila, codigo, nombre, descripcion, categoria, cantidad, precio }));
      const r = await llamar('importar_productos', { p_filas: filas, p_modo: modoImportar(), p_clave_jefe: form.clave.value || null });
      form.clave.value = '';
      if (!r.ok) {
        const detalle = r.errores?.slice(0, 5).map((x) => `fila ${x.fila}: ${x.error}`).join(' · ');
        mostrarError('#importar-error', detalle ? `${r.error} ${detalle}` : r.error);
        return;
      }
      $('#dlg-importar').close();
      toast(`Importación lista: ${r.creados} nuevos, ${r.actualizados} actualizados, ${r.sin_cambios} sin cambios`);
      sincronizarInventario();
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
    pintarCategoriasConfig(r.categorias);
    editarVendedor(null);
    editarCategoria(null);
  }

  // ---- Categorías (letra + nombre) ----
  let categoriaEditando = null;

  function pintarCategoriasConfig(categorias) {
    $('#config-categorias').replaceChildren(...categorias.map((c) => el('li', {},
      el('span', { class: 'codigo codigo-sm' }, c.prefijo),
      el('span', { class: 'vendedor-nombre' },
        el('span', { class: 'producto-categoria', 'data-color': colorDeCategoria(c.nombre, categorias) }, c.nombre)),
      el('button', { type: 'button', class: 'btn btn-secundario btn-sm', onclick: () => editarCategoria(c) }, 'Editar'),
    )));
  }

  function editarCategoria(c) {
    categoriaEditando = c;
    const form = $('#form-categoria');
    form.reset();
    if (c) { form.prefijo.value = c.prefijo; form.nombre.value = c.nombre; form.nombre.focus(); }
    $('#btn-categoria-cancelar').hidden = !c;
    $('#btn-categoria-guardar').textContent = c ? 'Guardar categoría' : 'Agregar categoría';
    mostrarError('#categoria-error', '');
  }

  $('#btn-categoria-cancelar').addEventListener('click', () => editarCategoria(null));

  $('#form-categoria').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const prefijo = form.prefijo.value.trim().toUpperCase();
    const nombre = form.nombre.value.trim();
    if (!/^[A-Z]{1,5}$/.test(prefijo)) return mostrarError('#categoria-error', 'La letra debe ser de 1 a 5 letras, sin números ni símbolos (ej: L).');
    if (!nombre) return mostrarError('#categoria-error', 'Escribe el nombre de la categoría.');
    conBotonOcupado(form, async () => {
      const r = await llamar('config_guardar_categoria', { p_prefijo_anterior: categoriaEditando?.prefijo ?? null, p_prefijo: prefijo, p_nombre: nombre });
      if (!r.ok) return mostrarError('#categoria-error', r.error, r.campo);
      toast(categoriaEditando ? `Categoría ${nombre} actualizada` : `Categoría ${prefijo} · ${nombre} creada`);
      pintarCategoriasConfig(r.categorias);
      editarCategoria(null);
      cargarCategorias();
      sincronizarInventario();
    });
  });

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
      v.puede_cerrar ? el('span', { class: 'etiqueta-cierre', title: 'Puede hacer el cierre del día' }, 'Cierre') : null,
      el('span', { class: v.activo ? 'estado-vendedor activo' : 'estado-vendedor' }, v.activo ? 'Activo' : 'Inactivo'),
      el('button', { type: 'button', class: 'btn btn-secundario btn-sm', onclick: () => editarVendedor(v) }, 'Editar'),
    )));
    $('#config-sin-vendedores').hidden = vendedores.length > 0;
  }

  function editarVendedor(v) {
    vendedorEditando = v;
    const form = $('#form-vendedor');
    form.reset();
    $('#vendedor-titulo').textContent = v ? `Editar a ${v.nombre}` : 'Nueva persona';
    $('#vendedor-codigo-etiqueta').textContent = v ? 'Nuevo código (vacío = no cambiar)' : 'Código (mínimo 4)';
    $('#vendedor-activo-fila').hidden = !v;
    $('#btn-vendedor-cancelar').hidden = !v;
    if (v) {
      form.nombre.value = v.nombre;
      form.activo.checked = v.activo;
      form.puede_cerrar.checked = v.puede_cerrar;
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
        p_puede_cerrar: form.puede_cerrar.checked,
      });
      if (!r.ok) return mostrarError('#vendedor-error', r.error, r.campo);
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
      if (!r.ok) return mostrarError('#clave-jefe-error', r.error, r.campo);
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

    // Un renglón por venta (carrito), incluidas las anuladas.
    const porCarrito = new Map();
    for (const v of ventas) {
      const g = porCarrito.get(numeroVenta(v))
        || { ticket: v.ticket, numero_dia: v.numero_dia, vendido_en: v.vendido_en, vendedor: v.vendedor || '—', lineas: 0, anuladas: 0, unidades: 0, total: 0 };
      g.lineas += 1;
      if (v.anulada_en) g.anuladas += 1;
      else { g.unidades += v.cantidad; g.total += Number(v.total); }
      if (v.vendido_en < g.vendido_en) g.vendido_en = v.vendido_en;
      porCarrito.set(numeroVenta(v), g);
    }
    const estadoCarrito = (g) => (g.anuladas === g.lineas ? 'Anulada' : g.anuladas ? 'Anulación parcial' : 'Completa');
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
      porCarrito: [...porCarrito.values()].map((g) => ({ ...g, estado: estadoCarrito(g) }))
        .sort((a, b) => (b.ticket ?? 0) - (a.ticket ?? 0) || b.vendido_en.localeCompare(a.vendido_en)),
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
      const [ventas, porAgotarse, movimientos, cambiosPrecio, cierres] = await Promise.all([
        traerTodo(() => db.from('ventas').select('*')
          .gte('vendido_en', inicio).lt('vendido_en', fin).order('vendido_en', { ascending: false }).order('id')),
        traerTodo(() => db.from('productos').select('id, codigo, nombre, cantidad')
          .lte('cantidad', STOCK_BAJO).order('cantidad').order('nombre')),
        traerTodo(() => db.from('movimientos').select('*').neq('tipo', 'venta')
          .gte('creado_en', inicio).lt('creado_en', fin).order('creado_en', { ascending: false })),
        traerTodo(() => db.from('historial_precios').select('*').neq('origen', 'creacion')
          .gte('creado_en', inicio).lt('creado_en', fin).order('creado_en', { ascending: false })),
        traerTodo(() => db.from('cierres').select('*').is('reabierto_en', null)
          .gte('fecha', periodo.desde).lte('fecha', periodo.hasta).order('fecha')),
      ]);
      if (esta !== numeroCierre) return;   // se pidió otro periodo mientras tanto
      cierre = resumirCierre(periodo, ventas, porAgotarse, movimientos, cambiosPrecio);
      cierre.cierres = cierres;
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
    pintarEstadoCierre(c);
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

    $('#tabla-carritos').replaceChildren(...c.porCarrito.map((g) => el('tr', { class: `fila-clic${g.estado === 'Anulada' ? ' anulada' : ''}`, onclick: () => abrirVentaNumero(g.ticket) },
      celda(botonVenta(g.ticket, false, g.numero_dia), 'nowrap'),
      celda(String(g.ticket ?? '—'), 'nowrap'),
      celda(cuando(g.vendido_en), 'nowrap'),
      celda(g.vendedor),
      celda(fmtNumero.format(g.lineas), 'num'),
      celda(fmtNumero.format(g.unidades), 'num'),
      celda(fmtCOP.format(g.total), 'num'),
      celda(g.estado === 'Completa' ? 'Completa' : el('span', { class: 'etiqueta-anulada' }, g.estado)),
    )));
    $('#vacio-carritos').hidden = c.porCarrito.length > 0;

    const diasCerrados = new Set(c.cierres.map((x) => x.fecha));
    $('#tabla-ventas').replaceChildren(...c.ventas.map((v) => el('tr', v.anulada_en ? { class: 'anulada' } : {},
      celda(botonVenta(v.ticket, true, v.numero_dia), 'nowrap'),
      celda(cuando(v.vendido_en), 'nowrap'),
      celda(v.codigo ? el('span', { class: 'codigo codigo-sm' }, v.codigo) : '—'),
      celda(v.nombre),
      celda(fmtNumero.format(v.cantidad), 'num'),
      celda(fmtCOP.format(v.precio_unitario), 'num'),
      celda(fmtCOP.format(v.total), 'num'),
      celda(v.vendedor || '—'),
      v.anulada_en
        ? celda(el('span', { class: 'etiqueta-anulada' }, 'Anulada'), 'col-acciones')
        : diasCerrados.has(diaEnZona(v.vendido_en))
          ? celda(el('span', { class: 'etiqueta-cierre', title: 'Para anular, el jefe debe reabrir ese día' }, 'Día cerrado'), 'col-acciones')
          : celda(el('button', { type: 'button', class: 'btn btn-peligro-suave btn-sm', onclick: () => abrirAnular(v) }, 'Anular'), 'col-acciones'),
    )));
    $('#vacio-ventas').hidden = c.ventas.length > 0;
  }

  // ------------------------------------------------------------------
  // Reporte de una venta (carrito) por su número
  // ------------------------------------------------------------------

  let ventaAbierta = null;   // la venta que se está viendo (también para su PDF)

  // El número de venta como botón: abre su detalle. En el detalle de líneas tiene
  // su propio clic; en la tabla de carritos el clic lo maneja la fila completa.
  // Muestra el número del día (#3) y abre la venta por su consecutivo interno.
  function botonVenta(consecutivo, propio, numeroDia) {
    if (!consecutivo) return '—';
    return el('button', {
      type: 'button', class: 'enlace-venta', title: `Ver la venta (consecutivo ${consecutivo})`,
      ...(propio ? { onclick: () => abrirVentaNumero(consecutivo) } : {}),
    }, `#${numeroDia ?? consecutivo}`);
  }

  // Estado de cierre del día mostrado (o de los días del periodo).
  function pintarEstadoCierre(c) {
    const caja = $('#estado-dia');
    const hoy = estado.estadoDia?.hoy || hoyEnZona();
    caja.hidden = false;
    caja.classList.remove('cerrado');
    if (c.unDia) {
      const ci = c.cierres[0];
      if (ci) {
        caja.classList.add('cerrado');
        $('#estado-dia-texto').textContent = `Día cerrado por ${ci.cerrado_por} el ${fmtFecha.format(new Date(ci.cerrado_en))}`;
      } else {
        $('#estado-dia-texto').textContent = c.desde > hoy ? 'Este día todavía no ha llegado.' : 'Día abierto: todavía no se ha hecho el cierre.';
      }
      $('#btn-reporte-cerrar').hidden = Boolean(ci) || c.desde > hoy;
      $('#btn-reabrir').hidden = !ci;
    } else {
      $('#estado-dia-texto').textContent = `Días cerrados en este periodo: ${c.cierres.length} de ${c.dias}.`;
      $('#btn-reporte-cerrar').hidden = true;
      $('#btn-reabrir').hidden = true;
    }
  }

  async function abrirVentaNumero(numero) {
    const { data, error } = await db.from('ventas').select('*').eq('ticket', numero).order('id');
    if (error) { toast(`No se pudo cargar la venta: ${error.message}`, 'error'); return; }
    if (!data.length) { toast(`No existe una venta con el consecutivo ${numero}.`, 'error'); return; }

    const validas = data.filter((l) => !l.anulada_en);
    const tasa = data.find((l) => l.tasa_usd)?.tasa_usd;
    const total = validas.reduce((s, l) => s + Number(l.total), 0);
    ventaAbierta = {
      numero,
      ticket: numero,
      numero_dia: data[0].numero_dia,
      lineas: data,
      vendido_en: data[0].vendido_en,
      vendedor: data[0].vendedor || '—',
      unidades: validas.reduce((s, l) => s + l.cantidad, 0),
      total,
      anulado: data.filter((l) => l.anulada_en).reduce((s, l) => s + Number(l.total), 0),
      tasa: tasa ? Number(tasa) : null,
      totalUSD: tasa ? total / Number(tasa) : null,
      estado: validas.length === 0 ? 'Anulada' : validas.length < data.length ? 'Anulación parcial' : 'Completa',
      generadoEn: new Date(),
      generadoPor: $('#usuario-nombre').textContent,
    };
    const dia = await db.rpc('estado_dia', { p_fecha: diaEnZona(data[0].vendido_en) });
    ventaAbierta.diaCerrado = Boolean(dia.data?.cerrado);
    pintarVenta(ventaAbierta);
    if (!$('#dlg-venta').open) $('#dlg-venta').showModal();
  }

  function pintarVenta(v) {
    $('#venta-titulo').textContent = `Venta #${v.numero_dia ?? v.numero} del ${fmtFechaCorta.format(aFecha(diaEnZona(v.vendido_en)))}`;
    const n = v.lineas.length;
    $('#venta-meta').textContent = `${fmtHora.format(new Date(v.vendido_en))} · vendedor: ${v.vendedor} · ${n} ${n === 1 ? 'producto' : 'productos'} · consecutivo ${v.numero}`;
    $('#venta-estado').hidden = v.estado === 'Completa';
    $('#venta-estado').textContent = v.estado;
    $('#venta-lineas').replaceChildren(...v.lineas.map((l) => el('tr', l.anulada_en ? { class: 'anulada' } : {},
      celda(l.codigo ? el('span', { class: 'codigo codigo-sm' }, l.codigo) : '—'),
      celda(l.nombre),
      celda(fmtNumero.format(l.cantidad), 'num'),
      celda(fmtCOP.format(l.precio_unitario), 'num'),
      celda(fmtCOP.format(l.total), 'num'),
      celda(l.anulada_en ? el('span', { class: 'etiqueta-anulada' }, 'Anulada') : 'Vendida'),
    )));
    $('#venta-total').textContent = fmtCOP.format(v.total);
    $('#venta-total-usd').textContent = v.totalUSD != null
      ? `≈ ${fmtUSD.format(v.totalUSD)} (tasa de ese momento: ${fmtCOP.format(v.tasa)})` : '';
    $('#btn-venta-anular').hidden = v.estado === 'Anulada' || v.diaCerrado;
    $('#btn-venta-imprimir').hidden = v.estado === 'Anulada';
    $('#venta-anulado').hidden = !v.anulado;
    $('#venta-anulado').textContent = v.anulado ? `Anulado: ${fmtCOP.format(v.anulado)} (no suma en el total)` : '';
  }

  $('#form-buscar-venta').addEventListener('submit', (e) => {
    e.preventDefault();
    const numero = Number(e.currentTarget.numero.value);
    if (!Number.isInteger(numero) || numero < 1) { toast('Escribe un número de venta válido.', 'error'); return; }
    abrirVentaNumero(numero);
  });

  $('#btn-venta-anular').addEventListener('click', () => {
    const v = ventaAbierta;
    abrirAnularTicket({
      ticket: v.ticket, numero_dia: v.numero_dia, vendido_en: v.vendido_en,
      lineas: v.lineas.map((l) => ({ cantidad: l.cantidad, nombre: l.nombre, anulada: Boolean(l.anulada_en) })),
    });
  });

  $('#btn-venta-pdf').addEventListener('click', async (e) => {
    if (!ventaAbierta) return;
    const boton = e.currentTarget;
    boton.disabled = true;
    try {
      await window.Exportar.pdfVenta(ventaAbierta);
    } catch (error) {
      toast(`No se pudo generar el PDF: ${error.message}`, 'error');
    } finally {
      boton.disabled = false;
    }
  });

  // ------------------------------------------------------------------
  // Administración (atención al público): tickets de hoy, sin dinero
  // ------------------------------------------------------------------

  let ticketAnulando = null;   // ticket completo que se va a anular

  async function cargarTickets() {
    const r = await llamar('tickets_del_dia', {});
    if (r.ok === false) { toast(`No se pudieron cargar los tickets: ${r.error}`, 'error'); return; }
    const tickets = r;
    const cerrado = estado.estadoDia?.cerrado;
    const vigentes = tickets.filter((t) => !t.anulado).length;
    $('#tickets-subtitulo').textContent = `${mayuscula(fmtDiaLargo.format(aFecha(estado.estadoDia?.hoy || hoyEnZona())))} · `
      + `${vigentes} ${vigentes === 1 ? 'ticket' : 'tickets'}${cerrado ? ' · día cerrado' : ''}`;
    $('#lista-tickets').replaceChildren(...tickets.map((t) => el('li', { class: t.anulado ? 'ticket anulado' : 'ticket' },
      el('div', { class: 'ticket-encabezado' },
        el('strong', { class: 'ticket-numero' }, `#${t.numero_dia}`),
        el('span', {}, `${fmtHora.format(new Date(t.vendido_en))} · ${t.vendedor || '—'}`),
        el('span', { class: 'ticket-consecutivo' }, `consecutivo ${t.ticket}`),
        t.anulado ? el('span', { class: 'etiqueta-anulada' }, 'Anulado')
          : t.lineas_anuladas ? el('span', { class: 'etiqueta-anulada' }, 'Anulación parcial') : null),
      el('ul', { class: 'ticket-lineas' }, ...t.lineas.map((l) => el('li', l.anulada ? { class: 'anulada' } : {},
        el('span', { class: 'ticket-cantidad' }, `${fmtNumero.format(l.cantidad)} ×`),
        l.codigo ? el('span', { class: 'codigo codigo-sm' }, l.codigo) : null,
        el('span', {}, l.nombre)))),
      !t.anulado && !cerrado
        ? el('button', { type: 'button', class: 'btn btn-peligro-suave btn-sm ticket-anular', onclick: () => abrirAnularTicket(t) }, 'Anular ticket')
        : null,
    )));
    $('#vacio-tickets').hidden = tickets.length > 0;
  }

  $('#btn-tickets-actualizar').addEventListener('click', () => { cargarEstadoDia(); cargarTickets(); });

  function abrirAnularTicket(t) {
    ticketAnulando = t;
    ventaAnulando = null;
    $('#form-anular').reset();
    mostrarError('#anular-error', '');
    $('#anular-titulo').textContent = `Anular ticket #${t.numero_dia}`;
    const productos = t.lineas.filter((l) => !l.anulada).map((l) => `${l.cantidad} × ${l.nombre}`).join(', ');
    $('#anular-detalle').textContent = `el ticket #${t.numero_dia} de las ${fmtHora.format(new Date(t.vendido_en))} (${productos})`;
    $('#dlg-anular').showModal();
    (esJefe() ? $('#form-anular [type="submit"]') : $('#form-anular').clave).focus();
  }

  function abrirAnular(v) {
    ventaAnulando = v;
    ticketAnulando = null;
    $('#form-anular').reset();
    mostrarError('#anular-error', '');
    $('#anular-titulo').textContent = 'Anular venta';
    $('#anular-detalle').textContent = `${v.cantidad} × ${v.nombre} (${fmtCOP.format(v.total)})${v.numero_dia ? ` de la venta #${v.numero_dia}` : ''}, ${fmtFecha.format(new Date(v.vendido_en))}`;
    $('#dlg-anular').showModal();
    // El jefe no teclea clave (con su usuario ya está autorizado).
    (esJefe() ? $('#form-anular [type="submit"]') : $('#form-anular').clave).focus();
  }

  // Anular devuelve unidades al inventario: necesita la clave del jefe.
  $('#form-anular').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!esJefe() && !form.clave.value) { form.clave.focus(); return mostrarError('#anular-error', 'Falta la clave del jefe.', 'clave'); }
    conBotonOcupado(form, async () => {
      const r = ticketAnulando
        ? await llamar('anular_ticket', { p_ticket: ticketAnulando.ticket, p_clave_jefe: form.clave.value || null })
        : await llamar('anular_venta', { p_venta_id: ventaAnulando.id, p_clave_jefe: form.clave.value || null });
      form.clave.value = '';
      if (!r.ok) {
        mostrarError('#anular-error', r.error, r.campo);
        form.clave.focus();
        return;
      }
      $('#dlg-anular').close();
      toast(ticketAnulando ? `Ticket #${ticketAnulando.numero_dia} anulado: las unidades volvieron al inventario` : 'Venta anulada: las unidades volvieron al inventario');
      if (!$('#seccion-cierre').hidden) cargarCierre();
      if (!$('#seccion-administracion').hidden) cargarTickets();
      if ($('#dlg-venta').open && ventaAbierta) abrirVentaNumero(ventaAbierta.ticket);
      sincronizarInventario();
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
          .select('codigo, nombre, descripcion, categoria, cantidad, precio_cop').order('categoria').order('nombre'));
        await window.Exportar.excel(cierre, inventario);
      } else if (tipo === 'pdf-detallado') {
        await window.Exportar.pdfDetallado(cierre);
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
  $('#btn-pdf-detallado').addEventListener('click', (e) => exportar(e.currentTarget, 'pdf-detallado'));

  // Botones "Cancelar" de todos los diálogos
  document.querySelectorAll('[data-cerrar]').forEach((boton) => {
    boton.addEventListener('click', () => boton.closest('dialog').close());
  });

  iniciar();
})();
