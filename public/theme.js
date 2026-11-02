// Tema de la app: "auto" (sigue al sistema), "light" o "dark". Se carga en <head> sin defer
// para aplicarse antes de pintar y evitar un destello del tema equivocado.
(function () {
  var KEY = 'repartos-theme';
  var COLORS = { light: '#f4f5f7', dark: '#0d0f12' };
  var root = document.documentElement;
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');

  function stored() {
    try {
      var value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : 'auto';
    } catch (error) {
      return 'auto';
    }
  }

  // Color de las barras del sistema (estado y, en Android, navegación) acorde al tema efectivo.
  function paintBars(theme) {
    var effective = theme === 'auto' ? (systemDark.matches ? 'dark' : 'light') : theme;
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i += 1) {
      if (theme === 'auto') {
        metas[i].setAttribute('content', /dark/.test(metas[i].getAttribute('media') || '') ? COLORS.dark : COLORS.light);
      } else {
        metas[i].setAttribute('content', COLORS[effective]);
      }
    }
  }

  function apply(theme) {
    if (theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    paintBars(theme);
  }

  apply(stored());
  systemDark.addEventListener('change', function () { apply(stored()); });

  window.repartosTheme = {
    get: stored,
    set: function (theme) {
      try {
        if (theme === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, theme);
      } catch (error) { /* sin almacenamiento: se aplica solo en esta visita */ }
      apply(theme);
    },
  };
}());
