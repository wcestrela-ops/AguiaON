// Águia-ON Service Worker v2
const CACHE = 'agon-v2';
const SHELL = [
  '/',
  '/login',
  '/portal',
  '/login.html',
  '/portal.html',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

// Install — pré-cache do shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

// Activate — limpa caches antigos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
// - Chamadas de API (/auth/, /client/, /admin/, /lojista/) → network-first
// - Resto → cache-first (shell, assets)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Ignora requisições não-GET e de terceiros
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // API → network-first
  if (/^\/(auth|client|admin|lojista|public|actions|m)\//i.test(url.pathname)) {
    e.respondWith(
      fetch(e.request).catch(() => new Response(JSON.stringify({ error: 'Offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      }))
    );
    return;
  }

  // Shell + assets → stale-while-revalidate (serve cache e atualiza)
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request);
      const networkFetch = fetch(e.request).then(res => {
        if (res.ok) {
          cache.put(e.request, res.clone());
          // Se o arquivo mudou, avisa a página (opcional, mas aqui vamos apenas garantir o fetch)
        }
        return res;
      }).catch(() => null);

      // Para páginas HTML, preferimos Network-First para evitar que o usuário veja versões velhas
      if (e.request.mode === 'navigate') {
        return networkFetch || cached;
      }

      return cached || networkFetch;
    })
  );
});
