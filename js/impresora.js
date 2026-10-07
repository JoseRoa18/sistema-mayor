// Tickets en la mini impresora térmica Bluetooth "gatito" (GB01/GB02/GB03, MX05/MX06/MX08/MX10,
// YT01, X6… y la versión nueva MXW01).
//
// Funciona desde el navegador con Web Bluetooth (Google Chrome o Edge en Android o en computador;
// en iPhone no hay Web Bluetooth: ahí se guarda la imagen del ticket y se imprime con la app
// de la impresora). El ticket se dibuja en un lienzo de 384 puntos de ancho (papel de 57 mm a
// 203 ppp), se pasa a blanco y negro y se envía línea por línea con el protocolo de la impresora.
(function () {
  'use strict';

  const ANCHO = 384;                  // puntos por línea
  const BYTES_LINEA = ANCHO / 8;      // 48 bytes por línea (1 bit por punto)
  const SERVICIO = 0xae30;            // servicio de impresión
  const SERVICIO_ANUNCIO = 0xaf30;    // el que anuncian muchas al buscar
  const CAR_ESCRITURA = 0xae01;
  const CAR_AVISOS = 0xae02;
  const CAR_DATOS = 0xae03;           // solo MXW01: por aquí va la imagen
  const PREFIJOS = ['GB0', 'GT0', 'MX', 'YT0', 'X5', 'X6', 'X7', 'X8', 'BQ', 'AI0', 'LY0', 'EWTTO'];
  const ZONA = (window.CONFIG && window.CONFIG.ZONA_HORARIA) || 'America/Caracas';
  const CLAVE_AJUSTES = 'sm-impresora';
  const UMBRAL = 165;                 // más claro que esto = blanco (texto un poco más grueso)

  // Intensidad del calor. Valores con los dos bytes iguales: sirven igual en todos los
  // modelos, lean el número como lo lean.
  const ENERGIA = { claro: 0x3030, normal: 0x6060, oscuro: 0xa0a0 };
  const INTENSIDAD_MXW = { claro: 0x40, normal: 0x70, oscuro: 0xa0 };

  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- Ajustes de este equipo ----------------

  const AJUSTES_BASE = { auto: true, intensidad: 'normal', compatible: false, nombre: '', id: '' };
  function ajustes() {
    try { return { ...AJUSTES_BASE, ...JSON.parse(localStorage.getItem(CLAVE_AJUSTES) || '{}') }; }
    catch { return { ...AJUSTES_BASE }; }
  }
  function guardarAjustes(cambios) {
    const nuevos = { ...ajustes(), ...cambios };
    try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(nuevos)); } catch { /* sin almacenamiento: solo por esta vez */ }
    return nuevos;
  }

  // ---------------- Protocolo ----------------

  // CRC-8 (polinomio 0x07) de los datos de cada comando.
  const TABLA_CRC = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    TABLA_CRC[i] = c;
  }
  const crc8 = (datos) => datos.reduce((c, b) => TABLA_CRC[(c ^ b) & 0xff], 0);

  // Cada comando: prefijo, código, 0x00, largo (2 bytes), datos, CRC-8 de los datos y 0xFF.
  function comando(prefijo, codigo, datos) {
    const d = Uint8Array.from(datos);
    const salida = new Uint8Array(prefijo.length + 4 + d.length + 2);
    salida.set(prefijo, 0);
    salida.set([codigo, 0x00, d.length & 0xff, (d.length >> 8) & 0xff], prefijo.length);
    salida.set(d, prefijo.length + 4);
    salida[salida.length - 2] = crc8(d);
    salida[salida.length - 1] = 0xff;
    return salida;
  }

  function unir(partes) {
    const total = partes.reduce((s, p) => s + p.length, 0);
    const salida = new Uint8Array(total);
    let i = 0;
    for (const p of partes) { salida.set(p, i); i += p.length; }
    return salida;
  }

  // Lienzo → líneas de 48 bytes. Punto negro = 1; el primer punto de cada byte es el bit menos significativo.
  function aLineas(lienzo) {
    const { data } = lienzo.getContext('2d').getImageData(0, 0, ANCHO, lienzo.height);
    const lineas = [];
    for (let y = 0; y < lienzo.height; y++) {
      const fila = new Uint8Array(BYTES_LINEA);
      for (let x = 0; x < ANCHO; x++) {
        const i = (y * ANCHO + x) * 4;
        const luz = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (luz < UMBRAL) fila[x >> 3] |= 1 << (x & 7);
      }
      lineas.push(fila);
    }
    return lineas;
  }

  // Modelos clásicos (GB0x, MX0x, YT01, X6…): todo va por un solo canal.
  function trabajoClasico(lineas, intensidad) {
    const c = (codigo, datos) => comando([0x51, 0x78], codigo, datos);
    const energia = ENERGIA[intensidad] || ENERGIA.normal;
    const avance = 112;   // papel que sale al final (14 mm) para poder cortar
    return unir([
      c(0xa3, [0x00]),                                    // estado del equipo
      c(0xa4, [0x32]),                                    // calidad: 200 ppp
      c(0xbd, [0x20]),                                    // velocidad
      c(0xaf, [energia & 0xff, (energia >> 8) & 0xff]),   // calor
      c(0xbe, [0x01]),                                    // aplicar calor (modo texto)
      c(0xa9, [0x00]),                                    // actualizar
      c(0xa6, [0xaa, 0x55, 0x17, 0x38, 0x44, 0x5f, 0x5f, 0x5f, 0x44, 0x38, 0x2c]),   // inicio de impresión
      ...lineas.map((l) => c(0xa2, l)),                   // una línea de puntos
      c(0xa6, [0xaa, 0x55, 0x17, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x17]),   // fin de impresión
      c(0xbd, [0x08]),
      c(0xa1, [avance & 0xff, (avance >> 8) & 0xff]),     // avanzar papel
      c(0xa3, [0x00]),
    ]);
  }

  const tipoDe = (nombre) => (/^MXW/i.test(nombre || '') ? 'mxw01' : 'clasico');

  // Qué navegador es (para explicar por qué no hay Bluetooth y ofrecer una salida).
  function navegador() {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    let nombre = 'este navegador';
    if (navigator.brave) nombre = 'Brave';
    else if (/SamsungBrowser/i.test(ua)) nombre = 'Samsung Internet';
    else if (/FBAN|FBAV|FB_IAB/i.test(ua)) nombre = 'el navegador de Facebook';
    else if (/Instagram/i.test(ua)) nombre = 'el navegador de Instagram';
    else if (/WhatsApp/i.test(ua)) nombre = 'el navegador de WhatsApp';
    else if (/MiuiBrowser/i.test(ua)) nombre = 'el navegador de Xiaomi';
    else if (/HuaweiBrowser/i.test(ua)) nombre = 'el navegador de Huawei';
    else if (/Firefox|FxiOS/i.test(ua)) nombre = 'Firefox';
    else if (/OPR\/|Opera/i.test(ua)) nombre = 'Opera';
    else if (/; wv\)/.test(ua)) nombre = 'el navegador de otra aplicación';
    else if (/CriOS/i.test(ua)) nombre = 'Chrome de iPhone';
    else if (/Safari/i.test(ua) && !/Chrome|Chromium/i.test(ua)) nombre = 'Safari';
    return { ios, android, brave: Boolean(navigator.brave), nombre, seguro: window.isSecureContext !== false };
  }

  // ---------------- Conexión Bluetooth ----------------

  let dispositivo = null;
  let canal = null;          // { escritura, datos, avisos }
  let pausada = false;       // la impresora pidió esperar (búfer lleno)
  let esperandoAviso = null; // { codigo, resolver }
  const oyentes = new Set();
  const avisar = () => oyentes.forEach((fn) => { try { fn(estado()); } catch { /* nada */ } });

  function estado() {
    return {
      soportada: Boolean(navigator.bluetooth),
      conectada: Boolean(dispositivo && dispositivo.gatt && dispositivo.gatt.connected && canal),
      nombre: (dispositivo && dispositivo.name) || ajustes().nombre || '',
      recordada: Boolean(ajustes().id),
      ocupada: Boolean(cola.ocupada),
    };
  }

  function alAviso(evento) {
    const dv = evento.target.value;
    const v = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    if (v[0] === 0x51 && v[1] === 0x78 && v[2] === 0xae) pausada = v[6] === 0x10;   // control de flujo
    if (esperandoAviso && v[2] === esperandoAviso.codigo) {
      const { resolver } = esperandoAviso;
      esperandoAviso = null;
      resolver(v.subarray(6, 6 + (v[4] | (v[5] << 8))));
    }
  }

  function esperarRespuesta(codigo, ms) {
    return new Promise((resolver) => {
      esperandoAviso = { codigo, resolver };
      setTimeout(() => { if (esperandoAviso && esperandoAviso.codigo === codigo) { esperandoAviso = null; resolver(null); } }, ms);
    });
  }

  function alDesconectar() {
    canal = null;
    pausada = false;
    avisar();
  }

  async function abrirCanal() {
    const servidor = await conTiempo(dispositivo.gatt.connect(), 12000, 'La impresora no respondió. ¿Está encendida y cerca?');
    const servicio = await servidor.getPrimaryService(SERVICIO);
    const nuevo = { escritura: await servicio.getCharacteristic(CAR_ESCRITURA), datos: null, avisos: null };
    try {
      nuevo.avisos = await servicio.getCharacteristic(CAR_AVISOS);
      await nuevo.avisos.startNotifications();
      nuevo.avisos.addEventListener('characteristicvaluechanged', alAviso);
    } catch { /* algunas no avisan: se imprime igual */ }
    if (tipoDe(dispositivo.name) === 'mxw01') nuevo.datos = await servicio.getCharacteristic(CAR_DATOS);
    canal = nuevo;
    guardarAjustes({ id: dispositivo.id, nombre: dispositivo.name || 'Impresora' });
    avisar();
  }

  function conTiempo(promesa, ms, mensaje) {
    return Promise.race([promesa, esperar(ms).then(() => { throw new Error(mensaje); })]);
  }

  function prepararDispositivo(d) {
    if (dispositivo && dispositivo !== d) dispositivo.removeEventListener('gattserverdisconnected', alDesconectar);
    dispositivo = d;
    dispositivo.addEventListener('gattserverdisconnected', alDesconectar);
  }

  // Abre la lista de impresoras (necesita un toque del usuario).
  async function conectar({ todos = false } = {}) {
    if (!navigator.bluetooth) throw new Error('Este navegador no puede usar Bluetooth. Usa Google Chrome en Android o en el computador.');
    const opciones = todos
      ? { acceptAllDevices: true, optionalServices: [SERVICIO, SERVICIO_ANUNCIO] }
      : {
        filters: [{ services: [SERVICIO_ANUNCIO] }, { services: [SERVICIO] }, ...PREFIJOS.map((p) => ({ namePrefix: p }))],
        optionalServices: [SERVICIO, SERVICIO_ANUNCIO],
      };
    // Sin adaptador o con el Bluetooth apagado: decirlo en vez de no hacer nada.
    if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability().catch(() => true))) {
      throw new Error('El Bluetooth de este equipo está apagado o no está disponible. Enciéndelo y vuelve a tocar "Conectar impresora".');
    }
    let elegido;
    try {
      elegido = await navigator.bluetooth.requestDevice(opciones);
    } catch (error) {
      if (error.name === 'NotFoundError' && /cancel/i.test(error.message)) return false;   // cerró la lista sin elegir
      if (error.name === 'NotFoundError') {
        throw new Error('No se pudo buscar la impresora: enciende el Bluetooth del equipo (en Android también la Ubicación) y vuelve a intentar.');
      }
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
        throw new Error('El navegador no dio permiso para usar Bluetooth. En Android: Ajustes → Aplicaciones → Chrome → Permisos → activa "Dispositivos cercanos" y "Ubicación".');
      }
      throw error;
    }
    prepararDispositivo(elegido);
    try {
      await abrirCanal();
    } catch (error) {
      throw new Error(error.name === 'NotFoundError' || /service/i.test(error.message)
        ? `"${elegido.name || 'Ese equipo'}" no parece una impresora gatito compatible.`
        : error.message);
    }
    return true;
  }

  // Vuelve a conectar la impresora de siempre sin abrir la lista. Después de recargar la página
  // solo se puede si Chrome recuerda los permisos (getDevices; ver README).
  let reconectando = null;   // un solo intento a la vez
  function reconectar() {
    if (estado().conectada) return Promise.resolve(true);
    if (!navigator.bluetooth) return Promise.resolve(false);
    if (!reconectando) reconectando = intentarReconectar().finally(() => { reconectando = null; });
    return reconectando;
  }

  async function intentarReconectar() {
    try {
      if (!dispositivo && navigator.bluetooth.getDevices && ajustes().id) {
        const conocidos = await navigator.bluetooth.getDevices();
        const d = conocidos.find((x) => x.id === ajustes().id);
        if (d) prepararDispositivo(d);
      }
      if (!dispositivo) return false;
      try {
        await abrirCanal();
      } catch (error) {
        // Chrome a veces necesita "oír" a la impresora antes de poder conectarse.
        if (!dispositivo.watchAdvertisements) throw error;
        await esperarAnuncio(dispositivo, 8000);
        await abrirCanal();
      }
      return true;
    } catch {
      return false;
    }
  }

  function esperarAnuncio(d, ms) {
    return new Promise((resolver, rechazar) => {
      const controlador = new AbortController();
      const tiempo = setTimeout(() => { controlador.abort(); rechazar(new Error('La impresora no responde.')); }, ms);
      d.addEventListener('advertisementreceived', () => {
        clearTimeout(tiempo);
        controlador.abort();
        resolver();
      }, { once: true });
      d.watchAdvertisements({ signal: controlador.signal }).catch((error) => { clearTimeout(tiempo); rechazar(error); });
    });
  }

  function desconectar() {
    if (dispositivo && dispositivo.gatt && dispositivo.gatt.connected) dispositivo.gatt.disconnect();
    canal = null;
    avisar();
  }

  function olvidar() {
    desconectar();
    if (dispositivo) dispositivo.removeEventListener('gattserverdisconnected', alDesconectar);
    dispositivo = null;
    guardarAjustes({ id: '', nombre: '' });
    avisar();
  }

  // Envía en pedazos. Si un pedazo grande falla, sigue con pedazos pequeños.
  async function enviar(bytes, caracteristica, compatible) {
    let tramo = compatible ? 20 : 180;
    const pausaEntreTramos = compatible ? 8 : 2;
    for (let i = 0; i < bytes.length;) {
      let espera = 0;
      while (pausada && espera < 10000) { await esperar(20); espera += 20; }
      const parte = bytes.subarray(i, i + tramo);
      try {
        if (caracteristica.writeValueWithoutResponse) await caracteristica.writeValueWithoutResponse(parte);
        else await caracteristica.writeValue(parte);
      } catch (error) {
        if (tramo > 20 && estado().conectada) { tramo = 20; continue; }   // reintenta este pedazo más pequeño
        throw error;
      }
      i += parte.length;
      await esperar(pausaEntreTramos);
    }
  }

  async function imprimirMxw01(lineas, opciones) {
    const c = (codigo, datos) => comando([0x22, 0x21], codigo, datos);
    const todas = [...lineas];
    while (todas.length < 90) todas.push(new Uint8Array(BYTES_LINEA));   // mínimo que acepta
    for (let i = 0; i < 100; i++) todas.push(new Uint8Array(BYTES_LINEA)); // papel para cortar
    await enviar(c(0xa2, [INTENSIDAD_MXW[opciones.intensidad] || INTENSIDAD_MXW.normal]), canal.escritura, true);
    const estadoEquipo = esperarRespuesta(0xa1, 1500);
    await enviar(c(0xa1, [0x00]), canal.escritura, true);
    await estadoEquipo;
    const aceptado = esperarRespuesta(0xa9, 2500);
    await enviar(c(0xa9, [todas.length & 0xff, (todas.length >> 8) & 0xff, 0x30, 0x00]), canal.escritura, true);
    const respuesta = await aceptado;
    if (respuesta && respuesta[0] !== 0) throw new Error('La impresora no aceptó el ticket: revisa el papel y la batería.');
    await enviar(unir(todas), canal.datos, opciones.compatible);
    const fin = esperarRespuesta(0xaa, 30000);
    await enviar(c(0xad, [0x00]), canal.escritura, true);
    await fin;
  }

  // Los trabajos van en fila: si se venden dos tickets seguidos, salen uno tras otro.
  const cola = { ultima: Promise.resolve(), ocupada: 0 };

  function imprimir(ticket) {
    const trabajo = cola.ultima.then(async () => {
      if (!estado().conectada && !(await reconectar())) {
        const error = new Error('No hay impresora conectada.');
        error.sinImpresora = true;
        throw error;
      }
      const { intensidad, compatible } = ajustes();
      const lineas = aLineas(dibujarTicket(ticket));
      if (tipoDe(dispositivo.name) === 'mxw01') await imprimirMxw01(lineas, { intensidad, compatible });
      else await enviar(trabajoClasico(lineas, intensidad), canal.escritura, compatible);
    });
    cola.ocupada++;
    avisar();
    const fin = () => { cola.ocupada--; avisar(); };
    trabajo.then(fin, fin);
    cola.ultima = trabajo.catch(() => {});
    return trabajo;
  }

  // ---------------- Dibujo del ticket ----------------

  const SANS = 'Arial, "Helvetica Neue", Roboto, "Segoe UI", sans-serif';
  const fmtFecha = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
  const fmtCOP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  const limpio = (t) => String(t ?? '').replace(/[  ]/g, ' ');

  // Corta el texto en renglones que quepan; el último termina en "…" si no cabe todo.
  function renglones(ctx, texto, ancho, maximo) {
    const palabras = limpio(texto).trim().split(/\s+/).filter(Boolean);
    const salida = [];
    let actual = '';
    for (const p of palabras) {
      const prueba = actual ? `${actual} ${p}` : p;
      if (ctx.measureText(prueba).width <= ancho || !actual) actual = prueba;
      else { salida.push(actual); actual = p; }
    }
    if (actual) salida.push(actual);
    if (salida.length > maximo) {
      let ultimo = salida.slice(maximo - 1).join(' ');
      while (ultimo.length > 1 && ctx.measureText(`${ultimo}…`).width > ancho) ultimo = ultimo.slice(0, -1).trimEnd();
      salida.splice(maximo - 1, salida.length, `${ultimo}…`);
    }
    // Una palabra sola más ancha que el papel también se recorta.
    return salida.map((r) => {
      let t = r;
      while (t.length > 1 && ctx.measureText(t).width > ancho) t = t.slice(0, -2) + '…';
      return t;
    });
  }

  // Letra lo más grande posible (sin pasar de `px`) para que el texto quepa en `ancho`.
  function ajustarLetra(ctx, texto, px, minimo, ancho, peso = 'bold') {
    let tam = px;
    ctx.font = `${peso} ${tam}px ${SANS}`;
    while (tam > minimo && ctx.measureText(texto).width > ancho) {
      tam -= 2;
      ctx.font = `${peso} ${tam}px ${SANS}`;
    }
    return tam;
  }

  // ticket = { numeroDia, consecutivo, fecha, lineas: [{ codigo, nombre, cantidad }], total, vendedor,
  //            reimpresion, prueba }
  function dibujarTicket(t) {
    const lienzo = document.createElement('canvas');
    lienzo.width = ANCHO;
    lienzo.height = 420 + t.lineas.length * 190;   // de sobra; al final se recorta
    const ctx = lienzo.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    const M = 6;                      // margen a cada lado
    const util = ANCHO - M * 2;
    let y = 4;

    const centrado = (texto, px, peso = 'bold', alto = 1.18) => {
      ajustarLetra(ctx, texto, px, 14, util, peso);
      ctx.textAlign = 'center';
      ctx.fillText(texto, ANCHO / 2, y);
      y += Math.round(px * alto);
    };
    const raya = (grosor = 3, discontinua = false) => {
      y += 6;
      if (discontinua) for (let x = M; x < ANCHO - M; x += 14) ctx.fillRect(x, y, 8, grosor);
      else ctx.fillRect(M, y, util, grosor);
      y += grosor + 8;
    };

    // Encabezado: número del ticket, consecutivo, fecha y hora
    if (t.prueba) centrado('PRUEBA DE IMPRESIÓN', 26);
    centrado(`TICKET #${t.numeroDia ?? t.consecutivo ?? '-'}`, 50);
    if (t.consecutivo != null) centrado(`Consecutivo ${t.consecutivo}`, 20, 'normal');
    const fecha = new Date(t.fecha || Date.now());
    centrado(`${fmtFecha.format(fecha)}   ${limpio(fmtHora.format(fecha))}`, 26);
    raya();

    // Productos: cantidad y código en grande, el nombre recortado debajo
    t.lineas.forEach((l, i) => {
      if (i > 0) raya(2, true);
      const cantidad = `${l.cantidad}×`;
      ctx.textAlign = 'left';
      ctx.font = `bold 30px ${SANS}`;
      const anchoCantidad = ctx.measureText(cantidad).width + 12;
      const codigo = limpio(l.codigo || 'SIN CÓDIGO');
      const tam = ajustarLetra(ctx, codigo, 56, 26, util - anchoCantidad);
      ctx.font = `bold 30px ${SANS}`;
      ctx.fillText(cantidad, M, y + Math.max(0, (tam - 30) * 0.75));
      ctx.font = `bold ${tam}px ${SANS}`;
      ctx.fillText(codigo, M + anchoCantidad, y);
      y += Math.round(tam * 1.12);
      ctx.font = `bold 24px ${SANS}`;
      for (const r of renglones(ctx, l.nombre, util, 2)) {
        ctx.fillText(r, M, y);
        y += 28;
      }
    });
    raya();

    // Total y vendedor
    const total = limpio(fmtCOP.format(Number(t.total) || 0));
    ctx.textAlign = 'left';
    ctx.font = `bold 28px ${SANS}`;
    const anchoEtiqueta = ctx.measureText('TOTAL').width + 14;
    const tamTotal = ajustarLetra(ctx, total, 46, 24, util - anchoEtiqueta);
    ctx.font = `bold 28px ${SANS}`;
    ctx.fillText('TOTAL', M, y + Math.max(0, tamTotal - 30));
    ctx.font = `bold ${tamTotal}px ${SANS}`;
    ctx.textAlign = 'right';
    ctx.fillText(total, ANCHO - M, y);
    y += Math.round(tamTotal * 1.2);
    ctx.textAlign = 'left';
    ctx.font = `bold 26px ${SANS}`;
    for (const r of renglones(ctx, `Vendedor: ${t.vendedor || '-'}`, util, 1)) { ctx.fillText(r, M, y); y += 32; }
    if (t.reimpresion) { y += 4; centrado('REIMPRESIÓN', 20, 'normal'); }
    y += 10;

    const recortado = document.createElement('canvas');
    recortado.width = ANCHO;
    recortado.height = y;
    const c2 = recortado.getContext('2d');
    c2.fillStyle = '#fff';
    c2.fillRect(0, 0, ANCHO, y);
    c2.drawImage(lienzo, 0, 0);
    return recortado;
  }

  // Imagen PNG en blanco y negro puro (como sale en el papel), para la vista previa
  // o para imprimir desde la app de la impresora.
  function imagenTicket(ticket) {
    const lienzo = dibujarTicket(ticket);
    const ctx = lienzo.getContext('2d');
    const img = ctx.getImageData(0, 0, lienzo.width, lienzo.height);
    for (let i = 0; i < img.data.length; i += 4) {
      const luz = img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
      const v = luz < UMBRAL ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return lienzo;
  }

  window.Impresora = {
    estado,
    navegador,
    ajustes,
    guardarAjustes,
    conectar,
    reconectar,
    desconectar,
    olvidar,
    imprimir,
    imagenTicket,
    alCambiar: (fn) => { oyentes.add(fn); return () => oyentes.delete(fn); },
    // Para las pruebas
    _interno: { crc8, comando, aLineas, trabajoClasico, dibujarTicket, ANCHO },
  };
})();
