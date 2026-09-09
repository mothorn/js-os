// ─── JS OS service worker: offline shell + notification clicks ───
// Bump CACHE_NAME whenever the list of shell files changes.

const CACHE_NAME = 'jsos-v4.0.0';

const SHELL_FILES = [
    '/',
    '/index.html',
    '/manifest.json',
    '/favicon.ico',
    '/css/style.css',
    '/js/config.js',
    '/js/core.js',
    '/js/clients.js',
    '/js/apps/chat.js',
    '/js/apps/ai.js',
    '/js/apps/tube.js',
    '/js/apps/call.js',
    '/js/desktop.js',
    '/images/logo.png',
    '/images/icon-192.png',
    '/images/icon-512.png',
    '/images/icon-512-maskable.png',
    '/images/apple-touch-icon.png',
    '/sounds/startup.mp3',
    '/sounds/message_sent.mp3',
    '/sounds/minimize_fullscreen_close.mp3',
];

// Install: cache the shell. One missing file must not block the whole install.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => Promise.allSettled(SHELL_FILES.map((file) => cache.add(file))))
            .then(() => self.skipWaiting())
    );
});

// Activate: drop caches from older versions and take over open pages.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
            .then(() => self.clients.claim())
    );
});

// Fetch: network first, cache fallback, for same-origin GET requests to the shell.
// A network that stalls (weak signal, captive portal) counts as failed after a few seconds,
// and an error answer (rate limit, server hiccup) also falls back to the cached copy.
// Live data (API, health, WebSocket upgrades) is never cached.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname === '/health') return;

    const fromCache = async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const shell = await caches.match('/index.html');
            if (shell) return shell;
        }
        return null;
    };

    const network = fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
        }
        return response;
    });
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));

    event.respondWith((async () => {
        try {
            const response = await Promise.race([network, timeout]);
            if (response && response.ok) return response;
            const cached = await fromCache();
            if (cached) return cached;
            if (response) return response;          // an error answer with nothing cached: show it
            return await network;                   // slow but alive, and nothing cached: keep waiting
        } catch {
            const cached = await fromCache();
            if (cached) return cached;
            return new Response('You are offline and this file is not cached.', {
                status: 503,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        }
    })());
});

// A notification was tapped: focus an open JS OS window or open a new one.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
            for (const client of windows) {
                if ('focus' in client) return client.focus();
            }
            return self.clients.openWindow ? self.clients.openWindow('/') : undefined;
        })
    );
});
