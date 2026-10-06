importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.4.0/firebase-messaging-compat.js');

// بيانات تطبيقك الحقيقية
const firebaseConfig = {
  apiKey: "AIzaSyA9w3alaXxOuKvitoRJ57DFT6jxz869mjE",
  authDomain: "goal-sniper-2d638.firebaseapp.com",
  projectId: "goal-sniper-2d638",
  storageBucket: "goal-sniper-2d638.firebasestorage.app",
  messagingSenderId: "426882285395",
  appId: "1:426882285395:web:ffda11060db3ee1bc8aba6"
};

// تهيئة فايربيس
firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// دالة استقبال الإشعارات في الخلفية
messaging.onBackgroundMessage((payload) => {
  console.log('تم استلام إشعار في الخلفية ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/goal-sniper.png' // مسار لوغو التطبيق ليظهر في الإشعار
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
