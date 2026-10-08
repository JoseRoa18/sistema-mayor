'use strict';

// Reportes en Excel (ExcelJS) y PDF (jsPDF + AutoTable), y plantilla/lectura
// de Excel para importar productos.
// Las librerías se descargan solo la primera vez que se usan.
window.Exportar = (function () {
  const LIBRERIAS = {
    excel: ['https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js'],
    pdf: [
      'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
      'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js',
    ],
  };

  const cargadas = {};
  function cargarScript(url) {
    cargadas[url] ??= new Promise((resolver, rechazar) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = resolver;
      s.onerror = () => { delete cargadas[url]; rechazar(new Error('sin conexión para descargar la librería')); };
      document.head.append(s);
    });
    return cargadas[url];
  }
  async function cargar(tipo) {
    for (const url of LIBRERIAS[tipo]) await cargarScript(url);   // en orden: AutoTable necesita jsPDF
  }

  // ---------------- Formatos ----------------

  const ZONA = window.CONFIG.ZONA_HORARIA;
  const cop = new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2,
    trailingZeroDisplay: 'stripIfInteger',
  });
  const usd = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  const num = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
  const porcentaje = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const plural = (n, uno, varios) => `${num.format(n)} ${n === 1 ? uno : varios}`;
  const fechaHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, dateStyle: 'medium', timeStyle: 'short' });
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });

  // Excel no maneja zonas horarias: se guarda la hora "de reloj" de la zona del sistema.
  function horaLocalParaExcel(fechaIso) {
    const p = Object.fromEntries(partes.formatToParts(new Date(fechaIso)).map((x) => [x.type, x.value]));
    return new Date(Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
  }

  const nombreArchivo = (c, extension) => (c.unDia
    ? `Cierre-del-dia-${c.desde}.${extension}`
    : `Reporte-${c.desde}_a_${c.hasta}.${extension}`);
  const tituloReporte = (c) => (c.unDia ? 'Cierre del día' : 'Reporte de ventas');
  // Quién cerró el día (o cuántos días del periodo se cerraron).
  function textoCierre(c) {
    const cierres = c.cierres || [];
    if (!c.unDia) return `${cierres.length} de ${c.dias} días cerrados`;
    return cierres[0] ? `Cerrado por ${cierres[0].cerrado_por} el ${fechaHora.format(new Date(cierres[0].cerrado_en))}` : 'Día sin cierre';
  }
  const diaLargo = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', dateStyle: 'full' });
  const TIPO_MOVIMIENTO = { entrada: 'Entrada', salida: 'Salida', anulacion: 'Venta anulada' };
  const unidadesDe = (c, tipos) => c.movimientos.filter((m) => tipos.includes(m.tipo)).reduce((s, m) => s + m.cantidad, 0);
  const mayuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  function descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Colores del sistema (los mismos de la app)
  const COLOR = {
    primario: '0F766E', primarioClaro: 'F0FDFA', texto: '0F172A', gris: '64748B', grisClaro: 'F8FAFC',
    borde: 'E2E8F0', rojo: 'B91C1C', rojoClaro: 'FEE2E2', ambar: '92400E', ambarClaro: 'FEF3C7',
  };

  // ================================================================
  // Excel
  // ================================================================

  const FMT_COP = '"$" #,##0';
  const FMT_USD = '"US$" #,##0.00';
  const FMT_NUM = '#,##0';

  async function excel(c, inventario) {
    await cargar('excel');
    const libro = new window.ExcelJS.Workbook();
    libro.creator = 'Sistema Mayor';
    libro.created = new Date();

    const relleno = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } });
    const bordeFino = { style: 'thin', color: { argb: `FF${COLOR.borde}` } };

    // Título de cada hoja: nombre del sistema, título y fecha.
    function encabezado(hoja, titulo, columnas) {
      hoja.mergeCells(1, 1, 1, columnas);
      hoja.getCell(1, 1).value = `Sistema Mayor · ${titulo}`;
      hoja.getCell(1, 1).font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
      hoja.getCell(1, 1).fill = relleno(COLOR.primario);
      hoja.getCell(1, 1).alignment = { vertical: 'middle', indent: 1 };
      hoja.getRow(1).height = 30;
      hoja.mergeCells(2, 1, 2, columnas);
      hoja.getCell(2, 1).value = `${mayuscula(c.periodoTexto)} · generado el ${fechaHora.format(c.generadoEn)} por ${c.generadoPor}`;
      hoja.getCell(2, 1).font = { size: 10, color: { argb: `FF${COLOR.gris}` } };
      hoja.getCell(2, 1).alignment = { indent: 1 };
      hoja.getRow(2).height = 20;
    }

    // Tabla con encabezado de color, filas alternas, bordes, filtro y encabezado fijo.
    function tabla(hoja, filaInicio, columnas, filas) {
      const cab = hoja.getRow(filaInicio);
      columnas.forEach((col, i) => {
        const celda = cab.getCell(i + 1);
        celda.value = col.titulo;
        celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        celda.fill = relleno(COLOR.texto);
        celda.alignment = { vertical: 'middle', horizontal: col.formato ? 'right' : 'left' };
        celda.border = { bottom: bordeFino };
        hoja.getColumn(i + 1).width = col.ancho;
      });
      cab.height = 22;

      filas.forEach((datos, f) => {
        const fila = hoja.getRow(filaInicio + 1 + f);
        columnas.forEach((col, i) => {
          const celda = fila.getCell(i + 1);
          celda.value = datos[i];
          if (col.formato) celda.numFmt = col.formato;
          celda.alignment = { vertical: 'middle', horizontal: col.formato ? 'right' : 'left', wrapText: !col.formato };
          celda.border = { bottom: bordeFino };
          if (f % 2 === 1) celda.fill = relleno(COLOR.grisClaro);
        });
      });

      if (filas.length) {
        hoja.autoFilter = { from: { row: filaInicio, column: 1 }, to: { row: filaInicio + filas.length, column: columnas.length } };
      }
      hoja.views = [{ state: 'frozen', ySplit: filaInicio }];
      return filaInicio + filas.length;   // última fila usada
    }

    function filaTotal(hoja, numFila, valores, columnas) {
      const fila = hoja.getRow(numFila);
      valores.forEach((v, i) => {
        if (v == null) return;
        const celda = fila.getCell(i + 1);
        celda.value = v;
        celda.font = { bold: true };
        celda.fill = relleno(COLOR.primarioClaro);
        celda.border = { top: { style: 'medium', color: { argb: `FF${COLOR.primario}` } } };
        if (columnas[i].formato) { celda.numFmt = columnas[i].formato; celda.alignment = { horizontal: 'right' }; }
      });
    }

    // ---- Hoja: Resumen ----
    const resumen = libro.addWorksheet('Resumen', { properties: { tabColor: { argb: `FF${COLOR.primario}` } } });
    encabezado(resumen, tituloReporte(c), 2);
    resumen.getColumn(1).width = 46;
    resumen.getColumn(2).width = 22;
    const indicadores = [
      ['Total vendido (pesos)', c.totalCOP, FMT_COP, true],
      ['Total vendido (dólares, aprox.)', c.totalUSD ?? 'Sin tasa', FMT_USD],
      ['Ventas registradas (cada carrito cuenta como una)', c.numVentas, FMT_NUM],
      ['Líneas de venta anuladas', c.numAnuladas, FMT_NUM],
      ['Cambios de precio', c.cambiosPrecio.length, FMT_NUM],
      ['Unidades vendidas', c.unidades, FMT_NUM],
      ['Productos distintos vendidos', c.porProducto.length, FMT_NUM],
      ['Unidades que entraron (entradas y anulaciones)', unidadesDe(c, ['entrada', 'anulacion']), FMT_NUM],
      ['Unidades que salieron (sin contar ventas)', unidadesDe(c, ['salida']), FMT_NUM],
      [`Productos por agotarse (${c.stockBajo} o menos)`, c.porAgotarse.length, FMT_NUM],
      ['Productos agotados', c.porAgotarse.filter((p) => p.cantidad <= 0).length, FMT_NUM],
      ['Tasa del dólar actual (1 USD)', c.tasaActual ?? 'Sin definir', FMT_COP],
      ['Cierre', textoCierre(c), '@'],
    ];
    indicadores.forEach(([etiqueta, valor, formato, destacado], i) => {
      const fila = resumen.getRow(4 + i);
      fila.height = destacado ? 28 : 20;
      fila.getCell(1).value = etiqueta;
      fila.getCell(1).font = { color: { argb: `FF${COLOR.gris}` }, bold: destacado };
      fila.getCell(2).value = valor;
      fila.getCell(2).numFmt = formato;
      fila.getCell(2).font = { bold: true, size: destacado ? 16 : 11 };
      fila.getCell(2).alignment = { horizontal: 'right', vertical: 'middle' };
      fila.getCell(1).alignment = { vertical: 'middle', indent: 1 };
      for (const n of [1, 2]) fila.getCell(n).border = { bottom: bordeFino };
      if (destacado) for (const n of [1, 2]) fila.getCell(n).fill = relleno(COLOR.primarioClaro);
    });
    if (c.ventasSinTasa) {
      const nota = resumen.getRow(4 + indicadores.length + 1).getCell(1);
      nota.value = `Nota: ${c.ventasSinTasa} venta(s) se hicieron sin tasa del dólar definida y no suman en dólares.`;
      nota.font = { italic: true, size: 9, color: { argb: `FF${COLOR.gris}` } };
    }

    // ---- Hoja: Ventas (detalle) ----
    const hojaVentas = libro.addWorksheet('Ventas');
    const colVentas = [
      { titulo: 'N.º del día', ancho: 11 },
      { titulo: 'Consecutivo', ancho: 12 },
      c.unDia ? { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' } : { titulo: 'Fecha y hora', ancho: 19, formato: 'd/mm/yyyy h:mm AM/PM' },
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 40 },
      { titulo: 'Categoría', ancho: 15 },
      { titulo: 'Cantidad', ancho: 10, formato: FMT_NUM },
      { titulo: 'Precio unitario', ancho: 16, formato: FMT_COP },
      { titulo: 'Total (pesos)', ancho: 16, formato: FMT_COP },
      { titulo: 'Total (dólares)', ancho: 15, formato: FMT_USD },
      { titulo: 'Vendedor', ancho: 13 },
      { titulo: 'Estado', ancho: 11 },
    ];
    encabezado(hojaVentas, 'Detalle de ventas', colVentas.length);
    const ordenadas = [...c.ventas].sort((a, b) => (a.ticket ?? 0) - (b.ticket ?? 0) || a.id - b.id);
    const ultimaVenta = tabla(hojaVentas, 4, colVentas, ordenadas.map((v) => [
      v.numero_dia ? `#${v.numero_dia}` : '', v.ticket ?? '', horaLocalParaExcel(v.vendido_en), v.codigo || '', v.nombre, v.categoria || '', v.cantidad, Number(v.precio_unitario),
      Number(v.total), v.tasa_usd ? Number(v.total) / Number(v.tasa_usd) : null, v.vendedor, v.anulada_en ? 'Anulada' : 'Vendida',
    ]));
    ordenadas.forEach((v, i) => {
      if (!v.anulada_en) return;
      hojaVentas.getRow(5 + i).eachCell((celda) => {
        celda.font = { italic: true, strike: true, color: { argb: `FF${COLOR.gris}` } };
      });
      hojaVentas.getRow(5 + i).getCell(12).font = { bold: true, color: { argb: `FF${COLOR.rojo}` } };
    });
    if (ordenadas.length) {
      // Los totales suman solo las líneas con estado "Vendida" (no las anuladas).
      const sumaSi = (col) => `SUMIFS(${col}5:${col}${ultimaVenta},L5:L${ultimaVenta},"Vendida")`;
      filaTotal(hojaVentas, ultimaVenta + 1, [
        'TOTAL', null, null, null, `${c.numVentas} ventas`, null,
        { formula: sumaSi('G'), result: c.unidades }, null,
        { formula: sumaSi('I'), result: c.totalCOP },
        { formula: sumaSi('J'), result: c.totalUSD ?? 0 }, null, null,
      ], colVentas);
    } else {
      hojaVentas.getCell(5, 1).value = 'No hubo ventas en este periodo.';
    }

    // ---- Hoja: Ventas detalladas (cada venta con sus productos y su total) ----
    const hojaDet = libro.addWorksheet('Ventas detalladas', { properties: { tabColor: { argb: `FF${COLOR.texto}` } } });
    const colDet = [
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 44 },
      { titulo: 'Categoría', ancho: 15 },
      { titulo: 'Cantidad', ancho: 10, formato: FMT_NUM },
      { titulo: 'Precio unitario', ancho: 16, formato: FMT_COP },
      { titulo: 'Subtotal', ancho: 16, formato: FMT_COP },
      { titulo: 'Estado', ancho: 11 },
    ];
    encabezado(hojaDet, 'Ventas detalladas', colDet.length);
    tabla(hojaDet, 4, colDet, []);
    hojaDet.autoFilter = undefined;
    const porVenta = new Map();
    for (const v of [...c.ventas].sort((a, b) => (a.ticket ?? 0) - (b.ticket ?? 0) || a.id - b.id)) {
      if (!porVenta.has(v.ticket)) porVenta.set(v.ticket, []);
      porVenta.get(v.ticket).push(v);
    }
    let filaDet = 5;
    for (const [, lineas] of porVenta) {
      const primera = lineas[0];
      const anuladas = lineas.filter((l) => l.anulada_en).length;
      const estadoVenta = anuladas === lineas.length ? 'Anulada' : anuladas ? 'Anulación parcial' : '';
      // Encabezado de la venta
      hojaDet.mergeCells(filaDet, 1, filaDet, colDet.length);
      const cab = hojaDet.getCell(filaDet, 1);
      cab.value = `Venta #${primera.numero_dia ?? primera.ticket} · consecutivo ${primera.ticket} · `
        + `${fechaHora.format(new Date(primera.vendido_en))} · vendedor: ${primera.vendedor || '—'}${estadoVenta ? ` · ${estadoVenta.toUpperCase()}` : ''}`;
      cab.font = { bold: true, color: { argb: `FF${estadoVenta === 'Anulada' ? COLOR.rojo : COLOR.texto}` } };
      cab.fill = relleno(COLOR.primarioClaro);
      cab.border = { top: { style: 'thin', color: { argb: `FF${COLOR.primario}` } } };
      hojaDet.getRow(filaDet).height = 20;
      filaDet++;
      // Productos de la venta
      for (const l of lineas) {
        const valores = [l.codigo || '', l.nombre, l.categoria || '', l.cantidad, Number(l.precio_unitario), Number(l.total), l.anulada_en ? 'Anulada' : 'Vendida'];
        valores.forEach((valor, i) => {
          const celda = hojaDet.getCell(filaDet, i + 1);
          celda.value = valor;
          if (colDet[i].formato) { celda.numFmt = colDet[i].formato; celda.alignment = { horizontal: 'right' }; }
          if (l.anulada_en) celda.font = { italic: true, strike: i < 6, color: { argb: `FF${i === 6 ? COLOR.rojo : COLOR.gris}` } };
        });
        filaDet++;
      }
      // Total de la venta (sin las líneas anuladas)
      const totalVenta = lineas.filter((l) => !l.anulada_en).reduce((s, l) => s + Number(l.total), 0);
      hojaDet.getCell(filaDet, 5).value = 'Total venta';
      hojaDet.getCell(filaDet, 5).font = { bold: true };
      hojaDet.getCell(filaDet, 5).alignment = { horizontal: 'right' };
      hojaDet.getCell(filaDet, 6).value = totalVenta;
      hojaDet.getCell(filaDet, 6).numFmt = FMT_COP;
      hojaDet.getCell(filaDet, 6).font = { bold: true };
      filaDet += 2;
    }
    if (porVenta.size) {
      filaTotal(hojaDet, filaDet, ['TOTAL DEL PERIODO', null, `${c.numVentas} ventas`, c.unidades, null, c.totalCOP, null], colDet);
    } else {
      hojaDet.getCell(5, 1).value = 'No hubo ventas en este periodo.';
    }

    // ---- Hoja: Por carrito (una fila por venta) ----
    const hojaCarritos = libro.addWorksheet('Por carrito');
    const colCarritos = [
      { titulo: 'N.º del día', ancho: 11 },
      { titulo: 'Consecutivo', ancho: 12 },
      c.unDia ? { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' } : { titulo: 'Fecha y hora', ancho: 19, formato: 'd/mm/yyyy h:mm AM/PM' },
      { titulo: 'Vendedor', ancho: 16 },
      { titulo: 'Productos', ancho: 11, formato: FMT_NUM },
      { titulo: 'Unidades', ancho: 11, formato: FMT_NUM },
      { titulo: 'Total (pesos)', ancho: 17, formato: FMT_COP },
      { titulo: 'Estado', ancho: 18 },
    ];
    encabezado(hojaCarritos, 'Ventas por carrito', colCarritos.length);
    const carritos = [...c.porCarrito].sort((a, b) => (a.ticket ?? 0) - (b.ticket ?? 0));
    const ultimaCarrito = tabla(hojaCarritos, 4, colCarritos, carritos.map((g) => [
      g.numero_dia ? `#${g.numero_dia}` : '', g.ticket ?? '', horaLocalParaExcel(g.vendido_en), g.vendedor, g.lineas, g.unidades, g.total, g.estado,
    ]));
    carritos.forEach((g, i) => {
      if (g.estado === 'Completa') return;
      hojaCarritos.getRow(5 + i).getCell(8).font = { bold: true, color: { argb: `FF${COLOR.rojo}` } };
    });
    if (carritos.length) {
      filaTotal(hojaCarritos, ultimaCarrito + 1, ['TOTAL', null, null, `${c.numVentas} ventas`, null, c.unidades, c.totalCOP, null], colCarritos);
    } else {
      hojaCarritos.getCell(5, 1).value = 'No hubo ventas en este periodo.';
    }

    // ---- Hoja: Por día (solo si el periodo tiene varios días) ----
    if (!c.unDia) {
      const hojaDia = libro.addWorksheet('Por día');
      const colDia = [
        { titulo: 'Día', ancho: 34 },
        { titulo: 'Ventas', ancho: 10, formato: FMT_NUM },
        { titulo: 'Unidades', ancho: 11, formato: FMT_NUM },
        { titulo: 'Total (pesos)', ancho: 17, formato: FMT_COP },
      ];
      encabezado(hojaDia, 'Ventas por día', colDia.length);
      const ultimaDia = tabla(hojaDia, 4, colDia, c.porDia.map((d) => [
        mayuscula(diaLargo.format(new Date(`${d.fecha}T00:00:00Z`))), d.ventas, d.unidades, d.total,
      ]));
      if (c.porDia.length) filaTotal(hojaDia, ultimaDia + 1, ['TOTAL', c.numVentas, c.unidades, c.totalCOP], colDia);
      else hojaDia.getCell(5, 1).value = 'No hubo ventas en este periodo.';
    }

    // ---- Hoja: Por producto ----
    const hojaProd = libro.addWorksheet('Por producto');
    const colProd = [
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 46 },
      { titulo: 'Unidades', ancho: 11, formato: FMT_NUM },
      { titulo: 'Total (pesos)', ancho: 17, formato: FMT_COP },
      { titulo: '% del total', ancho: 12, formato: '0.0%' },
    ];
    encabezado(hojaProd, 'Ventas por producto', colProd.length);
    const ultimaProd = tabla(hojaProd, 4, colProd, c.porProducto.map((p) => [
      p.codigo || '', p.nombre, p.unidades, p.total, c.totalCOP ? p.total / c.totalCOP : 0,
    ]));
    if (c.porProducto.length) {
      filaTotal(hojaProd, ultimaProd + 1, ['TOTAL', null, c.unidades, c.totalCOP, 1], colProd);
    } else {
      hojaProd.getCell(5, 1).value = 'No hubo ventas en este periodo.';
    }

    // ---- Hoja: Por vendedor ----
    const hojaVend = libro.addWorksheet('Por vendedor');
    const colVend = [
      { titulo: 'Vendedor', ancho: 28 },
      { titulo: 'Ventas', ancho: 10, formato: FMT_NUM },
      { titulo: 'Unidades', ancho: 11, formato: FMT_NUM },
      { titulo: 'Total (pesos)', ancho: 17, formato: FMT_COP },
      { titulo: '% del total', ancho: 12, formato: '0.0%' },
    ];
    encabezado(hojaVend, 'Ventas por vendedor', colVend.length);
    const ultimaVend = tabla(hojaVend, 4, colVend, c.porVendedor.map((v) => [
      v.vendedor, v.ventas, v.unidades, v.total, c.totalCOP ? v.total / c.totalCOP : 0,
    ]));
    if (c.porVendedor.length) {
      filaTotal(hojaVend, ultimaVend + 1, ['TOTAL', c.numVentas, c.unidades, c.totalCOP, 1], colVend);
    } else {
      hojaVend.getCell(5, 1).value = 'No hubo ventas en este periodo.';
    }

    // ---- Hoja: Entradas y salidas ----
    const hojaMov = libro.addWorksheet('Entradas y salidas');
    const colMov = [
      c.unDia ? { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' } : { titulo: 'Fecha y hora', ancho: 19, formato: 'd/mm/yyyy h:mm AM/PM' },
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 40 },
      { titulo: 'Tipo', ancho: 15 },
      { titulo: 'Cantidad', ancho: 10, formato: '+#,##0;-#,##0' },
      { titulo: 'Había', ancho: 9, formato: FMT_NUM },
      { titulo: 'Quedó', ancho: 9, formato: FMT_NUM },
      { titulo: 'Motivo', ancho: 30 },
      { titulo: 'Registrado por', ancho: 15 },
    ];
    encabezado(hojaMov, 'Entradas y salidas de mercancía', colMov.length);
    const movsOrden = [...c.movimientos].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
    tabla(hojaMov, 4, colMov, movsOrden.map((m) => [
      horaLocalParaExcel(m.creado_en), m.codigo || '', m.nombre, TIPO_MOVIMIENTO[m.tipo],
      m.tipo === 'salida' ? -m.cantidad : m.cantidad, m.stock_antes, m.stock_despues,
      m.tipo === 'anulacion' ? `Venta anulada${m.vendedor ? ` (${m.vendedor})` : ''}` : m.motivo, m.usuario,
    ]));
    movsOrden.forEach((m, i) => {
      const celda = hojaMov.getRow(5 + i).getCell(5);
      const sale = m.tipo === 'salida';
      celda.font = { bold: true, color: { argb: `FF${sale ? COLOR.rojo : '166534'}` } };
    });
    if (!movsOrden.length) hojaMov.getCell(5, 1).value = 'No hubo entradas ni salidas en este periodo.';

    // ---- Hoja: Cambios de precio ----
    const hojaPrecios = libro.addWorksheet('Cambios de precio');
    const colPrecios = [
      c.unDia ? { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' } : { titulo: 'Fecha y hora', ancho: 19, formato: 'd/mm/yyyy h:mm AM/PM' },
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 40 },
      { titulo: 'Precio antes', ancho: 15, formato: FMT_COP },
      { titulo: 'Precio ahora', ancho: 15, formato: FMT_COP },
      { titulo: 'Cambiado por', ancho: 15 },
      { titulo: 'Origen', ancho: 13 },
    ];
    encabezado(hojaPrecios, 'Cambios de precio', colPrecios.length);
    const cambiosOrden = [...c.cambiosPrecio].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
    tabla(hojaPrecios, 4, colPrecios, cambiosOrden.map((h) => [
      horaLocalParaExcel(h.creado_en), h.codigo || '', h.nombre,
      h.precio_anterior == null ? null : Number(h.precio_anterior), Number(h.precio_nuevo),
      h.usuario, h.origen === 'importacion' ? 'Excel' : 'Edición',
    ]));
    cambiosOrden.forEach((_, i) => { hojaPrecios.getRow(5 + i).getCell(5).font = { bold: true }; });
    if (!cambiosOrden.length) hojaPrecios.getCell(5, 1).value = 'No hubo cambios de precio en este periodo.';

    // ---- Hoja: Por agotarse ----
    const hojaAgot = libro.addWorksheet('Por agotarse');
    const colAgot = [
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 46 },
      { titulo: 'Quedan', ancho: 10, formato: FMT_NUM },
      { titulo: 'Estado', ancho: 16 },
    ];
    encabezado(hojaAgot, `Productos por agotarse (${c.stockBajo} o menos)`, colAgot.length);
    tabla(hojaAgot, 4, colAgot, c.porAgotarse.map((p) => [
      p.codigo || '', p.nombre, p.cantidad, p.cantidad <= 0 ? 'Agotado' : 'Pocas unidades',
    ]));
    c.porAgotarse.forEach((p, i) => {
      const celda = hojaAgot.getRow(5 + i).getCell(4);
      const agotado = p.cantidad <= 0;
      celda.fill = relleno(agotado ? COLOR.rojoClaro : COLOR.ambarClaro);
      celda.font = { bold: true, color: { argb: `FF${agotado ? COLOR.rojo : COLOR.ambar}` } };
    });
    if (!c.porAgotarse.length) hojaAgot.getCell(5, 1).value = 'Ningún producto está por agotarse.';

    // ---- Hoja: Inventario completo ----
    const hojaInv = libro.addWorksheet('Inventario');
    const colInv = [
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 42 },
      { titulo: 'Descripción', ancho: 32 },
      { titulo: 'Categoría', ancho: 15 },
      { titulo: 'Cantidad', ancho: 10, formato: FMT_NUM },
      { titulo: 'Precio (pesos)', ancho: 16, formato: FMT_COP },
      { titulo: 'Precio (dólares)', ancho: 16, formato: FMT_USD },
    ];
    encabezado(hojaInv, 'Inventario', colInv.length);
    tabla(hojaInv, 4, colInv, inventario.map((p) => [
      p.codigo || '', p.nombre, p.descripcion || '', p.categoria || '', p.cantidad, Number(p.precio_cop),
      c.tasaActual ? Number(p.precio_cop) / c.tasaActual : null,
    ]));

    for (const hoja of libro.worksheets) {
      hoja.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
      hoja.headerFooter = { oddFooter: '&LSistema Mayor&RPágina &P de &N' };
    }

    const datos = await libro.xlsx.writeBuffer();
    descargar(new Blob([datos], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), nombreArchivo(c, 'xlsx'));
  }

  // ================================================================
  // PDF
  // ================================================================

  // Las fuentes básicas del PDF no traen el espacio especial que usa Intl.
  const limpio = (t) => String(t).replace(/[  ]/g, ' ');
  const rgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const MARGEN = 40;

  // ---------------- Base de los PDF: para imprimir en blanco y negro ----------------
  // Sin colores (solo negro y grises): rinde la tinta y cualquier impresora lo imprime bien.
  const PAPEL = { negro: '000000', texto: '1A1A1A', gris: '595959', suave: '8C8C8C', linea: 'C8C8C8' };
  const TIENDA = String(window.CONFIG.NOMBRE_TIENDA || 'Sistema Mayor').toUpperCase();
  const ARRIBA = 104;   // donde empieza el contenido debajo del membrete

  // Hoja carta con membrete: tienda, título y periodo a la izquierda; quién y cuándo, a la derecha.
  async function nuevoPdf(titulo, subtitulo, generado) {
    await cargar('pdf');
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'letter' });
    const ancho = doc.internal.pageSize.getWidth();
    doc.__titulo = titulo;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...rgb(PAPEL.gris));
    doc.text(TIENDA, MARGEN, 38, { charSpace: 0.8 });
    doc.setFontSize(17);
    doc.setTextColor(...rgb(PAPEL.negro));
    doc.text(titulo, MARGEN, 60);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...rgb(PAPEL.texto));
    doc.text(limpio(subtitulo), MARGEN, 76);
    // A la derecha, un dato por renglón (vienen separados por " · ")
    doc.setFontSize(8);
    doc.setTextColor(...rgb(PAPEL.gris));
    limpio(generado).split(' · ').slice(0, 4).forEach((r, i) => doc.text(r, ancho - MARGEN, 38 + i * 11.5, { align: 'right' }));
    doc.setDrawColor(...rgb(PAPEL.negro));
    doc.setLineWidth(1);
    doc.line(MARGEN, 86, ancho - MARGEN, 86);
    return doc;
  }

  // Tablas sobrias: sin rellenos; una raya negra bajo los títulos y rayas finas grises entre filas.
  const estiloTabla = {
    theme: 'plain',
    rowPageBreak: 'avoid',   // una fila nunca queda partida entre dos páginas
    showFoot: 'lastPage',    // el total, solo al final (no al pie de cada página)
    margin: { left: MARGEN, right: MARGEN, top: 62, bottom: 50 },   // arriba: espacio para el membrete corto
    styles: {
      font: 'helvetica', fontSize: 8.5, cellPadding: { top: 4, right: 4, bottom: 4, left: 4 },
      textColor: rgb(PAPEL.texto), lineColor: rgb(PAPEL.linea), lineWidth: { bottom: 0.4 },
    },
    headStyles: { fontStyle: 'bold', fontSize: 8, textColor: rgb(PAPEL.negro), lineColor: rgb(PAPEL.negro), lineWidth: { bottom: 0.9 } },
    footStyles: { fontStyle: 'bold', textColor: rgb(PAPEL.negro), lineColor: rgb(PAPEL.negro), lineWidth: { top: 0.9 } },
  };

  // Escribe títulos, tablas, notas y firmas uno debajo del otro, pasando de página si hace falta.
  function escritor(doc, yInicial) {
    let y = yInicial;
    const alto = doc.internal.pageSize.getHeight();
    const ancho = doc.internal.pageSize.getWidth();
    const nuevaPagina = (falta) => { if (y > alto - falta) { doc.addPage(); y = 70; } };
    return {
      titulo(texto, nota) {
        nuevaPagina(110);
        doc.setTextColor(...rgb(PAPEL.negro));
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text(texto, MARGEN, y);
        if (nota) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...rgb(PAPEL.gris));
          doc.text(limpio(nota), MARGEN, y + 12);
          y += 12;
        }
        y += 7;
      },
      tabla(opciones) {
        doc.autoTable({ ...estiloTabla, ...opciones, startY: y });
        y = doc.lastAutoTable.finalY + 20;
      },
      nota(texto, cursiva = true) {
        nuevaPagina(70);
        doc.setFont('helvetica', cursiva ? 'italic' : 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...rgb(PAPEL.gris));
        const lineas = doc.splitTextToSize(limpio(texto), ancho - MARGEN * 2);
        doc.text(lineas, MARGEN, y + 4);
        y += 12 * lineas.length + 10;
      },
      // Renglones para firmar (nombre y firma), uno al lado del otro.
      firmas(etiquetas) {
        nuevaPagina(120);
        y += 34;
        const anchoFirma = (ancho - MARGEN * 2 - 40 * (etiquetas.length - 1)) / etiquetas.length;
        etiquetas.forEach((etiqueta, i) => {
          const x = MARGEN + i * (anchoFirma + 40);
          doc.setDrawColor(...rgb(PAPEL.negro));
          doc.setLineWidth(0.6);
          doc.line(x, y, x + anchoFirma, y);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...rgb(PAPEL.gris));
          doc.text(etiqueta, x, y + 11);
        });
        y += 30;
      },
      fin() {
        nuevaPagina(60);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...rgb(PAPEL.gris));
        doc.text('— Fin del reporte —', ancho / 2, y + 6, { align: 'center' });
        y += 20;
      },
      get y() { return y; },
      set y(v) { y = v; },
    };
  }

  // Pie en todas las páginas ("Página 1 de 3") y, desde la segunda, un membrete corto arriba.
  function piePaginas(doc, texto) {
    const paginas = doc.internal.getNumberOfPages();
    const ancho = doc.internal.pageSize.getWidth();
    const alto = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= paginas; i++) {
      doc.setPage(i);
      doc.setDrawColor(...rgb(PAPEL.linea));
      doc.setLineWidth(0.5);
      doc.line(MARGEN, alto - 32, ancho - MARGEN, alto - 32);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...rgb(PAPEL.gris));
      doc.text(limpio(texto), MARGEN, alto - 18);
      doc.text(`Página ${i} de ${paginas}`, ancho - MARGEN, alto - 18, { align: 'right' });
      if (i > 1) {
        doc.setFont('helvetica', 'bold');
        doc.text(`${TIENDA} · ${doc.__titulo || ''}`, MARGEN, 36);
        doc.setFont('helvetica', 'normal');
        doc.text(`Página ${i} de ${paginas}`, ancho - MARGEN, 36, { align: 'right' });
        doc.setDrawColor(...rgb(PAPEL.negro));
        doc.setLineWidth(0.6);
        doc.line(MARGEN, 44, ancho - MARGEN, 44);
      }
    }
  }

  const MAX_FILAS_RESUMEN = 10;

  // ---------------- Reporte: un resumen (el detalle completo va en el Excel) ----------------
  async function pdf(c) {
    const doc = await nuevoPdf(tituloReporte(c), mayuscula(c.periodoTexto),
      `Generado el ${fechaHora.format(c.generadoEn)} por ${c.generadoPor} · ${textoCierre(c)}`);
    const ancho = doc.internal.pageSize.getWidth();

    // Indicadores
    const agotados = c.porAgotarse.filter((p) => p.cantidad <= 0).length;
    const tarjetas = [
      ['Total vendido', cop.format(c.totalCOP), c.totalUSD != null ? `aprox. ${usd.format(c.totalUSD)}` : ''],
      ['Ventas', num.format(c.numVentas), c.numAnuladas ? plural(c.numAnuladas, 'línea anulada', 'líneas anuladas') : 'Ninguna anulada'],
      ['Unidades vendidas', num.format(c.unidades), `De ${plural(c.porProducto.length, 'producto', 'productos')}`],
      ['Por agotarse', num.format(c.porAgotarse.length), agotados ? plural(agotados, 'agotado', 'agotados') : 'Ninguno agotado'],
    ];
    const espacio = 10;
    const anchoTarjeta = (ancho - MARGEN * 2 - espacio * 3) / 4;
    tarjetas.forEach(([etiqueta, valor, nota], i) => {
      const x = MARGEN + i * (anchoTarjeta + espacio);
      const principal = i === 0;
      doc.setDrawColor(...rgb(principal ? PAPEL.negro : PAPEL.linea));
      doc.setLineWidth(principal ? 1.2 : 0.8);
      doc.roundedRect(x, ARRIBA, anchoTarjeta, 62, 6, 6, 'S');
      doc.setTextColor(...rgb(PAPEL.gris));
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(etiqueta, x + 10, ARRIBA + 16);
      doc.setTextColor(...rgb(PAPEL.negro));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.text(limpio(valor), x + 10, ARRIBA + 38);
      doc.setTextColor(...rgb(PAPEL.gris));
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(limpio(nota), x + 10, ARRIBA + 53);
    });

    const w = escritor(doc, ARRIBA + 84);

    // Lo demás del periodo, en una sola fila
    w.tabla({
      head: [['Entradas de mercancía', 'Salidas de mercancía', 'Anulaciones', 'Cambios de precio']],
      body: [[
        plural(unidadesDe(c, ['entrada']), 'unidad', 'unidades'),
        plural(unidadesDe(c, ['salida']), 'unidad', 'unidades'),
        plural(c.numAnuladas, 'línea', 'líneas'),
        plural(c.cambiosPrecio.length, 'cambio', 'cambios'),
      ]],
      headStyles: { ...estiloTabla.headStyles, textColor: rgb(PAPEL.gris), fontStyle: 'normal', fontSize: 8 },
      styles: { ...estiloTabla.styles, fontSize: 9.5, fontStyle: 'bold', halign: 'center' },
    });

    w.titulo('Ventas por vendedor');
    if (c.porVendedor.length) {
      w.tabla({
        head: [['Vendedor', 'Ventas', 'Unidades', 'Total', '% del total']],
        body: c.porVendedor.map((v) => [v.vendedor, num.format(v.ventas), num.format(v.unidades), limpio(cop.format(v.total)),
          `${porcentaje.format(c.totalCOP ? (v.total / c.totalCOP) * 100 : 0)} %`]),
        foot: [['TOTAL', num.format(c.numVentas), num.format(c.unidades), limpio(cop.format(c.totalCOP)), '100,0 %']],
        columnStyles: { 1: { cellWidth: 55 }, 2: { cellWidth: 60 }, 3: { cellWidth: 85 }, 4: { cellWidth: 60 } },
        didParseCell: (d) => { if (d.column.index > 0) d.cell.styles.halign = 'right'; },
      });
    } else {
      w.nota('No hubo ventas en este periodo.');
    }

    if (!c.unDia && c.porDia.length) {
      w.titulo('Ventas por día');
      w.tabla({
        head: [['Día', 'Ventas', 'Unidades', 'Total']],
        body: c.porDia.map((d) => [mayuscula(diaLargo.format(new Date(`${d.fecha}T00:00:00Z`))), num.format(d.ventas), num.format(d.unidades), limpio(cop.format(d.total))]),
        foot: [['TOTAL', num.format(c.numVentas), num.format(c.unidades), limpio(cop.format(c.totalCOP))]],
        columnStyles: { 1: { cellWidth: 55 }, 2: { cellWidth: 60 }, 3: { cellWidth: 85 } },
        didParseCell: (d) => { if (d.column.index > 0) d.cell.styles.halign = 'right'; },
      });
    }

    if (c.porProducto.length) {
      const top = c.porProducto.slice(0, MAX_FILAS_RESUMEN);
      const resto = c.porProducto.length - top.length;
      w.titulo(c.porProducto.length > MAX_FILAS_RESUMEN ? `Los ${MAX_FILAS_RESUMEN} productos más vendidos` : 'Productos más vendidos',
        resto ? `y ${plural(resto, 'producto más', 'productos más')} (ver el Excel)` : null);
      w.tabla({
        head: [['Código', 'Producto', 'Unidades', 'Total', '% del total']],
        body: top.map((p) => [p.codigo || '-', p.nombre, num.format(p.unidades), limpio(cop.format(p.total)),
          `${porcentaje.format(c.totalCOP ? (p.total / c.totalCOP) * 100 : 0)} %`]),
        columnStyles: { 0: { cellWidth: 58 }, 2: { cellWidth: 55 }, 3: { cellWidth: 80 }, 4: { cellWidth: 58 } },
        didParseCell: (d) => { if ([2, 3, 4].includes(d.column.index)) d.cell.styles.halign = 'right'; },
      });
    }

    if (c.porAgotarse.length) {
      const top = c.porAgotarse.slice(0, MAX_FILAS_RESUMEN);
      const resto = c.porAgotarse.length - top.length;
      w.titulo('Productos por agotarse',
        `Inventario actual con ${c.stockBajo} unidades o menos${resto ? ` · y ${plural(resto, 'producto más', 'productos más')} (ver el Excel)` : ''}`);
      w.tabla({
        head: [['Código', 'Producto', 'Quedan', 'Estado']],
        body: top.map((p) => [p.codigo || '-', p.nombre, num.format(p.cantidad), p.cantidad <= 0 ? 'Agotado' : 'Pocas unidades']),
        columnStyles: { 0: { cellWidth: 58 }, 2: { cellWidth: 50 }, 3: { cellWidth: 90 } },
        didParseCell: (d) => {
          if (d.column.index === 2) d.cell.styles.halign = 'right';
          if (d.section === 'body' && d.column.index === 3 && top[d.row.index].cantidad <= 0) d.cell.styles.fontStyle = 'bold';
        },
      });
    }

    w.nota('Este PDF es un resumen. El detalle de cada ticket está en "Auditoría de caja", las entradas y salidas en "Ajustes de inventario", y todo junto en el Excel de este mismo reporte.');

    const pie = c.unDia ? c.desde.split('-').reverse().join('/') : `${c.desde.split('-').reverse().join('/')} a ${c.hasta.split('-').reverse().join('/')}`;
    piePaginas(doc, `Sistema Mayor · ${tituloReporte(c)} ${pie}`);
    doc.save(nombreArchivo(c, 'pdf'));
  }

  // ---------------- Una venta (carrito) ----------------
  async function pdfVenta(v) {
    const doc = await nuevoPdf(`Venta #${v.numero_dia ?? v.numero}`, mayuscula(fechaHora.format(new Date(v.vendido_en))),
      `Consecutivo ${v.numero} · vendedor: ${v.vendedor} · generado el ${fechaHora.format(v.generadoEn)} por ${v.generadoPor}`);
    const w = escritor(doc, 120);
    if (v.estado !== 'Completa') {
      w.nota(v.estado === 'Anulada'
        ? 'Esta venta fue anulada: las unidades volvieron al inventario.'
        : 'Algunos productos de esta venta fueron anulados (en gris): no suman en el total.', false);
    }
    const hayAnuladas = v.lineas.some((l) => l.anulada_en);
    w.tabla({
      head: [['Código', 'Producto', 'Cant.', 'Precio unit.', 'Subtotal', ...(hayAnuladas ? ['Estado'] : [])]],
      body: v.lineas.map((l) => [l.codigo || '-', l.nombre, num.format(l.cantidad), limpio(cop.format(l.precio_unitario)),
        limpio(cop.format(l.total)), ...(hayAnuladas ? [l.anulada_en ? 'Anulada' : 'Vendida'] : [])]),
      foot: [['', 'TOTAL', num.format(v.unidades), '', limpio(cop.format(v.total)), ...(hayAnuladas ? [''] : [])]],
      styles: { ...estiloTabla.styles, fontSize: 9.5, cellPadding: 6 },
      columnStyles: { 0: { cellWidth: 62 }, 2: { cellWidth: 40 }, 3: { cellWidth: 80 }, 4: { cellWidth: 85 } },
      didParseCell: (d) => {
        if ([2, 3, 4].includes(d.column.index)) d.cell.styles.halign = 'right';
        if (d.section === 'body' && v.lineas[d.row.index].anulada_en) {
          d.cell.styles.textColor = rgb(PAPEL.suave);
          d.cell.styles.fontStyle = 'italic';
        }
      },
    });
    const detalles = [];
    if (v.totalUSD != null) detalles.push(`Equivale a aprox. ${usd.format(v.totalUSD)} (tasa de ese momento: 1 USD = ${cop.format(v.tasa)}).`);
    if (v.anulado) detalles.push(`Anulado: ${cop.format(v.anulado)} (no suma en el total).`);
    if (detalles.length) w.nota(detalles.join(' '), false);

    piePaginas(doc, `Sistema Mayor · Venta #${v.numero_dia ?? v.numero} (consecutivo ${v.numero})`);
    doc.save(`Venta-consecutivo-${v.numero}.pdf`);
  }

  // ================================================================
  // Importación: plantilla y lectura del archivo
  // ================================================================

  const COLUMNAS_IMPORTAR = [
    { clave: 'codigo', titulo: 'Código', ancho: 14 },
    { clave: 'nombre', titulo: 'Nombre', ancho: 46 },
    { clave: 'descripcion', titulo: 'Descripción', ancho: 36 },
    { clave: 'categoria', titulo: 'Categoría', ancho: 16 },
    { clave: 'cantidad', titulo: 'Cantidad', ancho: 11, formato: FMT_NUM },
    { clave: 'precio', titulo: 'Precio (pesos COP)', ancho: 19, formato: FMT_COP },
  ];

  // Plantilla con el inventario actual: se corrige o se completa y se vuelve a subir.
  async function plantilla(inventario, fecha, opciones = {}) {
    await cargar('excel');
    const libro = new window.ExcelJS.Workbook();
    libro.creator = 'Sistema Mayor';

    const hoja = libro.addWorksheet('Productos', { views: [{ state: 'frozen', ySplit: 1 }] });
    hoja.columns = COLUMNAS_IMPORTAR.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho, style: c.formato ? { numFmt: c.formato } : {} }));
    hoja.getColumn('codigo').numFmt = '@';   // como texto: códigos tipo 00123 no pierden los ceros
    hoja.getRow(1).height = 22;
    hoja.getRow(1).eachCell((celda) => {
      celda.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      celda.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${COLOR.primario}` } };
      celda.alignment = { vertical: 'middle' };
    });
    for (const p of inventario) {
      hoja.addRow({ codigo: p.codigo || '', nombre: p.nombre, descripcion: p.descripcion || '', categoria: p.categoria || '', cantidad: p.cantidad, precio: Number(p.precio_cop) });
    }

    const ayuda = libro.addWorksheet('Instrucciones');
    ayuda.getColumn(1).width = 110;
    [
      'Cómo usar esta plantilla',
      '',
      `• Trae el inventario del ${fecha.split('-').reverse().join('/')}. Cada fila de la hoja "Productos" es un producto.`,
      '• El código es obligatorio y no se puede repetir. Si el código ya existe, se actualiza ese producto; si no existe, se crea.',
      '• Para un producto nuevo, el nombre y el precio son obligatorios.',
      `• Categoría: escribe el nombre o la letra (${(opciones.categorias || []).map((x) => `${x.prefijo} ${x.nombre}`).join(', ')}).`,
      '  Si la dejas vacía, se toma de la letra con la que empieza el código (L-2054 → Lavadora).',
      '• Una celda vacía deja ese dato como está.',
      '• Precio en pesos colombianos, sin decimales (ej: 150000).',
      '• Cantidad: número entero. Al importar eliges si es la existencia total (reemplaza) o unidades que llegan (se suman).',
      '• Si vas a SUMAR mercancía que llegó, deja solo las filas que llegaron (o borra las demás cantidades);',
      '  si no, se sumaría la existencia actual otra vez.',
      '• No cambies los títulos de la primera fila de la hoja "Productos".',
    ].forEach((t, i) => {
      const celda = ayuda.getCell(i + 1, 1);
      celda.value = t;
      if (i === 0) celda.font = { bold: true, size: 14, color: { argb: `FF${COLOR.primario}` } };
    });

    const datos = await libro.xlsx.writeBuffer();
    descargar(new Blob([datos], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Plantilla-productos-${fecha}.xlsx`);
  }

  const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  // Reconoce los títulos aunque estén escritos distinto ("Cód.", "Existencia", "Precio COP"…).
  function columnaDe(titulo) {
    const t = normalizar(titulo);
    if (!t) return null;
    if (/^(codigo|cod\b|cod\.|ref)/.test(t)) return 'codigo';
    if (/^(nombre|producto)/.test(t)) return 'nombre';
    if (/^(categoria|linea)/.test(t)) return 'categoria';
    if (/^(descripcion|detalle)/.test(t)) return 'descripcion';
    if (/^(cantidad|existencia|stock|unidades)/.test(t)) return 'cantidad';
    if (/^(precio|valor)/.test(t) && !/(usd|dolar)/.test(t)) return 'precio';
    return null;
  }

  function valorCelda(v) {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') {
      if (Array.isArray(v.richText)) return v.richText.map((x) => x.text).join('');
      if ('result' in v) return valorCelda(v.result);
      if ('text' in v) return v.text;
      return null;
    }
    return v;
  }

  // Números tal como vienen de Excel o escritos a mano: 150000, "1.500.000", "$ 150.000", "3950,5".
  function numeroDe(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    let s = String(v).replace(/\s|\$|cop|usd/gi, '');
    if (s === '') return null;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
  }

  const textoDe = (v) => {
    const t = v == null ? '' : String(v).trim();
    return t === '' ? null : t;
  };

  // Lee el archivo y devuelve [{fila, codigo, nombre, descripcion, cantidad, precio, error?}].
  async function leerProductos(archivo) {
    if (!/\.xlsx$/i.test(archivo.name)) {
      throw new Error('El archivo debe ser de Excel (.xlsx). Si está en otro formato, ábrelo en Excel y guárdalo como .xlsx.');
    }
    await cargar('excel');
    const libro = new window.ExcelJS.Workbook();
    try {
      await libro.xlsx.load(await archivo.arrayBuffer());
    } catch {
      throw new Error('No se pudo leer el archivo. Verifica que sea un Excel (.xlsx) válido.');
    }

    for (const hoja of libro.worksheets) {
      if (hoja.state && hoja.state !== 'visible') continue;
      // Los títulos pueden estar en cualquiera de las primeras 10 filas.
      for (let n = 1; n <= Math.min(10, hoja.rowCount); n++) {
        const mapa = {};
        hoja.getRow(n).eachCell((celda, col) => {
          const clave = columnaDe(valorCelda(celda.value));
          if (clave && !(clave in mapa)) mapa[clave] = col;
        });
        if (!mapa.codigo || !(mapa.nombre || mapa.precio || mapa.cantidad)) continue;

        const filas = [];
        for (let i = n + 1; i <= hoja.rowCount; i++) {
          const fila = hoja.getRow(i);
          const v = (clave) => (mapa[clave] ? valorCelda(fila.getCell(mapa[clave]).value) : null);
          const datos = {
            fila: i,
            codigo: textoDe(v('codigo'))?.toUpperCase() ?? null,
            nombre: textoDe(v('nombre')),
            descripcion: textoDe(v('descripcion')),
            categoria: textoDe(v('categoria')),
          };
          const precio = numeroDe(v('precio'));
          const cantidad = numeroDe(v('cantidad'));
          if (!datos.codigo && !datos.nombre && !datos.descripcion && !datos.categoria && precio == null && cantidad == null) continue;   // fila vacía

          if (Number.isNaN(precio) || precio < 0) datos.error = 'Precio inválido.';
          else if (Number.isNaN(cantidad) || (cantidad != null && (!Number.isInteger(cantidad) || cantidad < 0))) {
            datos.error = 'La cantidad debe ser un número entero, 0 o mayor.';
          }
          datos.precio = Number.isNaN(precio) ? null : precio;
          datos.cantidad = Number.isInteger(cantidad) ? cantidad : null;
          filas.push(datos);
        }
        if (!filas.length) throw new Error('El archivo no tiene productos debajo de los títulos.');
        if (filas.length > 5000) throw new Error('El archivo tiene más de 5.000 productos. Divídelo en varios archivos.');
        return filas;
      }
    }
    throw new Error('No encontré las columnas. La primera fila debe tener los títulos: Código, Nombre, Descripción, Cantidad, Precio.');
  }

  // ---------------- Reportes impresos de caja e inventario ----------------
  const fechaCorta = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric' });
  const soloHora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
  const diaTexto = (iso) => iso.split('-').reverse().join('/');   // AAAA-MM-DD → DD/MM/AAAA
  const periodoCorto = (c) => (c.unDia ? diaTexto(c.desde) : `${diaTexto(c.desde)} al ${diaTexto(c.hasta)}`);
  const sufijoArchivo = (c) => (c.unDia ? c.desde : `${c.desde}_a_${c.hasta}`);
  const impreso = (c) => `Impreso el ${fechaHora.format(c.generadoEn)} · Usuario: ${c.generadoPor}`;

  // Datos generales en dos columnas (etiqueta y valor), sin rayas.
  function datosGenerales(w, pares) {
    const filas = [];
    for (let i = 0; i < pares.length; i += 2) {
      filas.push([pares[i][0], pares[i][1], pares[i + 1]?.[0] ?? '', pares[i + 1]?.[1] ?? ''].map((x) => limpio(x)));
    }
    w.tabla({
      body: filas,
      styles: { ...estiloTabla.styles, fontSize: 8.5, cellPadding: { top: 1.5, bottom: 1.5, left: 0, right: 10 }, lineWidth: 0 },
      columnStyles: { 0: { textColor: rgb(PAPEL.gris), cellWidth: 88 }, 2: { textColor: rgb(PAPEL.gris), cellWidth: 88 } },
    });
  }

  // Tasa con la que se hicieron las ventas del periodo; si no hubo ventas, la de hoy.
  function textoTasa(c) {
    const tasas = [...new Set(c.ventas.map((v) => Number(v.tasa_usd)).filter((t) => t > 0))].sort((x, y) => x - y);
    if (tasas.length === 1) return `1 USD = ${cop.format(tasas[0])}`;
    if (tasas.length > 1) return `de ${cop.format(tasas[0])} a ${cop.format(tasas[tasas.length - 1])} por USD`;
    return c.tasaActual ? `1 USD = ${cop.format(c.tasaActual)} (hoy)` : 'Sin definir';
  }

  // Líneas de venta agrupadas por ticket (consecutivo), del primero al último.
  function agruparTickets(ventas) {
    const grupos = new Map();
    for (const v of [...ventas].sort((a, b) => (a.ticket ?? 0) - (b.ticket ?? 0) || a.id - b.id)) {
      const clave = v.ticket ?? `L${v.id}`;
      if (!grupos.has(clave)) grupos.set(clave, { ticket: v.ticket, numero_dia: v.numero_dia, vendido_en: v.vendido_en, vendedor: v.vendedor, lineas: [] });
      grupos.get(clave).lineas.push(v);
    }
    return [...grupos.values()];
  }

  // Auditoría de caja · Detalle: cada ticket con sus productos, el total general y firmas.
  async function auditoriaCaja(c) {
    const doc = await nuevoPdf('Auditoría de caja · Detalle', mayuscula(c.periodoTexto), `${impreso(c)} · ${textoCierre(c)}`);
    const w = escritor(doc, ARRIBA);
    const tickets = agruparTickets(c.ventas);
    const consecutivos = tickets.map((t) => t.ticket).filter((n) => n != null);
    const rango = consecutivos.length ? `${Math.min(...consecutivos)} a ${Math.max(...consecutivos)}` : '-';
    const anuladas = c.ventas.filter((l) => l.anulada_en);
    const totalAnulado = anuladas.reduce((s, l) => s + Number(l.total), 0);
    datosGenerales(w, [
      ['Fecha de corte', periodoCorto(c)],
      ['Tasa de cambio', textoTasa(c)],
      ['Tickets', `${num.format(tickets.length)} · consecutivos ${rango}`],
      ['Estado del día', textoCierre(c)],
    ]);

    if (!tickets.length) {
      w.nota('No hubo ventas en este periodo.');
    } else {
      const estiloTicket = {
        fontStyle: 'bold', textColor: rgb(PAPEL.negro), lineColor: rgb(PAPEL.negro),
        lineWidth: { top: 0.7, bottom: 0.4 }, cellPadding: { top: 6, bottom: 4, left: 4, right: 4 },
      };
      const cuerpo = [];
      const grises = new Set();   // filas anuladas (en gris y cursiva; no suman)
      for (const t of tickets) {
        const vigentes = t.lineas.filter((l) => !l.anulada_en);
        const total = vigentes.reduce((s, l) => s + Number(l.total), 0);
        const unidades = vigentes.reduce((s, l) => s + l.cantidad, 0);
        const tasa = Number(t.lineas.find((l) => l.tasa_usd)?.tasa_usd) || null;
        const estado = !vigentes.length ? 'ANULADO' : vigentes.length < t.lineas.length ? 'ANULACIÓN PARCIAL' : '';
        const cuando = c.unDia ? soloHora.format(new Date(t.vendido_en)) : fechaHora.format(new Date(t.vendido_en));
        cuerpo.push([
          { content: limpio(`Ticket #${t.numero_dia ?? t.ticket}   ·   Consecutivo ${t.ticket ?? '-'}   ·   ${cuando}   ·   Vendedor: ${t.vendedor || '-'}${estado ? `   ·   ${estado}` : ''}`), colSpan: 5, styles: estiloTicket },
          { content: limpio(cop.format(total)), styles: { ...estiloTicket, halign: 'right' } },
        ]);
        for (const l of t.lineas) {
          if (l.anulada_en) grises.add(cuerpo.length);
          cuerpo.push([l.codigo || '-', num.format(l.cantidad), 'C/U', limpio(cop.format(l.precio_unitario)),
            l.anulada_en ? `${l.nombre}  (anulada)` : l.nombre, limpio(cop.format(l.total))]);
        }
        cuerpo.push([{
          content: limpio(`${plural(t.lineas.length, 'producto', 'productos')} · ${plural(unidades, 'unidad', 'unidades')}`
            + `${tasa && total ? ` · tasa 1 USD = ${cop.format(tasa)} · aprox. ${usd.format(total / tasa)}` : ''}`),
          colSpan: 6,
          styles: { fontSize: 7.5, textColor: rgb(PAPEL.gris), halign: 'right', lineWidth: 0, cellPadding: { top: 2, bottom: 9, left: 4, right: 4 } },
        }]);
      }
      w.tabla({
        head: [['Código', 'Cant.', 'Unid.', 'Precio', 'Descripción', 'Subtotal']],
        body: cuerpo,
        columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 36 }, 2: { cellWidth: 32 }, 3: { cellWidth: 72 }, 5: { cellWidth: 76 } },
        didParseCell: (d) => {
          if ([1, 3, 5].includes(d.column.index) && d.cell.colSpan === 1) d.cell.styles.halign = 'right';
          if (d.section === 'body' && grises.has(d.row.index)) {
            d.cell.styles.textColor = rgb(PAPEL.suave);
            d.cell.styles.fontStyle = 'italic';
          }
        },
      });
    }

    w.titulo('Total general');
    w.tabla({
      body: [
        ['Total vendido', `${limpio(cop.format(c.totalCOP))}${c.totalUSD != null ? limpio(`  (aprox. ${usd.format(c.totalUSD)})`) : ''}`],
        ['Tickets', `${num.format(tickets.length)}  (consecutivos ${rango})`],
        ['Unidades vendidas', num.format(c.unidades)],
        ['Líneas anuladas', anuladas.length ? `${num.format(anuladas.length)} por ${limpio(cop.format(totalAnulado))} (no suman en el total)` : 'Ninguna'],
      ],
      columnStyles: { 0: { cellWidth: 150, textColor: rgb(PAPEL.gris) }, 1: { fontStyle: 'bold' } },
      didParseCell: (d) => { if (d.row.index === 0 && d.column.index === 1) d.cell.styles.fontSize = 11; },
    });

    if (c.porVendedor.length) {
      w.titulo('Ventas por vendedor');
      w.tabla({
        head: [['Vendedor', 'Tickets', 'Unidades', 'Total']],
        body: c.porVendedor.map((v) => [v.vendedor, num.format(v.ventas), num.format(v.unidades), limpio(cop.format(v.total))]),
        columnStyles: { 1: { cellWidth: 60 }, 2: { cellWidth: 70 }, 3: { cellWidth: 100 } },
        didParseCell: (d) => { if (d.column.index > 0) d.cell.styles.halign = 'right'; },
      });
    }

    w.firmas(['Elaborado por (nombre y firma)', 'Revisado por (nombre y firma)']);
    w.fin();
    piePaginas(doc, `Sistema Mayor · Auditoría de caja ${periodoCorto(c)}`);
    doc.save(`Auditoria-de-caja-${sufijoArchivo(c)}.pdf`);
  }

  // Actividad de inventario · Ajustes: entradas y salidas de mercancía, con firma de quien autoriza.
  async function ajustesInventario(c) {
    const doc = await nuevoPdf('Actividad de inventario · Ajustes', mayuscula(c.periodoTexto), impreso(c));
    const w = escritor(doc, ARRIBA);
    const porFecha = (a, b) => a.creado_en.localeCompare(b.creado_en) || a.id - b.id;
    const ajustes = c.movimientos.filter((m) => m.tipo === 'entrada' || m.tipo === 'salida').sort(porFecha);
    const devoluciones = c.movimientos.filter((m) => m.tipo === 'anulacion').sort(porFecha);
    const entradas = ajustes.filter((m) => m.tipo === 'entrada');
    const salidas = ajustes.filter((m) => m.tipo === 'salida');
    const suma = (ms) => ms.reduce((s, m) => s + m.cantidad, 0);
    datosGenerales(w, [
      ['Fecha de corte', periodoCorto(c)],
      ['Ajustes', `${num.format(ajustes.length)}  (${plural(entradas.length, 'entrada', 'entradas')}, ${plural(salidas.length, 'salida', 'salidas')})`],
      ['Unidades', `+${num.format(suma(entradas))} entraron · -${num.format(suma(salidas))} salieron`],
      ['Devoluciones', devoluciones.length ? `${num.format(devoluciones.length)} por ventas anuladas` : 'Ninguna'],
    ]);

    const fila = (m, notas) => [
      m.codigo || '-', m.nombre, `${fechaCorta.format(new Date(m.creado_en))}\n${soloHora.format(new Date(m.creado_en))}`,
      `#${m.id}`, notas, m.usuario || '-',
      `${m.tipo === 'salida' ? '-' : '+'}${num.format(m.cantidad)}`,
      m.stock_antes == null ? '-' : num.format(m.stock_antes),
      m.stock_despues == null ? '-' : num.format(m.stock_despues),
    ];
    const tablaMovimientos = (filas) => w.tabla({
      head: [['Código', 'Descripción', 'Fecha', 'Documento', 'Notas', 'Usuario', 'Cant. ajustada', 'Exist. anterior', 'Exist. actual']],
      body: filas,
      styles: { ...estiloTabla.styles, fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 50 }, 2: { cellWidth: 54 }, 3: { cellWidth: 56 }, 4: { cellWidth: 92 }, 5: { cellWidth: 42 },
        6: { cellWidth: 44, fontStyle: 'bold' }, 7: { cellWidth: 44 }, 8: { cellWidth: 40 },
      },
      didParseCell: (d) => { if (d.column.index >= 6) d.cell.styles.halign = 'right'; },
    });

    if (ajustes.length) {
      tablaMovimientos(ajustes.map((m) => fila(m, `${m.tipo === 'entrada' ? 'Ajuste arriba' : 'Ajuste abajo'} · ${m.motivo || '-'}`)));
    } else {
      w.nota('No hubo entradas ni salidas de mercancía en este periodo.');
    }

    w.tabla({
      body: [
        [`${plural(entradas.length, 'ajuste ascendente', 'ajustes ascendentes')} (entradas)`, `+${num.format(suma(entradas))} ${suma(entradas) === 1 ? 'unidad' : 'unidades'}`],
        [`${plural(salidas.length, 'ajuste descendente', 'ajustes descendentes')} (salidas)`, `-${num.format(suma(salidas))} ${suma(salidas) === 1 ? 'unidad' : 'unidades'}`],
      ],
      columnStyles: { 0: { cellWidth: 260 }, 1: { fontStyle: 'bold', halign: 'right', cellWidth: 120 } },
    });

    if (devoluciones.length) {
      w.titulo('Devoluciones por ventas anuladas', 'Las unidades de las ventas anuladas volvieron al inventario.');
      tablaMovimientos(devoluciones.map((m) => fila(m, m.motivo || 'Venta anulada')));
    }

    w.firmas(['Autorizado por (nombre y firma)', 'Revisado por (nombre y firma)']);
    w.fin();
    piePaginas(doc, `Sistema Mayor · Ajustes de inventario ${periodoCorto(c)}`);
    doc.save(`Ajustes-de-inventario-${sufijoArchivo(c)}.pdf`);
  }

  // ---------------- Lista de precios (código, descripción y precio) ----------------
  async function listaPrecios(productos, { tasa, generadoPor, mostrarTasa = false } = {}) {
    const hoy = new Date();
    const doc = await nuevoPdf('Lista de precios', mayuscula(new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, dateStyle: 'full' }).format(hoy)),
      `Generada el ${fechaHora.format(hoy)} por ${generadoPor || '-'} · ${plural(productos.length, 'producto', 'productos')}`);
    const w = escritor(doc, ARRIBA);
    const cuerpo = [];
    let categoriaActual;
    // Por categoría y, dentro de cada una, por código (así se buscan los productos).
    const porCodigo = (a, b) => (a.codigo || '~').localeCompare(b.codigo || '~', 'es', { numeric: true }) || a.nombre.localeCompare(b.nombre);
    for (const p of [...productos].sort((a, b) => (a.categoria || 'zzz').localeCompare(b.categoria || 'zzz') || porCodigo(a, b))) {
      if (p.categoria !== categoriaActual) {
        categoriaActual = p.categoria;
        cuerpo.push([{ content: (categoriaActual || 'Sin categoría').toUpperCase(), colSpan: tasa ? 4 : 3,
          styles: { fontStyle: 'bold', textColor: rgb(PAPEL.negro), lineColor: rgb(PAPEL.negro), lineWidth: { bottom: 0.8 }, cellPadding: { top: 12, bottom: 3, left: 4, right: 4 } } }]);
      }
      const descripcion = p.descripcion ? `${p.nombre} - ${p.descripcion}` : p.nombre;
      cuerpo.push([p.codigo || '-', descripcion, limpio(cop.format(p.precio_cop)),
        ...(tasa ? [limpio(usd.format(Number(p.precio_cop) / tasa))] : [])]);
    }
    w.tabla({
      head: [['Código', 'Descripción', 'Precio (pesos)', ...(tasa ? ['Precio (dólares)'] : [])]],
      body: cuerpo,
      alternateRowStyles: {},
      styles: { ...estiloTabla.styles, fontSize: 9 },
      columnStyles: { 0: { cellWidth: 62 }, 2: { cellWidth: 88 }, 3: { cellWidth: 88 } },
      didParseCell: (d) => { if (d.column.index >= 2 && d.cell.colSpan === 1) d.cell.styles.halign = 'right'; },
    });
    // Atención al público no ve la tasa del dólar: la nota solo sale para administración y el jefe.
    if (tasa && mostrarTasa) w.nota(`Precios en dólares con la tasa de hoy: 1 USD = ${cop.format(tasa)}.`, false);
    piePaginas(doc, `Sistema Mayor · Lista de precios ${new Intl.DateTimeFormat('es-CO', { timeZone: ZONA }).format(hoy)}`);
    doc.save(`Lista-de-precios-${new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(hoy)}.pdf`);
  }

  return { excel, pdf, auditoriaCaja, ajustesInventario, pdfVenta, listaPrecios, plantilla, leerProductos };
})();
