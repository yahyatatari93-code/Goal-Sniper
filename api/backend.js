export default async function handler(req, res) {
  // التأكد من جلب المسار بشكل صحيح
  const path = req.query.path || '/';
  const url = `http://5.189.138.161:5000${path}`;
  
  try {
    const options = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' }
    };
    
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      options.body = JSON.stringify(req.body);
    }
    
    const response = await fetch(url, options);
    
    // نقرأ الرد كنص أولاً بدلاً من JSON
    const text = await response.text();
    
    try {
        // نحاول تحويل النص إلى بيانات
        const data = JSON.parse(text);
        res.status(response.status).json(data);
    } catch (e) {
        // إذا كان الرد عبارة عن صفحة HTML (وهذا ما يحدث الآن)، سنطبعه لنعرف من أين جاء
        res.status(response.status).json({ 
            error: "تم اعتراض الاتصال بصفحة HTML", 
            statusCode: response.status,
            content: text.substring(0, 150) // نظهر أول 150 حرف من الصفحة
        });
    }
  } catch (error) {
    res.status(500).json({ error: 'حدث خطأ في جسر الاتصال', details: error.message });
  }
}
