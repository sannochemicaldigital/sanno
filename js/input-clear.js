// js/input-clear.js
// Menambahkan tombol "×" otomatis di kanan setiap input teks/number/date/search
// yang memiliki value, untuk clear cepat. Global, sekali import di page.

const CLEARABLE_TYPES = new Set(['text', 'search', 'number', 'date', 'email', 'tel', 'url', 'password']);

function attachClearButton(input) {
  if (!input || input.dataset.clearAttached === '1') return;
  if (!CLEARABLE_TYPES.has(input.type)) return;
  if (input.disabled || input.readOnly) return;

  input.dataset.clearAttached = '1';

  // Bungkus input dalam wrapper relatif yang selebar input
  const wrap = document.createElement('span');
  wrap.className = 'input-clear-wrap';
  wrap.style.position = 'relative';
  wrap.style.display = 'block';
  wrap.style.width = '100%';

  // Simpan referensi ke parent & posisi
  const parent = input.parentNode;
  const next = input.nextSibling;

  // Input mengisi wrapper
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.paddingRight = '28px';   // ruang untuk X di dalam field

  // Pindahkan input ke dalam wrapper
  parent.insertBefore(wrap, input);
  wrap.appendChild(input);

  // Tombol X — posisi di dalam field, kanan
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'input-clear-btn';
  btn.setAttribute('aria-label', 'Hapus isi');
  btn.innerHTML = '&times;';
  btn.style.position = 'absolute';
  btn.style.right = '6px';
  btn.style.top = '50%';
  btn.style.transform = 'translateY(-50%)';
  btn.style.border = 'none';
  btn.style.background = 'transparent';
  btn.style.cursor = 'pointer';
  btn.style.fontSize = '16px';
  btn.style.lineHeight = '1';
  btn.style.color = '#9ca3af';
  btn.style.padding = '2px 4px';
  btn.style.display = 'none';
  btn.style.zIndex = '2';

  btn.addEventListener('mouseenter', () => { btn.style.color = '#374151'; });
  btn.addEventListener('mouseleave', () => { btn.style.color = '#9ca3af'; });

  btn.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.focus();
  });

  wrap.appendChild(btn);

  // Tampilkan X hanya jika ada value
  const sync = () => {
    btn.style.display = (input.value && input.value.length > 0) ? 'block' : 'none';
  };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  input.addEventListener('focus', sync);
  sync();
}

function scanAndAttach(root = document) {
  root.querySelectorAll('input').forEach(attachClearButton);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => scanAndAttach());
} else {
  scanAndAttach();
}

const obs = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.tagName === 'INPUT') attachClearButton(node);
      else if (node.querySelectorAll) node.querySelectorAll('input').forEach(attachClearButton);
    }
  }
});
obs.observe(document.body, { childList: true, subtree: true });

export function initInputClear(root) {
  scanAndAttach(root || document);
}