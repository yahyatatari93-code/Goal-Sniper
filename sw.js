self.addEventListener('push', function(event) {
    let data = {};
    if (event.data) {
        data = event.data.json();
    }
    
    const title = data.title || 'Goal Sniper';
    const options = {
        body: data.body || 'لديك إشعار جديد من الدوري!',
        icon: 'https://cdn-icons-png.flaticon.com/512/3247/3247492.png', // يمكنك تغييرها لرابط لوغو تطبيقك
        badge: 'https://cdn-icons-png.flaticon.com/512/3247/3247492.png',
        vibrate: [200, 100, 200, 100, 200, 100, 200], // اهتزاز مميز للحماس
        requireInteraction: true // يبقى الإشعار على الشاشة حتى يضغط عليه
    };
    
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(clients.openWindow('/')); // يفتح التطبيق عند الضغط على الإشعار
});
