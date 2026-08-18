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

// إعداد الاتصال بقاعدة بيانات MySQL
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

// ==========================================
// 🛡️ دالة الحماية المركزية (تمت إضافة return لمنع الخدعة)
// ==========================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'لم يتم توفير مفتاح أمان' });

    jwt.verify(token, process.env.JWT_SECRET || 'sniper_secret_key_123', (err, user) => {
        if (err) {
            // 🛑 هنا وضعنا الفرامل (return) ليقف السيرفر ولا يحفظ التوقع! 🛑
            return res.status(403).json({ success: false, message: 'مفتاح الأمان غير صالح أو منتهي. يرجى تسجيل الخروج والدخول من جديد.' });
        }
        req.user = user;
        next();
    });
};

// ==========================================
// 1. مسارات تسجيل الدخول والحسابات
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { username, pin } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND pin = ?', [username, pin]);
        if (rows.length > 0) {
            const token = jwt.sign({ username: rows[0].username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
            res.json({ success: true, user: rows[0], token: token });
        } else {
            res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { username, pin } = req.body;
    try {
        const [existing] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'اسم المستخدم مستخدم مسبقاً، اختر اسماً آخر.' });
        
        await pool.query('INSERT INTO users (username, pin) VALUES (?, ?)', [username, pin]);
        const token = jwt.sign({ username: username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        res.json({ success: true, user: { username, pin }, token: token });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 2. مسار المزامنة الشامل (الذي كان مفقوداً)
// ==========================================
app.get('/api/sync', async (req, res) => {
    try {
        const [users] = await pool.query('SELECT username FROM users');
        const [matches] = await pool.query('SELECT id, gw, home, away, date, time, actual_h as actualH, actual_a as actualA FROM matches');
        const [preds] = await pool.query('SELECT username, match_id, pred_h, pred_a, is_captain, is_triple_captain FROM predictions');
        const [leagues] = await pool.query('SELECT name, league_code as code, creator FROM mini_leagues');
        const [members] = await pool.query('SELECT league_code, username FROM mini_league_members');
        const [shots] = await pool.query('SELECT league_code as leagueCode, gw, sniper, victim, points_deducted as pointsDeducted FROM sniper_shots');

        const formattedPreds = {};
        preds.forEach(p => {
            if (!formattedPreds[p.username]) formattedPreds[p.username] = {};
            formattedPreds[p.username][p.match_id] = {
                home: p.pred_h, away: p.pred_a,
                isCaptain: p.is_captain === 1 || p.is_captain === 'true',
                isTripleCaptain: p.is_triple_captain === 1 || p.is_triple_captain === 'true'
            };
        });

        const formattedLeagues = leagues.map(l => {
            const leagueMembers = members.filter(m => m.league_code === l.code).map(m => m.username);
            return { name: l.name, code: l.code, creator: l.creator, members: leagueMembers };
        });

        res.json({
            success: true,
            data: { users, matches, predictions: formattedPreds, miniLeagues: formattedLeagues, sniperShots: shots }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 3. مسار حفظ التوقعات (محمي بالجدار الأمني)
// ==========================================
app.post('/api/predict', authenticateToken, async (req, res) => {
    const { username, matchId, predH, predA, isCaptain, isTripleCaptain } = req.body;
    
    // تأكيد إضافي أن المفتاح يخص نفس اللاعب
    if (req.user.username !== username) return res.status(403).json({success: false, message: 'المفتاح لا يتطابق مع الحساب'});

    try {
        await pool.query(`
            INSERT INTO predictions (username, match_id, pred_h, pred_a, is_captain, is_triple_captain)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE pred_h = ?, pred_a = ?, is_captain = ?, is_triple_captain = ?
        `, [username, matchId, predH, predA, isCaptain, isTripleCaptain, predH, predA, isCaptain, isTripleCaptain]);
        
        res.json({ success: true, message: 'تم حفظ التوقع بنجاح' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 4. مسارات الدوريات المصغرة والقناص
// ==========================================
app.post('/api/leagues', authenticateToken, async (req, res) => {
    const { name, code, creator } = req.body;
    try {
        await pool.query('INSERT INTO mini_leagues (name, league_code, creator) VALUES (?, ?, ?)', [name, code, creator]);
        await pool.query('INSERT INTO mini_league_members (league_code, username) VALUES (?, ?)', [code, creator]);
        res.json({ success: true, message: 'تم إنشاء الدوري' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/leagues/join', authenticateToken, async (req, res) => {
    const { code, username } = req.body;
    try {
        const [exists] = await pool.query('SELECT * FROM mini_leagues WHERE league_code = ?', [code]);
        if (exists.length === 0) return res.status(404).json({ success: false, message: 'كود الدوري غير صحيح' });

        const [memberExists] = await pool.query('SELECT * FROM mini_league_members WHERE league_code = ? AND username = ?', [code, username]);
        if (memberExists.length > 0) return res.status(400).json({ success: false, message: 'أنت منضم مسبقاً لهذا الدوري' });

        await pool.query('INSERT INTO mini_league_members (league_code, username) VALUES (?, ?)', [code, username]);
        res.json({ success: true, message: 'تم الانضمام بنجاح' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/sniper/shoot', authenticateToken, async (req, res) => {
    const { leagueCode, gw, sniper, victim, pointsDeducted } = req.body;
    try {
        const [exists] = await pool.query('SELECT * FROM sniper_shots WHERE league_code = ? AND gw = ? AND sniper = ?', [leagueCode, gw, sniper]);
        if (exists.length > 0) return res.status(400).json({ success: false, message: 'لقد استخدمت رصاصة القناص في هذه الجولة مسبقاً!' });

        await pool.query('INSERT INTO sniper_shots (league_code, gw, sniper, victim, points_deducted) VALUES (?, ?, ?, ?, ?)', [leagueCode, gw, sniper, victim, pointsDeducted]);
        res.json({ success: true, message: 'تم القنص بنجاح' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==========================================
// 5. مسارات الإدارة والشريط المتحرك (كما أرسلتها أنت)
// ==========================================
app.post('/api/admin/match', async (req, res) => {
    const { id, gw, home, away, date, time } = req.body;
    try {
        await pool.query('INSERT INTO matches (id, gw, home, away, date, time) VALUES (?, ?, ?, ?, ?, ?)', [id, gw, home, away, date, time]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/admin/match/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM matches WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/admin/result', async (req, res) => {
    const { matchId, actualH, actualA } = req.body;
    try {
        await pool.query('UPDATE matches SET actual_h = ?, actual_a = ? WHERE id = ?', [actualH, actualA, matchId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/admin/delete-user', async (req, res) => {
    const { adminPassword, targetUsername } = req.body;
    if (adminPassword !== '101383') return res.status(403).json({ success: false, message: 'غير مصرح لك!' });
    try {
        await pool.query('DELETE FROM mini_league_members WHERE username = ?', [targetUsername]);
        await pool.query('DELETE FROM predictions WHERE username = ?', [targetUsername]);
        const [result] = await pool.query('DELETE FROM users WHERE username = ?', [targetUsername]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
        res.json({ success: true, message: `تم مسح اللاعب ${targetUsername} وكل بياناته بنجاح 🧹` });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/admin/delete-league', async (req, res) => {
    const { adminPassword, leagueCode } = req.body;
    if (adminPassword !== '101383') return res.status(403).json({ success: false, message: 'غير مصرح لك!' });
    try {
        await pool.query('DELETE FROM mini_league_members WHERE league_code = ?', [leagueCode]);
        const [result] = await pool.query('DELETE FROM mini_leagues WHERE league_code = ?', [leagueCode]);
        if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'الدوري غير موجود' });
        res.json({ success: true, message: `تم تدمير الدوري ${leagueCode} بنجاح 💥` });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.get('/api/announcement', async (req, res) => {
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)");
        const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'marquee' LIMIT 1");
        res.json({ success: true, text: rows.length > 0 ? rows[0].setting_value : 'مرحباً بكم في منصة Goal Sniper! 🎯' });
    } catch (error) { res.json({ success: false, text: '' }); }
});

app.post('/api/admin/announcement', async (req, res) => {
    const { adminPassword, text } = req.body;
    if (adminPassword !== '101383') return res.status(403).json({ success: false, message: 'غير مصرح!' });
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT)");
        await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('marquee', ?) ON DUPLICATE KEY UPDATE setting_value = ?", [text, text]);
        res.json({ success: true, message: 'تم تحديث الشريط المتحرك بنجاح 🚀' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running securely on port ${PORT}`);
});
