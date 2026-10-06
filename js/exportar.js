'use strict';

// Exporta el cierre del día a Excel (ExcelJS) y PDF (jsPDF + AutoTable).
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

  const nombreArchivo = (c, extension) => `Cierre-del-dia-${c.fecha}.${extension}`;
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
      hoja.getCell(2, 1).value = `${mayuscula(c.fechaLarga)} · generado el ${fechaHora.format(c.generadoEn)} por ${c.generadoPor}`;
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
    encabezado(resumen, 'Cierre del día', 2);
    resumen.getColumn(1).width = 46;
    resumen.getColumn(2).width = 22;
    const indicadores = [
      ['Total vendido (pesos)', c.totalCOP, FMT_COP, true],
      ['Total vendido (dólares, aprox.)', c.totalUSD ?? 'Sin tasa', FMT_USD],
      ['Ventas registradas', c.numVentas, FMT_NUM],
      ['Ventas anuladas', c.numAnuladas, FMT_NUM],
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
      { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' },
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
    const ordenadas = [...c.ventas].sort((a, b) => a.vendido_en.localeCompare(b.vendido_en));
    const ultimaVenta = tabla(hojaVentas, 4, colVentas, ordenadas.map((v) => [
      horaLocalParaExcel(v.vendido_en), v.codigo || '', v.nombre, v.cantidad, Number(v.precio_unitario),
      Number(v.total), v.tasa_usd ? Number(v.total) / Number(v.tasa_usd) : null, v.vendedor, v.anulada_en ? 'Anulada' : 'Vendida',
    ]));
    ordenadas.forEach((v, i) => {
      if (!v.anulada_en) return;
      hojaVentas.getRow(5 + i).eachCell((celda) => {
        celda.font = { italic: true, strike: true, color: { argb: `FF${COLOR.gris}` } };
      });
      hojaVentas.getRow(5 + i).getCell(9).font = { bold: true, color: { argb: `FF${COLOR.rojo}` } };
    });
    if (ordenadas.length) {
      // Los totales suman solo las ventas con estado "Vendida" (no las anuladas).
      const sumaSi = (col) => `SUMIFS(${col}5:${col}${ultimaVenta},I5:I${ultimaVenta},"Vendida")`;
      filaTotal(hojaVentas, ultimaVenta + 1, [
        'TOTAL', null, `${c.numVentas} ventas`,
        { formula: sumaSi('D'), result: c.unidades }, null,
        { formula: sumaSi('F'), result: c.totalCOP },
        { formula: sumaSi('G'), result: c.totalUSD ?? 0 }, null, null,
      ], colVentas);
    } else {
      hojaVentas.getCell(5, 1).value = 'No hubo ventas este día.';
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
      hojaProd.getCell(5, 1).value = 'No hubo ventas este día.';
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
      hojaVend.getCell(5, 1).value = 'No hubo ventas este día.';
    }

    // ---- Hoja: Entradas y salidas ----
    const hojaMov = libro.addWorksheet('Entradas y salidas');
    const colMov = [
      { titulo: 'Hora', ancho: 11, formato: 'h:mm AM/PM' },
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
    if (!movsOrden.length) hojaMov.getCell(5, 1).value = 'No hubo entradas ni salidas este día.';

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
    doc.text('Cierre del día', margen, 56);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(mayuscula(c.fechaLarga), ancho - margen, 56, { align: 'right' });

    doc.setTextColor(...rgb(COLOR.gris));
    doc.setFontSize(9);
    doc.text(limpio(`Generado el ${fechaHora.format(c.generadoEn)} por ${c.generadoPor}`), margen, 98);

    // ---- Indicadores ----
    const agotados = c.porAgotarse.filter((p) => p.cantidad <= 0).length;
    const tarjetas = [
      ['Total vendido', cop.format(c.totalCOP), c.totalUSD != null ? `aprox. ${usd.format(c.totalUSD)}` : ''],
      ['Ventas', num.format(c.numVentas), c.numAnuladas ? plural(c.numAnuladas, 'anulada', 'anuladas') : 'Ninguna anulada'],
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
      sinDatos('No hubo ventas este día.');
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
      sinDatos('No hubo ventas este día.');
    }

    titulo('Detalle de ventas', c.numAnuladas ? 'Las ventas anuladas aparecen en gris, marcadas (ANULADA), y no suman en los totales.' : null);
    if (c.ventas.length) {
      const ordenadas = [...c.ventas].sort((a, b) => a.vendido_en.localeCompare(b.vendido_en));
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['Hora', 'Código', 'Producto', 'Cant.', 'Precio unit.', 'Total', 'Vendedor']],
        body: ordenadas.map((v) => [limpio(hora.format(new Date(v.vendido_en))), v.codigo || '-',
          v.anulada_en ? `${v.nombre}  (ANULADA)` : v.nombre, num.format(v.cantidad),
          limpio(cop.format(v.precio_unitario)), limpio(cop.format(v.total)), v.vendedor || '-']),
        foot: [['', '', 'TOTAL', num.format(c.unidades), '', limpio(cop.format(c.totalCOP)), '']],
        columnStyles: { 0: { cellWidth: 64 }, 1: { cellWidth: 56 }, 3: { ...derecha, cellWidth: 36 }, 4: { ...derecha, cellWidth: 70 }, 5: { ...derecha, cellWidth: 74 }, 6: { cellWidth: 58 } },
        didParseCell: (d) => {
          if ([3, 4, 5].includes(d.column.index)) d.cell.styles.halign = 'right';
          if (d.section === 'body' && ordenadas[d.row.index].anulada_en) {
            d.cell.styles.textColor = rgb(COLOR.gris);
            d.cell.styles.fontStyle = 'italic';
          }
        },
      });
      y = doc.lastAutoTable.finalY + 26;
    } else {
      sinDatos('No hubo ventas este día.');
    }

    titulo('Entradas y salidas de mercancía', 'Autorizadas con la clave del jefe');
    if (c.movimientos.length) {
      const movs = [...c.movimientos].sort((a, b) => a.creado_en.localeCompare(b.creado_en));
      doc.autoTable({
        ...estiloBase, startY: y,
        head: [['Hora', 'Código', 'Producto', 'Tipo', 'Cant.', 'Había', 'Quedó', 'Motivo']],
        body: movs.map((m) => [limpio(hora.format(new Date(m.creado_en))), m.codigo || '-', m.nombre, TIPO_MOVIMIENTO[m.tipo],
          `${m.tipo === 'salida' ? '-' : '+'}${num.format(m.cantidad)}`, m.stock_antes ?? '-', m.stock_despues ?? '-',
          m.tipo === 'anulacion' ? 'Venta anulada' : m.motivo]),
        columnStyles: { 0: { cellWidth: 64 }, 1: { cellWidth: 52 }, 3: { cellWidth: 62 }, 4: { cellWidth: 36 }, 5: { cellWidth: 38 }, 6: { cellWidth: 38 }, 7: { cellWidth: 92 } },
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
      sinDatos('No hubo entradas ni salidas este día.');
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
      doc.text(`Sistema Mayor · Cierre del día ${c.fecha.split('-').reverse().join('/')}`, margen, alto - 18);
      doc.text(`Página ${i} de ${paginas}`, ancho - margen, alto - 18, { align: 'right' });
    }

    doc.save(nombreArchivo(c, 'pdf'));
  }

  return { excel, pdf };
})();
