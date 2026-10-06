const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
const googleClient = new OAuth2Client("59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com");

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma', 'Expires']
}));

app.use(express.json());

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'goal_sniper'
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'Server is running securely on Contabo!' });
});

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ success: false, message: 'لم يتم توفير مفتاح أمان' });

    jwt.verify(token, process.env.JWT_SECRET || 'sniper_secret_key_123', (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'مفتاح الأمان غير صالح أو منتهي.' });
        req.user = user;
        next();
    });
};

// ==========================================
// 1. مسارات الدخول القديمة
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
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'اسم المستخدم مستخدم مسبقاً.' });

        await pool.query('INSERT INTO users (username, pin) VALUES (?, ?)', [username, pin]);
        const token = jwt.sign({ username: username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        res.json({ success: true, user: { username, pin }, token: token });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/auth/save-fcm', authenticateToken, async (req, res) => {
    const { username, fcmToken } = req.body;

    if (req.user.username !== username) {
        return res.status(403).json({ success: false, message: 'غير مصرح لك بهذا الإجراء' });
    }

    try {
        await pool.query('UPDATE users SET fcm_token = ? WHERE username = ?', [fcmToken, username]);
        res.json({ success: true, message: 'تم حفظ رمز الإشعارات بنجاح' });
    } catch (error) {
        console.error("FCM Token Save Error:", error);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء حفظ الرمز' });
    }
});

// ==========================================
// 2. مسارات غوغل (التحقق + اختيار الاسم)
// ==========================================
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: "59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com",
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];

        let [users] = await pool.query('SELECT * FROM users WHERE email = ? OR google_id = ?', [email, googleId]);

        if (users.length > 0) {
            let user = users[0];
            if (!user.google_id) {
                await pool.query('UPDATE users SET google_id = ?, email = ? WHERE id = ?', [googleId, email, user.id]);
            }
            const jwtToken = jwt.sign({ username: user.username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
            return res.json({ success: true, user: { username: user.username, email: user.email, tokens: user.tokens || 0 }, token: jwtToken });
        } else {
            return res.json({ success: true, requireUsername: true, googleToken: token });
        }
    } catch (error) {
        console.error("Google Auth Error:", error);
        res.status(401).json({ success: false, message: 'فشل التحقق من هوية غوغل.' });
    }
});

app.post('/api/auth/google/register', async (req, res) => {
    const { token, chosenUsername, chosenPin, referralCode } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: "59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com",
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];

        const [existing] = await pool.query('SELECT * FROM users WHERE username = ?', [chosenUsername]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'اسم القناص هذا محجوز سلفاً، يرجى اختيار اسم آخر.' });

        let validReferredBy = null;

        // 🌟 فحص رمز الدعوة وإعطاء المكافأة للداعي فقط 🌟
        if (referralCode && referralCode.trim() !== '') {
            const [refCheck] = await pool.query('SELECT username FROM users WHERE referral_code = ?', [referralCode.trim()]);
            if (refCheck.length > 0) {
                validReferredBy = refCheck[0].username;

                // إضافة 50 توكن في رصيد الصديق (الداعي) فقط
                await pool.query('UPDATE users SET tokens = tokens + 50 WHERE username = ?', [validReferredBy]);
            } else {
                return res.status(400).json({ success: false, message: 'رمز الدعوة غير صحيح. تأكد منه أو اتركه فارغاً.' });
            }
        }

        const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
        let newReferralCode = generateCode();
        let [codeExists] = await pool.query('SELECT username FROM users WHERE referral_code = ?', [newReferralCode]);
        while (codeExists.length > 0) {
            newReferralCode = generateCode();
            [codeExists] = await pool.query('SELECT username FROM users WHERE referral_code = ?', [newReferralCode]);
        }

        // حفظ اللاعب الجديد برصيد 0 توكن (لأنه المدعو)
        await pool.query(
            'INSERT INTO users (username, pin, email, google_id, referral_code, referred_by, tokens, shields, extra_snipers) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)',
            [chosenUsername, chosenPin || 'GOOGLE_AUTH', email, googleId, newReferralCode, validReferredBy]
        );

        const jwtToken = jwt.sign({ username: chosenUsername }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        res.json({ success: true, user: { username: chosenUsername, email: email, tokens: 0 }, token: jwtToken });

    } catch (error) {
        console.error("Google Register Error:", error);
        res.status(401).json({ success: false, message: 'فشل إكمال التسجيل عبر غوغل.' });
    }
});

// 🌟 3. مسار ربط الحسابات القديمة بحساب غوغل 🌟
app.post('/api/auth/google/link', async (req, res) => {
    const { token, oldUsername, oldPin } = req.body;
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: "59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com",
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];

        // التأكد من صحة بيانات الحساب القديم
        const [users] = await pool.query('SELECT * FROM users WHERE username = ? AND pin = ?', [oldUsername, oldPin]);
        if (users.length === 0) return res.status(401).json({ success: false, message: 'بيانات الحساب القديم غير صحيحة.' });

        let user = users[0];
        // دمج حساب غوغل مع الحساب القديم
        await pool.query('UPDATE users SET google_id = ?, email = ? WHERE id = ?', [googleId, email, user.id]);

        const jwtToken = jwt.sign({ username: user.username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        res.json({ success: true, user: { username: user.username, email: email, tokens: user.tokens || 0 }, token: jwtToken });

    } catch (error) {
        console.error("Google Link Error:", error);
        res.status(500).json({ success: false, message: 'فشل ربط الحساب.' });
    }
});

// ==========================================
// 3. المزامنة والعمليات الأخرى
// ==========================================
app.get('/api/sync', async (req, res) => {
    try {
        const [users] = await pool.query('SELECT username, tokens, referral_code FROM users');
        const [matches] = await pool.query('SELECT id, gw, home, away, date, time, actual_h as actualH, actual_a as actualA FROM matches');
        const [preds] = await pool.query('SELECT username, match_id, pred_h, pred_a, is_captain, is_triple_captain, is_magnet FROM predictions');
        const [leagues] = await pool.query('SELECT name, league_code as code, creator FROM mini_leagues');
        const [members] = await pool.query('SELECT league_code, username FROM mini_league_members');
        const [shots] = await pool.query('SELECT league_code as leagueCode, gw, sniper, victim, points_deducted as pointsDeducted FROM sniper_shots');

        const formattedPreds = {};
        preds.forEach(p => {
            if (!formattedPreds[p.username]) formattedPreds[p.username] = {};
            formattedPreds[p.username][p.match_id] = {
                home: p.pred_h, away: p.pred_a,
                isCaptain: p.is_captain === 1 || p.is_captain === 'true',
                isTripleCaptain: p.is_triple_captain === 1 || p.is_triple_captain === 'true',
                isMagnet: p.is_magnet === 1 || p.is_magnet === 'true'
            };
        });

        const formattedLeagues = leagues.map(l => {
            const leagueMembers = members.filter(m => m.league_code === l.code).map(m => m.username);
            return { name: l.name, code: l.code, creator: l.creator, members: leagueMembers };
        });

        res.json({ success: true, data: { users, matches, predictions: formattedPreds, miniLeagues: formattedLeagues, sniperShots: shots } });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

app.post('/api/predict', authenticateToken, async (req, res) => {
    const { username, matchId, predH, predA, isCaptain, isTripleCaptain, isMagnet } = req.body;
    if (req.user.username !== username) return res.status(403).json({success: false, message: 'المفتاح لا يتطابق مع الحساب'});
    try {
        await pool.query(`
            INSERT INTO predictions (username, match_id, pred_h, pred_a, is_captain, is_triple_captain, is_magnet)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE pred_h = ?, pred_a = ?, is_captain = ?, is_triple_captain = ?, is_magnet = ?
        `, [username, matchId, predH, predA, isCaptain, isTripleCaptain, isMagnet, predH, predA, isCaptain, isTripleCaptain, isMagnet]);
        res.json({ success: true, message: 'تم حفظ التوقع بنجاح' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 🌟 مسار متجر التوكن 🌟
app.post('/api/store/purchase', authenticateToken, async (req, res) => {
    const { username, item, cost } = req.body;

    // حماية: التأكد من أن اللاعب يشتري لحسابه الخاص
    if (req.user.username !== username) return res.status(403).json({ success: false, message: 'غير مصرح.' });

    try {
        // 1. فحص الرصيد
        const [users] = await pool.query('SELECT tokens FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'حساب غير موجود.' });

        if (users[0].tokens < cost) {
            return res.status(400).json({ success: false, message: 'رصيد التوكن غير كافٍ.' });
        }

        // 2. خصم التوكن وإضافة العنصر
        if (item === 'shield') {
            await pool.query('UPDATE users SET tokens = tokens - ?, shields = shields + 1 WHERE username = ?', [cost, username]);
        } else if (item === 'sniper') {
            await pool.query('UPDATE users SET tokens = tokens - ?, extra_snipers = extra_snipers + 1 WHERE username = ?', [cost, username]);
        } else if (item === 'tshirt') {
            // للتيشيرت نخصم الرصيد فقط
            await pool.query('UPDATE users SET tokens = tokens - ? WHERE username = ?', [cost, username]);
        } else {
            return res.status(400).json({ success: false, message: 'عنصر غير معروف.' });
        }

        // 3. جلب الرصيد الجديد لإعادته للتطبيق
        const [updatedUsers] = await pool.query('SELECT tokens FROM users WHERE username = ?', [username]);
        res.json({ success: true, message: 'تم الشراء بنجاح!', newTokens: updatedUsers[0].tokens });

    } catch (error) {
        console.error("Store Purchase Error:", error);
        res.status(500).json({ success: false, message: 'فشل إتمام العملية بسبب خطأ في السيرفر.' });
    }
});

app.post('/api/leagues', authenticateToken, async (req, res) => {
    const { name, code, creator } = req.body;
    try {
        await pool.query('INSERT INTO mini_leagues (name, league_code, creator) VALUES (?, ?, ?)', [name, code, creator]);
        await pool.query('INSERT INTO mini_league_members (league_code, username) VALUES (?, ?)', [code, creator]);
        res.json({ success: true, message: 'تم إنشاء الدوري' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
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
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

// 🌟 مسار إطلاق رصاصة القناص (محدث لدعم الدروع والرصاص المشترى) 🌟
app.post('/api/sniper/shoot', async (req, res) => {
    const { leagueCode, gw, sniper, victim, pointsDeducted, isBought } = req.body;

    try {
        // 1. فحص هل المهاجم قنص مسبقاً في هذه الجولة؟ (يحق له طلقة واحدة في الجولة سواء مجانية أو مشتراة)
        const [existing] = await pool.query('SELECT id FROM sniper_shots WHERE league_code = ? AND gw = ? AND sniper = ?', [leagueCode, gw, sniper]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'استخدمت رصاصتك في هذا الدوري لهذه الجولة مسبقاً!' });

        // 2. جلب بيانات الضحية والمهاجم من القاعدة
        const [victimData] = await pool.query('SELECT shields FROM users WHERE username = ?', [victim]);
        const [sniperData] = await pool.query('SELECT extra_snipers FROM users WHERE username = ?', [sniper]);

        // 3. التحقق من الرصاصة المشتراة
        if (isBought && sniperData[0].extra_snipers <= 0) {
            return res.status(400).json({ success: false, message: 'لا تملك رصاصات إضافية، قم بالشراء من المتجر أولاً.' });
        }

        let actualDeduction = pointsDeducted;
        let msg = 'تمت عملية القنص بنجاح!';

        // 4. فحص الدرع السري للضحية (المفاجأة)
        if (victimData[0].shields > 0) {
            actualDeduction = 0; // كسر الدرع يحمي من خصم النقاط
            msg = `💥 الضربة طاشت! [${victim}] كان يمتلك درع حصانة سري وتصدى لرصاصتك.`;
            // خصم درع واحد من الضحية
            await pool.query('UPDATE users SET shields = shields - 1 WHERE username = ?', [victim]);
        }

        // 5. خصم الرصاصة المشتراة من المهاجم (إذا كانت مدفوعة وليست مجانية للصدارة)
        if (isBought) {
            await pool.query('UPDATE users SET extra_snipers = extra_snipers - 1 WHERE username = ?', [sniper]);
        }

        // 6. تسجيل الضربة في التاريخ (حتى لو طاشت ليراها الجميع)
        await pool.query(
            'INSERT INTO sniper_shots (league_code, gw, sniper, victim, points_deducted) VALUES (?, ?, ?, ?, ?)',
            [leagueCode, gw, sniper, victim, actualDeduction]
        );

        res.json({ success: true, message: msg });

    } catch (error) {
        console.error("Sniper Error:", error);
        res.status(500).json({ success: false, message: 'خطأ في السيرفر أثناء القنص.' });
    }
});

// ==========================================
// 4. لوحة الإدارة
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

// 🌟 مسار حفظ النتيجة وتوزيع مكافآت التوكن للمتوقعين بدقة 🌟
app.post('/api/admin/result', async (req, res) => {
    const { matchId, actualH, actualA } = req.body;

    try {
        // حالة: إلغاء النتيجة (مسحها)
        if (actualH === null || actualA === null) {
            await pool.query('UPDATE matches SET actual_h = NULL, actual_a = NULL WHERE id = ?', [matchId]);
            return res.json({ success: true, message: 'تم إلغاء النتيجة بنجاح.' });
        }

        // 1. حفظ النتيجة الرسمية للمباراة
        await pool.query('UPDATE matches SET actual_h = ?, actual_a = ? WHERE id = ?', [actualH, actualA, matchId]);

        // 2. سحب كل توقعات اللاعبين لهذه المباراة
        const [predictions] = await pool.query('SELECT username, pred_h, pred_a FROM predictions WHERE match_id = ?', [matchId]);

        // 3. البحث عن القناصين الذين أصابوا النتيجة بدقة تامة
        const exactGuessers = [];
        predictions.forEach(p => {
            if (Number(p.pred_h) === Number(actualH) && Number(p.pred_a) === Number(actualA)) {
                exactGuessers.push(p.username);
            }
        });

        // 4. ضخ المكافأة (+10 توكن) لحسابات الفائزين
        if (exactGuessers.length > 0) {
            const placeholders = exactGuessers.map(() => '?').join(',');
            await pool.query(
                `UPDATE users SET tokens = tokens + 10 WHERE username IN (${placeholders})`,
                exactGuessers
            );
            console.log(`تم توزيع 10 توكن على: ${exactGuessers.join(', ')}`);
        }

        res.json({ success: true, message: 'تم تثبيت النتيجة وتوزيع الجوائز بنجاح!' });

    } catch (error) {
        console.error("Result Save Error:", error);
        res.status(500).json({ success: false, message: 'فشل حفظ النتيجة في السيرفر.' });
    }
});

app.post('/api/admin/update-time', authenticateToken, async (req, res) => {
    const { matchId, newDate, newTime } = req.body;
    try {
        await pool.query('UPDATE matches SET date = ?, time = ? WHERE id = ?', [newDate, newTime, matchId]);
        res.json({ success: true, message: 'تم تحديث موعد المباراة بنجاح!' });
    } catch (error) { res.status(500).json({ success: false, message: 'حدث خطأ في تحديث الوقت.' }); }
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
