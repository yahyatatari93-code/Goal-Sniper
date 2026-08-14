const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// 🌟 الجدار الأمني المطور (يسمح بمرور طلبات الآيفون و Vercel بأمان) 🌟
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ... (باقي الكود الخاص بك كما هو بالأسفل)
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
            // 🌟 السحر هنا: توليد مفتاح أمان صالح لمدة سنة 🌟
            const token = jwt.sign({ username: rows[0].username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
            
            res.json({ success: true, user: rows[0], token: token });
        } else {
            res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. مسار إنشاء حساب جديد (Register)
app.post('/api/auth/register', async (req, res) => {
    const { username, pin } = req.body;
    try {
        const [existing] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'اسم المستخدم مستخدم مسبقاً، اختر اسماً آخر.' });
        }
        
        await pool.query('INSERT INTO users (username, pin) VALUES (?, ?)', [username, pin]);
        
        // 🌟 توليد مفتاح أمان للمستخدم الجديد 🌟
        const token = jwt.sign({ username: username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        
        res.json({ success: true, user: { username, pin }, token: token });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// مسار حذف مستخدم (للمدير فقط)
app.post('/api/admin/delete-user', async (req, res) => {
    const { adminPassword, targetUsername } = req.body;

    if (adminPassword !== '101383') {
        return res.status(403).json({ success: false, message: 'غير مصرح لك!' });
    }

    try {
        await pool.query('DELETE FROM mini_league_members WHERE username = ?', [targetUsername]);
        await pool.query('DELETE FROM predictions WHERE username = ?', [targetUsername]);
        const [result] = await pool.query('DELETE FROM users WHERE username = ?', [targetUsername]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        }

        res.json({ success: true, message: `تم مسح اللاعب ${targetUsername} وكل بياناته بنجاح 🧹` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'السبب: ' + error.message });
    }
});

// مسار حذف دوري مصغر (للمدير فقط)
app.post('/api/admin/delete-league', async (req, res) => {
    const { adminPassword, leagueCode } = req.body;

    if (adminPassword !== '101383') {
        return res.status(403).json({ success: false, message: 'غير مصرح لك!' });
    }

    try {
        await pool.query('DELETE FROM mini_league_members WHERE league_code = ?', [leagueCode]);
        const [result] = await pool.query('DELETE FROM mini_leagues WHERE league_code = ?', [leagueCode]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: 'الدوري غير موجود' });
        }

        res.json({ success: true, message: `تم تدمير الدوري ${leagueCode} بنجاح 💥` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: 'السبب: ' + error.message });
    }
});

// جلب نص الشريط المتحرك
app.get('/api/announcement', async (req, res) => {
    try {
        // إنشاء الجدول بصمت إذا لم يكن موجوداً
        await pool.query("CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)");
        const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'marquee' LIMIT 1");
        res.json({ success: true, text: rows.length > 0 ? rows[0].setting_value : 'مرحباً بكم في منصة Goal Sniper! 🎯' });
    } catch (error) { 
        res.json({ success: false, text: '' }); 
    }
});

// تحديث نص الشريط (من لوحة الإدارة)
app.post('/api/admin/announcement', async (req, res) => {
    const { adminPassword, text } = req.body;
    if (adminPassword !== '101383') return res.status(403).json({ success: false, message: 'غير مصرح!' });
    
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)");
        // إدخال أو تحديث النص
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('marquee', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [text, text]);
        res.json({ success: true, message: 'تم تحديث الشريط المتحرك بنجاح 🚀' });
    } catch (error) { 
        res.status(500).json({ success: false, message: error.message }); 
    }
});
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
