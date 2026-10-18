// Loaded last, after every tab script has registered its handler.
document.addEventListener('DOMContentLoaded', () => {
  window.openTab(null, 'manage');
});
