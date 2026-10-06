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
  const hora = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: 'numeric', minute: '2-digit' });
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
  const diaCorto = new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, day: 'numeric', month: 'short' });
  const diaLargo = new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', dateStyle: 'full' });
  // Un solo día: solo la hora. Varios días: fecha corta y hora.
  const cuando = (c, iso) => limpio(c.unDia ? hora.format(new Date(iso)) : `${diaCorto.format(new Date(iso))} ${hora.format(new Date(iso))}`);
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
      { titulo: 'N.º venta', ancho: 10 },
      c.unDia ? { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' } : { titulo: 'Fecha y hora', ancho: 19, formato: 'd/mm/yyyy h:mm AM/PM' },
      { titulo: 'Código', ancho: 12 },
      { titulo: 'Producto', ancho: 42 },
      { titulo: 'Cantidad', ancho: 10, formato: FMT_NUM },
      { titulo: 'Precio unitario', ancho: 16, formato: FMT_COP },
      { titulo: 'Total (pesos)', ancho: 16, formato: FMT_COP },
      { titulo: 'Total (dólares)', ancho: 15, formato: FMT_USD },
      { titulo: 'Vendedor', ancho: 13 },
      { titulo: 'Estado', ancho: 11 },
    ];
    encabezado(hojaVentas, 'Detalle de ventas', colVentas.length);
    const ordenadas = [...c.ventas].sort((a, b) => a.vendido_en.localeCompare(b.vendido_en) || a.id - b.id);
    const ultimaVenta = tabla(hojaVentas, 4, colVentas, ordenadas.map((v) => [
      v.ticket ? `#${v.ticket}` : '', horaLocalParaExcel(v.vendido_en), v.codigo || '', v.nombre, v.cantidad, Number(v.precio_unitario),
      Number(v.total), v.tasa_usd ? Number(v.total) / Number(v.tasa_usd) : null, v.vendedor, v.anulada_en ? 'Anulada' : 'Vendida',
    ]));
    ordenadas.forEach((v, i) => {
      if (!v.anulada_en) return;
      hojaVentas.getRow(5 + i).eachCell((celda) => {
        celda.font = { italic: true, strike: true, color: { argb: `FF${COLOR.gris}` } };
      });
      hojaVentas.getRow(5 + i).getCell(10).font = { bold: true, color: { argb: `FF${COLOR.rojo}` } };
    });
    if (ordenadas.length) {
      // Los totales suman solo las líneas con estado "Vendida" (no las anuladas).
      const sumaSi = (col) => `SUMIFS(${col}5:${col}${ultimaVenta},J5:J${ultimaVenta},"Vendida")`;
      filaTotal(hojaVentas, ultimaVenta + 1, [
        'TOTAL', null, null, `${c.numVentas} ventas`,
        { formula: sumaSi('E'), result: c.unidades }, null,
        { formula: sumaSi('G'), result: c.totalCOP },
        { formula: sumaSi('H'), result: c.totalUSD ?? 0 }, null, null,
      ], colVentas);
    } else {
      hojaVentas.getCell(5, 1).value = 'No hubo ventas en este periodo.';
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
      { titulo: 'Descripción', ancho: 36 },
      { titulo: 'Cantidad', ancho: 10, formato: FMT_NUM },
      { titulo: 'Precio (pesos)', ancho: 16, formato: FMT_COP },
      { titulo: 'Precio (dólares)', ancho: 16, formato: FMT_USD },
    ];
    encabezado(hojaInv, 'Inventario', colInv.length);
    tabla(hojaInv, 4, colInv, inventario.map((p) => [
      p.codigo || '', p.nombre, p.descripcion || '', p.cantidad, Number(p.precio_cop),
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

  async function pdf(c) {
    await cargar('pdf');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const ancho = doc.internal.pageSize.getWidth();
    const margen = 40;

    // ---- Encabezado ----
    doc.setFillColor(...rgb(COLOR.primario));
    doc.rect(0, 0, ancho, 78, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('SISTEMA MAYOR', margen, 30);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.text(tituloReporte(c), margen, 56);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setFontSize(c.unDia ? 11 : 10);
    doc.text(limpio(mayuscula(c.periodoTexto)), ancho - margen, 56, { align: 'right' });

    doc.setTextColor(...rgb(COLOR.gris));
    doc.setFontSize(9);
    doc.text(limpio(`Generado el ${fechaHora.format(c.generadoEn)} por ${c.generadoPor}`), margen, 98);

    // ---- Indicadores ----
    const agotados = c.porAgotarse.filter((p) => p.cantidad <= 0).length;
    const tarjetas = [
      ['Total vendido', cop.format(c.totalCOP), c.totalUSD != null ? `aprox. ${usd.format(c.totalUSD)}` : ''],
      ['Ventas', num.format(c.numVentas), c.numAnuladas ? plural(c.numAnuladas, 'línea anulada', 'líneas anuladas') : 'Ninguna anulada'],
      ['Unidades vendidas', num.format(c.unidades), `De ${plural(c.porProducto.length, 'producto', 'productos')}`],
      ['Por agotarse', num.format(c.porAgotarse.length), agotados ? `${plural(agotados, 'agotado', 'agotados')}` : 'Ninguno agotado'],
    ];
    const espacio = 10;
    const anchoTarjeta = (ancho - margen * 2 - espacio * 3) / 4;
    tarjetas.forEach(([etiqueta, valor, nota], i) => {
      const x = margen + i * (anchoTarjeta + espacio);
      const y = 112;
      const principal = i === 0;
      doc.setDrawColor(...rgb(principal ? COLOR.primario : COLOR.borde));
      doc.setFillColor(...rgb(principal ? COLOR.primarioClaro : 'FFFFFF'));
      doc.setLineWidth(principal ? 1.2 : 0.8);
      doc.roundedRect(x, y, anchoTarjeta, 66, 6, 6, 'FD');
      doc.setTextColor(...rgb(COLOR.gris));
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.text(etiqueta, x + 10, y + 17);
      doc.setTextColor(...rgb(COLOR.texto));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(principal ? 16 : 15);
      doc.text(limpio(valor), x + 10, y + 40);
      doc.setTextColor(...rgb(COLOR.gris));
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.text(limpio(nota), x + 10, y + 56);
    });

    // ---- Tablas ----
    let y = 202;
    const estiloBase = {
      theme: 'grid',
      rowPageBreak: 'avoid',   // una fila nunca queda partida entre dos páginas
      margin: { left: margen, right: margen, bottom: 50 },
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, lineColor: rgb(COLOR.borde), lineWidth: 0.5, textColor: rgb(COLOR.texto) },
      headStyles: { fillColor: rgb(COLOR.texto), textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: rgb(COLOR.grisClaro) },
      footStyles: { fillColor: rgb(COLOR.primarioClaro), textColor: rgb(COLOR.texto), fontStyle: 'bold' },
    };

    function titulo(texto, nota) {
      if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = 50; }
      doc.setTextColor(...rgb(COLOR.texto));
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12.5);
      doc.text(texto, margen, y);
      if (nota) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...rgb(COLOR.gris));
        doc.text(nota, margen, y + 13);
        y += 13;
      }
      y += 8;
    }

    function sinDatos(texto) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9.5);
      doc.setTextColor(...rgb(COLOR.gris));
      doc.text(texto, margen, y + 12);
      y += 34;
    }

    const derecha = { halign: 'right' };

    if (!c.unDia) {
      titulo('Ventas por día');
      if (c.porDia.length) {
        doc.autoTable({
          ...estiloBase, startY: y,
          head: [['Día', 'Ventas', 'Unidades', 'Total']],
          body: c.porDia.map((d) => [mayuscula(diaLargo.format(new Date(`${d.fecha}T00:00:00Z`))), num.format(d.ventas), num.format(d.unidades), limpio(cop.format(d.total))]),
          foot: [['TOTAL', num.format(c.numVentas), num.format(c.unidades), limpio(cop.format(c.totalCOP))]],
          columnStyles: { 1: { cellWidth: 58 }, 2: { cellWidth: 58 }, 3: { cellWidth: 90 } },
          didParseCell: (d) => { if (d.column.index > 0) d.cell.styles.halign = 'right'; },
        });
        y = doc.lastAutoTable.finalY + 26;
      } else {
        sinDatos('No hubo ventas en este periodo.');
      }
    }

    titulo('Productos más vendidos');
    if (c.porProducto.length) {
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['Código', 'Producto', 'Unidades', 'Total', '% del total']],
        body: c.porProducto.map((p) => [p.codigo || '-', p.nombre, num.format(p.unidades), limpio(cop.format(p.total)),
          `${porcentaje.format(c.totalCOP ? (p.total / c.totalCOP) * 100 : 0)} %`]),
        foot: [['', 'TOTAL', num.format(c.unidades), limpio(cop.format(c.totalCOP)), '100,0 %']],
        columnStyles: { 0: { cellWidth: 62 }, 2: { ...derecha, cellWidth: 58 }, 3: { ...derecha, cellWidth: 82 }, 4: { ...derecha, cellWidth: 62 } },
        didParseCell: (d) => { if ([2, 3, 4].includes(d.column.index)) d.cell.styles.halign = 'right'; },
      });
      y = doc.lastAutoTable.finalY + 26;
    } else {
      sinDatos('No hubo ventas en este periodo.');
    }

    titulo('Ventas por vendedor');
    if (c.porVendedor.length) {
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['Vendedor', 'Ventas', 'Unidades', 'Total', '% del total']],
        body: c.porVendedor.map((v) => [v.vendedor, num.format(v.ventas), num.format(v.unidades), limpio(cop.format(v.total)),
          `${porcentaje.format(c.totalCOP ? (v.total / c.totalCOP) * 100 : 0)} %`]),
        foot: [['TOTAL', num.format(c.numVentas), num.format(c.unidades), limpio(cop.format(c.totalCOP)), '100,0 %']],
        columnStyles: { 1: { cellWidth: 58 }, 2: { cellWidth: 58 }, 3: { cellWidth: 82 }, 4: { cellWidth: 62 } },
        didParseCell: (d) => { if (d.column.index > 0) d.cell.styles.halign = 'right'; },
      });
      y = doc.lastAutoTable.finalY + 26;
    } else {
      sinDatos('No hubo ventas en este periodo.');
    }

    titulo('Detalle de ventas', c.numAnuladas ? 'Las ventas anuladas aparecen en gris, marcadas (ANULADA), y no suman en los totales.' : null);
    if (c.ventas.length) {
      const ordenadas = [...c.ventas].sort((a, b) => a.vendido_en.localeCompare(b.vendido_en));
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['N.º', c.unDia ? 'Hora' : 'Fecha', 'Código', 'Producto', 'Cant.', 'Precio unit.', 'Total', 'Vendedor']],
        body: ordenadas.map((v) => [v.ticket ? '#' + v.ticket : '-', cuando(c, v.vendido_en), v.codigo || '-',
          v.anulada_en ? `${v.nombre}  (ANULADA)` : v.nombre, num.format(v.cantidad),
          limpio(cop.format(v.precio_unitario)), limpio(cop.format(v.total)), v.vendedor || '-']),
        foot: [['', '', '', 'TOTAL', num.format(c.unidades), '', limpio(cop.format(c.totalCOP)), '']],
        columnStyles: { 0: { cellWidth: 34 }, 1: { cellWidth: c.unDia ? 58 : 92 }, 2: { cellWidth: 50 }, 4: { cellWidth: 32 }, 5: { cellWidth: 64 }, 6: { cellWidth: 68 }, 7: { cellWidth: 52 } },
        didParseCell: (d) => {
          if ([4, 5, 6].includes(d.column.index)) d.cell.styles.halign = 'right';
          if (d.section === 'body' && ordenadas[d.row.index].anulada_en) {
            d.cell.styles.textColor = rgb(COLOR.gris);
            d.cell.styles.fontStyle = 'italic';
          }
        },
      });
      y = doc.lastAutoTable.finalY + 26;
    } else {
      sinDatos('No hubo ventas en este periodo.');
    }

    titulo('Entradas y salidas de mercancía', 'Autorizadas con la clave del jefe');
    if (c.movimientos.length) {
      const movs = [...c.movimientos].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['Hora', 'Código', 'Producto', 'Tipo', 'Cant.', 'Había', 'Quedó', 'Motivo']],
        body: movs.map((m) => [cuando(c, m.creado_en), m.codigo || '-', m.nombre, TIPO_MOVIMIENTO[m.tipo],
          `${m.tipo === 'salida' ? '-' : '+'}${num.format(m.cantidad)}`, m.stock_antes ?? '-', m.stock_despues ?? '-',
          m.tipo === 'anulacion' ? 'Venta anulada' : m.motivo]),
        columnStyles: { 0: { cellWidth: c.unDia ? 64 : 92 }, 1: { cellWidth: 52 }, 3: { cellWidth: 62 }, 4: { cellWidth: 36 }, 5: { cellWidth: 38 }, 6: { cellWidth: 38 }, 7: { cellWidth: 92 } },
        didParseCell: (d) => {
          if ([4, 5, 6].includes(d.column.index)) d.cell.styles.halign = 'right';
          if (d.section === 'body' && d.column.index === 4) {
            d.cell.styles.fontStyle = 'bold';
            d.cell.styles.textColor = rgb(movs[d.row.index].tipo === 'salida' ? COLOR.rojo : '166534');
          }
        },
      });
      y = doc.lastAutoTable.finalY + 26;
    } else {
      sinDatos('No hubo entradas ni salidas en este periodo.');
    }

    titulo('Cambios de precio', 'Quién cambió cada precio, cuándo y de cuánto a cuánto');
    if (c.cambiosPrecio.length) {
      const cambios = [...c.cambiosPrecio].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [[c.unDia ? 'Hora' : 'Fecha', 'Código', 'Producto', 'Antes', 'Ahora', 'Por']],
        body: cambios.map((h) => [cuando(c, h.creado_en), h.codigo || '-', h.nombre,
          h.precio_anterior == null ? '-' : limpio(cop.format(h.precio_anterior)), limpio(cop.format(h.precio_nuevo)),
          `${h.usuario || '-'}${h.origen === 'importacion' ? ' (Excel)' : ''}`]),
        columnStyles: { 0: { cellWidth: c.unDia ? 58 : 92 }, 1: { cellWidth: 52 }, 3: { cellWidth: 70 }, 4: { cellWidth: 70, fontStyle: 'bold' }, 5: { cellWidth: 70 } },
        didParseCell: (d) => { if ([3, 4].includes(d.column.index)) d.cell.styles.halign = 'right'; },
      });
      y = doc.lastAutoTable.finalY + 26;
    } else {
      sinDatos('No hubo cambios de precio en este periodo.');
    }

    titulo('Productos por agotarse', `Inventario actual con ${c.stockBajo} unidades o menos`);
    if (c.porAgotarse.length) {
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['Código', 'Producto', 'Quedan', 'Estado']],
        body: c.porAgotarse.map((p) => [p.codigo || '-', p.nombre, num.format(p.cantidad), p.cantidad <= 0 ? 'Agotado' : 'Pocas unidades']),
        columnStyles: { 0: { cellWidth: 62 }, 2: { ...derecha, cellWidth: 52 }, 3: { cellWidth: 92 } },
        didParseCell: (d) => {
          if (d.column.index === 2) d.cell.styles.halign = 'right';
          if (d.section === 'body' && d.column.index === 3) {
            const agotado = c.porAgotarse[d.row.index].cantidad <= 0;
            d.cell.styles.fillColor = rgb(agotado ? COLOR.rojoClaro : COLOR.ambarClaro);
            d.cell.styles.textColor = rgb(agotado ? COLOR.rojo : COLOR.ambar);
            d.cell.styles.fontStyle = 'bold';
          }
        },
      });
    } else {
      sinDatos('Ningún producto está por agotarse.');
    }

    // ---- Pie de página en todas las hojas ----
    const paginas = doc.internal.getNumberOfPages();
    const alto = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= paginas; i++) {
      doc.setPage(i);
      doc.setDrawColor(...rgb(COLOR.borde));
      doc.setLineWidth(0.5);
      doc.line(margen, alto - 32, ancho - margen, alto - 32);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...rgb(COLOR.gris));
      const pie = c.unDia ? c.desde.split('-').reverse().join('/') : `${c.desde.split('-').reverse().join('/')} a ${c.hasta.split('-').reverse().join('/')}`;
      doc.text(`Sistema Mayor · ${tituloReporte(c)} ${pie}`, margen, alto - 18);
      doc.text(`Página ${i} de ${paginas}`, ancho - margen, alto - 18, { align: 'right' });
    }

    doc.save(nombreArchivo(c, 'pdf'));
  }

  // ================================================================
  // Importación: plantilla y lectura del archivo
  // ================================================================

  const COLUMNAS_IMPORTAR = [
    { clave: 'codigo', titulo: 'Código', ancho: 14 },
    { clave: 'nombre', titulo: 'Nombre', ancho: 46 },
    { clave: 'descripcion', titulo: 'Descripción', ancho: 36 },
    { clave: 'cantidad', titulo: 'Cantidad', ancho: 11, formato: FMT_NUM },
    { clave: 'precio', titulo: 'Precio (pesos COP)', ancho: 19, formato: FMT_COP },
  ];

  // Plantilla con el inventario actual: se corrige o se completa y se vuelve a subir.
  async function plantilla(inventario, fecha) {
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
      hoja.addRow({ codigo: p.codigo || '', nombre: p.nombre, descripcion: p.descripcion || '', cantidad: p.cantidad, precio: Number(p.precio_cop) });
    }

    const ayuda = libro.addWorksheet('Instrucciones');
    ayuda.getColumn(1).width = 110;
    [
      'Cómo usar esta plantilla',
      '',
      `• Trae el inventario del ${fecha.split('-').reverse().join('/')}. Cada fila de la hoja "Productos" es un producto.`,
      '• El código es obligatorio y no se puede repetir. Si el código ya existe, se actualiza ese producto; si no existe, se crea.',
      '• Para un producto nuevo, el nombre y el precio son obligatorios.',
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

  const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

  // Reconoce los títulos aunque estén escritos distinto ("Cód.", "Existencia", "Precio COP"…).
  function columnaDe(titulo) {
    const t = normalizar(titulo);
    if (!t) return null;
    if (/^(codigo|cod\b|cod\.|ref)/.test(t)) return 'codigo';
    if (/^(nombre|producto)/.test(t)) return 'nombre';
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
          };
          const precio = numeroDe(v('precio'));
          const cantidad = numeroDe(v('cantidad'));
          if (!datos.codigo && !datos.nombre && !datos.descripcion && precio == null && cantidad == null) continue;   // fila vacía

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

  return { excel, pdf, plantilla, leerProductos };
})();
