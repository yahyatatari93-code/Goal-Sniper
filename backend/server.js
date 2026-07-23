// هذا الملف سيعمل على سيرفر Contabo الخاص بك
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();

// إعداد CORS للسماح لتطبيقك المرفوع على Vercel بالتحدث مع هذا السيرفر
app.use(cors({
    origin: '*', // في مرحلة الإطلاق الحقيقية، ضع رابط Vercel الخاص بك هنا
    methods: ['GET', 'POST', 'PUT', 'DELETE']
}));

app.use(express.json());

// إعداد الاتصال بقاعدة بيانات MySQL الموجودة على Contabo
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'league_oracle'
});

// اختبار الاتصال
app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running securely on Contabo!' });
});

// --- أمثلة للواجهات البرمجية (API Endpoints) ---

// 1. مسار تسجيل الدخول
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
        res.status(500).json({ error: error.message });
    }
});

// 2. مسار جلب المباريات
app.get('/api/matches', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM matches ORDER BY gw ASC');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. مسار حفظ التوقع
app.post('/api/predictions', async (req, res) => {
    const { username, matchId, homeScore, awayScore, powerup } = req.body;
    try {
        // يتم استخدام ON DUPLICATE KEY UPDATE لتعديل التوقع إذا كان موجوداً مسبقاً
        await pool.query(
            `INSERT INTO predictions (username, match_id, home_score, away_score, powerup) 
             VALUES (?, ?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE home_score = ?, away_score = ?, powerup = ?`,
            [username, matchId, homeScore, awayScore, powerup, homeScore, awayScore, powerup]
        );
        res.json({ success: true, message: 'تم حفظ التوقع' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
