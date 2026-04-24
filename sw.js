self.addEventListener('push', function(event) {
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
});

// Manejar el clic en la notificación para abrir AiduMe
self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const targetUrl = event.notification.data.url || '/';

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