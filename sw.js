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