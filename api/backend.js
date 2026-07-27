export default async function handler(req, res) {
  // نستلم المسار المطلوب من الواجهة
  const path = req.query.path;
  
  // نربط المسار برابط سيرفر Contabo الخاص بك
  const url = `http://5.189.138.161:3000${path}`;
  
  try {
    const options = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' }
    };
    
    // إذا كان الطلب تسجيل دخول أو إرسال توقع، نمرر البيانات
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      options.body = JSON.stringify(req.body);
    }
    
    const response = await fetch(url, options);
    const data = await response.json();
    
    // إعادة البيانات لتطبيقك
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ 
      error: 'حدث خطأ في جسر الاتصال', 
      details: error.message 
    });
  }
}
