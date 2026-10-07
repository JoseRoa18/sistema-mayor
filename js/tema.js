'use strict';

// Selector de tema: Claro, Oscuro o Automático (sigue el modo del equipo).
// La elección se recuerda en cada equipo. El script del <head> ya aplicó el
// tema antes de pintar; aquí se maneja el menú y los cambios posteriores.
(function () {
  const raiz = document.documentElement;
  const sistemaOscuro = window.matchMedia('(prefers-color-scheme: dark)');
  const menu = document.getElementById('menu-tema');
  const NOMBRE = { claro: 'Claro', oscuro: 'Oscuro', auto: 'Automático' };
  const COLOR_BARRA = { claro: '#ffffff', oscuro: '#111827' };   // barra del navegador en celulares
  let botonAbierto = null;

  function leerEleccion() {
    try { return localStorage.getItem('sm-tema') || 'auto'; } catch { return 'auto'; }
  }

  function aplicar(eleccion, animar) {
    const tema = eleccion === 'oscuro' || (eleccion === 'auto' && sistemaOscuro.matches) ? 'oscuro' : 'claro';
    if (animar && raiz.dataset.tema !== tema) {
      // Transición suave solo al cambiar (no al cargar).
      raiz.classList.add('cambiando-tema');
      setTimeout(() => raiz.classList.remove('cambiando-tema'), 350);
    }
    raiz.dataset.tema = tema;
    raiz.dataset.temaEleccion = eleccion;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLOR_BARRA[tema]);
    menu.querySelectorAll('[data-tema-opcion]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.temaOpcion === eleccion));
    });
    document.querySelectorAll('.btn-tema').forEach((b) => {
      b.title = `Tema: ${NOMBRE[eleccion]}${eleccion === 'auto' ? ` (ahora ${NOMBRE[tema].toLowerCase()})` : ''}`;
    });
  }

  function elegir(eleccion) {
    try { localStorage.setItem('sm-tema', eleccion); } catch { /* sin almacenamiento: solo esta vez */ }
    aplicar(eleccion, true);
  }

  // En Automático, si el equipo cambia de modo, la app cambia con él.
  sistemaOscuro.addEventListener('change', () => {
    if (leerEleccion() === 'auto') aplicar('auto', true);
  });

  // ---------------- Menú ----------------

  function abrir(boton) {
    botonAbierto = boton;
    boton.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    const r = boton.getBoundingClientRect();
    const ancho = menu.offsetWidth;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - ancho, window.innerWidth - ancho - 8))}px`;
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus();
  }

  function cerrar(devolverFoco) {
    if (!botonAbierto) return;
    menu.hidden = true;
    botonAbierto.setAttribute('aria-expanded', 'false');
    if (devolverFoco) botonAbierto.focus();
    botonAbierto = null;
  }

  document.querySelectorAll('.btn-tema').forEach((boton) => {
    boton.addEventListener('click', (e) => {
      e.stopPropagation();
      if (botonAbierto === boton) cerrar(true);
      else { cerrar(false); abrir(boton); }
    });
  });

  menu.addEventListener('click', (e) => {
    const opcion = e.target.closest('[data-tema-opcion]');
    if (!opcion) return;
    elegir(opcion.dataset.temaOpcion);
    cerrar(true);
  });

  menu.addEventListener('keydown', (e) => {
    const opciones = [...menu.querySelectorAll('[data-tema-opcion]')];
    const i = opciones.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      opciones[(i + (e.key === 'ArrowDown' ? 1 : opciones.length - 1)) % opciones.length].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      cerrar(e.key === 'Escape');
    }
  });

  document.addEventListener('click', (e) => {
    if (botonAbierto && !menu.contains(e.target)) cerrar(false);
  });
  window.addEventListener('resize', () => cerrar(false));

  aplicar(leerEleccion(), false);
})();
