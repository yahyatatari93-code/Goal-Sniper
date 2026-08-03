const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// إعداد الاتصال بقاعدة بيانات MySQL
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', // ضع كلمة مرور قاعدة البيانات الخاصة بك هنا إذا لزم الأمر
    database: process.env.DB_NAME || 'league_oracle'
});

// اختبار الاتصال
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running securely on Contabo!' });
});

// 1. مسار تسجيل الدخول (Login)
app.post('/api/auth/login', async (req, res) => {
    const { username, pin } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND pin = ?', [username, pin]);
        if (rows.length > 0) {
            res.json({ success: true, user: rows[0] });
        } else {
            res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. مسار إنشاء حساب جديد (Register) - تمت إضافته!
app.post('/api/auth/register', async (req, res) => {
    const { username, pin } = req.body;
    try {
        // التحقق مما إذا كان الاسم موجوداً مسبقاً
        const [existing] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'اسم المستخدم مستخدم مسبقاً، اختر اسماً آخر.' });
        }
        
        // إنشاء الحساب الجديد
        await pool.query('INSERT INTO users (username, pin) VALUES (?, ?)', [username, pin]);
        res.json({ success: true, user: { username, pin } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// مسار حذف مستخدم (للمدير فقط)
app.post('/api/admin/delete-user', async (req, res) => {
    const { adminPassword, targetUsername } = req.body;

    // تأمين المسار بكلمة مرور خاصة بك كمدير
    if (adminPassword !== '101383') {
        return res.status(403).json({ success: false, message: 'غير مصرح لك!' });
    }

    try {
        // 1. مسح المستخدم من الدوريات المصغرة
        await db.promise().query('DELETE FROM mini_league_members WHERE username = ?', [targetUsername]);
        
        // 2. مسح جميع توقعاته
        await db.promise().query('DELETE FROM predictions WHERE username = ?', [targetUsername]);
        
        // 3. أخيراً.. مسح حسابه بالكامل
        const [result] = await db.promise().query('DELETE FROM users WHERE username = ?', [targetUsername]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }

        res.json({ success: true, message: `تم مسح اللاعب ${targetUsername} وكل بياناته بنجاح 🧹` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'حدث خطأ في السيرفر' });
    }
});

// مسار حذف دوري مصغر (للمدير فقط)
app.post('/api/admin/delete-league', async (req, res) => {
    const { adminPassword, leagueCode } = req.body;

    if (adminPassword !== '101383') {
        return res.status(403).json({ success: false, message: 'غير مصرح لك!' });
    }

    try {
        // 1. مسح جميع الأعضاء المشتركين في هذا الدوري
        await db.promise().query('DELETE FROM mini_league_members WHERE league_code = ?', [leagueCode]);
        
        // 2. مسح الدوري نفسه
        const [result] = await db.promise().query('DELETE FROM mini_leagues WHERE league_code = ?', [leagueCode]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'الدوري غير موجود' });
        }

        res.json({ success: true, message: `تم تدمير الدوري ${leagueCode} بنجاح 💥` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'حدث خطأ في السيرفر' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
