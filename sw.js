const CACHE_NAME = 'aidume-cache-v1';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './style.css',
    './logo-grande.png',
    './auth.js',
    './ui.js',
    './config.js'
];

// Instalar Service Worker y guardar en caché local los recursos esenciales
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('💾 [Service Worker] Guardando assets en almacenamiento local');
            return cache.addAll(ASSETS_TO_CACHE);
        }).then(() => self.skipWaiting())
    );
});

// Activar Service Worker y limpiar cachés antiguos
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keyList) => {
            return Promise.all(keyList.map((key) => {
                if (key !== CACHE_NAME) {
                    console.log('🧹 [Service Worker] Eliminando caché antiguo:', key);
                    return caches.delete(key);
                }
            }));
        }).then(() => self.clients.claim())
    );
});

// Interceptar peticiones: Si hay red, busca online. Si NO hay red, responde desde el caché local
self.addEventListener('fetch', (event) => {
    // Solo interceptar peticiones de navegación o documentos/estilos
    if (event.request.mode === 'navigate' || event.request.method === 'GET') {
        event.respondWith(
            fetch(event.request).catch(() => {
                return caches.match(event.request).then((response) => {
                    if (response) {
                        return response;
                    }
                    // Si el archivo buscado no está en caché, sirve la raíz guardada en almacenamiento local
                    return caches.match('./index.html') || caches.match('./');
                });
            })
        );
    }
});

// Listener existente de notificaciones Push
self.addEventListener('push', function(event) {
    if (!event.data) return;
    try {
        const data = event.data.json();
        const options = {
            body: data.body,
            icon: 'logo-grande.png',
            badge: 'logo-grande.png',
            vibrate: [200, 100, 200],
            data: { url: data.url }
        };
        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    } catch (e) {
        console.error("Error al procesar push notification:", e);
    }
});

// Manejar el clic en la notificación para abrir AiduMe
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            if (clientList.length > 0) {
                for (let client of clientList) {
                    if ('focus' in client && 'navigate' in client) {
                        return client.navigate(targetUrl).then(c => c.focus());
                    }
                }
            }
            if (clients.openWindow) return clients.openWindow(targetUrl);
        })
    );
});