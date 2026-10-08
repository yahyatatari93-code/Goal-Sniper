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
// 🌟 نظام إرسال الإشعارات عبر OneSignal (مع الشعار) 🌟
// ==========================================

// رابط الشعار الخاص بلعبتك (ضع رابط صورتك المباشر هنا)
const NOTIFICATION_ICON_URL = 'https://github.com/yahyatatari93-code/Goal-Sniper/raw/main/goal-sniper.png'; // 👈 استبدله برابط شعارك المباشر

// 1. إشعار للاعب محدد
async function sendFCMToUser(username, title, body) {
    try {
        const appId = process.env.ONESIGNAL_APP_ID;
        const apiKey = process.env.ONESIGNAL_REST_API_KEY;
        if (!appId || !apiKey) return;

        await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${apiKey}`
            },
            body: JSON.stringify({
                app_id: appId,
                include_external_user_ids: [username],
                headings: { "en": title, "ar": title },
                contents: { "en": body, "ar": body },
                // 🌟 إضافة الشعار هنا 🌟
                large_icon: NOTIFICATION_ICON_URL,
                ios_attachments: { id: NOTIFICATION_ICON_URL }
            })
        });
    } catch (error) { console.error(`خطأ إشعار OneSignal لـ ${username}:`, error.message); }
}

// 2. إشعار جماعي لكل اللاعبين
async function sendFCMToAll(title, body) {
    try {
        const appId = process.env.ONESIGNAL_APP_ID;
        const apiKey = process.env.ONESIGNAL_REST_API_KEY;
        if (!appId || !apiKey) return;

        await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${apiKey}`
            },
            body: JSON.stringify({
                app_id: appId,
                included_segments: ["All"],
                headings: { "en": title, "ar": title },
                contents: { "en": body, "ar": body },
                // 🌟 إضافة الشعار هنا 🌟
                large_icon: NOTIFICATION_ICON_URL,
                ios_attachments: { id: NOTIFICATION_ICON_URL }
            })
        });
    } catch (error) { console.error(`خطأ إشعار جماعي OneSignal:`, error.message); }
}
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
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: "59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com" });
        const email = ticket.getPayload()['email'];
        const googleId = ticket.getPayload()['sub'];

        const [existing] = await pool.query('SELECT * FROM users WHERE username = ?', [chosenUsername]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'اسم القناص هذا محجوز سلفاً.' });

        let validReferredBy = null;
        if (referralCode && referralCode.trim() !== '') {
            const [refCheck] = await pool.query('SELECT username FROM users WHERE referral_code = ?', [referralCode.trim()]);
            if (refCheck.length > 0) {
                validReferredBy = refCheck[0].username;
                await pool.query('UPDATE users SET tokens = tokens + 50 WHERE username = ?', [validReferredBy]);
                // 🌟 إشعار: مكافأة الدعوة 🌟
                sendFCMToUser(validReferredBy, '🎁 قناص جديد في صفوفك!', `انضم صديق باستخدام الكود الخاص بك، وكسبت 50 توكن!`);
            } else {
                return res.status(400).json({ success: false, message: 'رمز الدعوة غير صحيح.' });
            }
        }

        const generateCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
        let newReferralCode = generateCode();
        let [codeExists] = await pool.query('SELECT username FROM users WHERE referral_code = ?', [newReferralCode]);
        while (codeExists.length > 0) {
            newReferralCode = generateCode();
            [codeExists] = await pool.query('SELECT username FROM users WHERE referral_code = ?', [newReferralCode]);
        }

        await pool.query(
            'INSERT INTO users (username, pin, email, google_id, referral_code, referred_by, tokens, shields, extra_snipers) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)',
            [chosenUsername, chosenPin || 'GOOGLE_AUTH', email, googleId, newReferralCode, validReferredBy]
        );

        const jwtToken = jwt.sign({ username: chosenUsername }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        res.json({ success: true, user: { username: chosenUsername, email: email, tokens: 0 }, token: jwtToken });

    } catch (error) { res.status(401).json({ success: false, message: 'فشل إكمال التسجيل.' }); }
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
        // 🌟 تم إضافة جلب الدروع والرصاص لكي يتحدث المتجر 🌟
        const [users] = await pool.query('SELECT username, tokens, shields, extra_snipers, referral_code FROM users');
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
    const { username, item } = req.body; // 🛑 قمنا بإلغاء استقبال cost من الهاتف

    // حماية: التأكد من أن اللاعب يشتري لحسابه الخاص
    if (req.user.username !== username) return res.status(403).json({ success: false, message: 'غير مصرح.' });

    // 🛡️ تحديد السعر بشكل صارم من داخل السيرفر 
    let cost = 0;
    if (item === 'shield') cost = 30; // استبدل الرقم بسعرك الفعلي
    else if (item === 'sniper') cost = 50; // استبدل الرقم بسعرك الفعلي
    else if (item === 'tshirt') cost = 500; // استبدل الرقم بسعرك الفعلي
    else return res.status(400).json({ success: false, message: 'عنصر غير معروف.' });

    try {
        const [users] = await pool.query('SELECT tokens FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'حساب غير موجود.' });

        if (users[0].tokens < cost) {
            return res.status(400).json({ success: false, message: 'رصيد التوكن غير كافٍ.' });
        }

        if (item === 'shield') {
            await pool.query('UPDATE users SET tokens = tokens - ?, shields = shields + 1 WHERE username = ?', [cost, username]);
        } else if (item === 'sniper') {
            await pool.query('UPDATE users SET tokens = tokens - ?, extra_snipers = extra_snipers + 1 WHERE username = ?', [cost, username]);
        } else if (item === 'tshirt') {
            await pool.query('UPDATE users SET tokens = tokens - ? WHERE username = ?', [cost, username]);
        }

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
// 🛡️ أضفنا authenticateToken هنا
app.post('/api/sniper/shoot', authenticateToken, async (req, res) => {
    const { leagueCode, gw, sniper, victim, pointsDeducted, isBought } = req.body;
    if (req.user.username !== sniper) return res.status(403).json({ success: false, message: 'لا يمكنك إطلاق النار نيابة عن لاعب آخر!' });

    try {
        const [existing] = await pool.query('SELECT id FROM sniper_shots WHERE league_code = ? AND gw = ? AND sniper = ?', [leagueCode, gw, sniper]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'استخدمت رصاصتك في هذا الدوري لهذه الجولة مسبقاً!' });

        const [victimData] = await pool.query('SELECT shields FROM users WHERE username = ?', [victim]);
        const [sniperData] = await pool.query('SELECT extra_snipers FROM users WHERE username = ?', [sniper]);

        if (isBought && sniperData[0].extra_snipers <= 0) return res.status(400).json({ success: false, message: 'لا تملك رصاصات إضافية.' });

        let actualDeduction = pointsDeducted;
        let msg = 'تمت عملية القنص بنجاح!';

        if (victimData[0].shields > 0) {
            actualDeduction = 0; 
            msg = `💥 الضربة طاشت! [${victim}] تصدى للرصاصة.`;
            await pool.query('UPDATE users SET shields = shields - 1 WHERE username = ?', [victim]);
            // 🌟 إشعار: الدرع السري 🌟
            sendFCMToUser(victim, '🛡️ ضربة طائشة!', `حاول ${sniper} قنصك، لكن درعك السري تصدى للرصاصة بنجاح!`);
        } else {
            // 🌟 إشعار: الإصابة الناجحة 🌟
            sendFCMToUser(victim, '💥 تمت إصابتك!', `القناص ${sniper} قنصك وخصم من رصيدك في دوري ${leagueCode}!`);
        }

        if (isBought) await pool.query('UPDATE users SET extra_snipers = extra_snipers - 1 WHERE username = ?', [sniper]);

        await pool.query('INSERT INTO sniper_shots (league_code, gw, sniper, victim, points_deducted) VALUES (?, ?, ?, ?, ?)', [leagueCode, gw, sniper, victim, actualDeduction]);
        res.json({ success: true, message: msg });

    } catch (error) { res.status(500).json({ success: false, message: 'خطأ في السيرفر.' }); }
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

// 🌟 مسار حفظ النتيجة وتوزيع أو خصم مكافآت التوكن (مع دعم الحذف والإلغاء) 🌟
app.post('/api/admin/result', async (req, res) => {
    const { matchId, actualH, actualA } = req.body;
    try {
        // 1. جلب النتيجة القديمة للمباراة قبل التعديل (لنكتشف هل كان هناك نتيجة مثبتة مسبقاً)
        const [oldMatchData] = await pool.query('SELECT actual_h, actual_a, gw FROM matches WHERE id = ?', [matchId]);
        const matchGw = oldMatchData.length > 0 ? Number(oldMatchData[0].gw) : 1;
        const oldH = oldMatchData.length > 0 ? oldMatchData[0].actual_h : null;
        const oldA = oldMatchData.length > 0 ? oldMatchData[0].actual_a : null;

        const isEligibleForTokens = (matchGw >= 6 && matchGw !== 101);

        // 2. إذا كانت الإدارة تريد "إلغاء النتيجة" (حذفها)
        if (actualH === null || actualA === null) {
            // إذا كانت النتيجة القديمة موجودة وتم منح توكن سابقاً، يجب خصمه من الفائزين السابقين لكي لا يسرقوا التوكن!
            if (oldH !== null && oldA !== null && isEligibleForTokens) {
                const [oldPredictions] = await pool.query('SELECT username, pred_h, pred_a, is_magnet FROM predictions WHERE match_id = ?', [matchId]);
                const oldExactGuessers = [];

                oldPredictions.forEach(p => {
                    const ph = Number(p.pred_h);
                    const pa = Number(p.pred_a);
                    const isMagnet = (p.is_magnet === 1 || p.is_magnet === 'true');
                    let isExact = (ph === Number(oldH) && pa === Number(oldA));
                    if (isMagnet && !isExact && (Math.abs(ph - Number(oldH)) + Math.abs(pa - Number(oldA)) === 1)) {
                        isExact = true; 
                    }
                    if (isExact) oldExactGuessers.push(p.username);
                });

                if (oldExactGuessers.length > 0) {
                    const placeholders = oldExactGuessers.map(() => '?').join(',');
                    // خصم الـ 10 توكن التي مُحت بالخطأ أو أُلغيت نتيجتها
                    await pool.query(`UPDATE users SET tokens = GREATEST(0, tokens - 10) WHERE username IN (${placeholders})`, oldExactGuessers);
                }
            }

            await pool.query('UPDATE matches SET actual_h = NULL, actual_a = NULL WHERE id = ?', [matchId]);
            return res.json({ success: true, message: 'تم إلغاء النتيجة وخصم التوكن المرتبط بها بنجاح.' });
        }

        // 3. حالة التثبيت العادية
        await pool.query('UPDATE matches SET actual_h = ?, actual_a = ? WHERE id = ?', [actualH, actualA, matchId]);
        const [predictions] = await pool.query('SELECT username, pred_h, pred_a, is_magnet FROM predictions WHERE match_id = ?', [matchId]);
        
        const exactGuessers = [];

        predictions.forEach(p => {
            const ph = Number(p.pred_h);
            const pa = Number(p.pred_a);
            const ah = Number(actualH);
            const aa = Number(actualA);
            
            const isMagnet = (p.is_magnet === 1 || p.is_magnet === 'true');
            let isExact = (ph === ah && pa === aa);
            if (isMagnet && !isExact && (Math.abs(ph - ah) + Math.abs(pa - aa) === 1)) {
                isExact = true; 
            }

            if (isExact) exactGuessers.push(p.username);
        });

        if (isEligibleForTokens && exactGuessers.length > 0) {
            const placeholders = exactGuessers.map(() => '?').join(',');
            await pool.query(`UPDATE users SET tokens = tokens + 10 WHERE username IN (${placeholders})`, exactGuessers);
            
            exactGuessers.forEach(winner => {
                sendFCMToUser(winner, '🎯 قناص محترف!', `توقعك للمباراة كان دقيقاً. تمت إضافة 10 توكن لمحفظتك في المتجر!`);
            });
        }

        sendFCMToAll('⏱️ تم تثبيت النتيجة!', 'انتهت إحدى المواجهات، ادخل فوراً لترى كم نقطة حصدت!');

        const adminMsg = isEligibleForTokens 
            ? 'تم تثبيت النتيجة وتوزيع التوكن للقناصين بنجاح!' 
            : 'تم تثبيت النتيجة فقط (بدون توكن لأنها جولة سابقة)';

        res.json({ success: true, message: adminMsg });
    } catch (error) { 
        console.error(error);
        res.status(500).json({ success: false, message: 'فشل حفظ النتيجة وتوزيع التوكن.' }); 
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

// 🌟 مسار البث المباشر (إرسال إشعار مخصص للجميع) 🌟
app.post('/api/admin/broadcast', async (req, res) => {
    const { adminPassword, title, body } = req.body;
    if (adminPassword !== '101383') return res.status(403).json({ success: false, message: 'غير مصرح!' });

    try {
        await sendFCMToAll(title, body);
        res.json({ success: true, message: 'تم إطلاق الإشعار لجميع القناصين بنجاح 🚀' });
    } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

const PORT = process.env.PORT || 5000;

// ==========================================
// 🌟 نظام المراقب الآلي (Cron Job) للتذكير بالمباريات (يومياً) 🌟
// ==========================================
const notifiedDays = new Set(); // ذاكرة مؤقتة لمنع تكرار الإشعار لنفس اليوم في نفس الجولة

function parseMatchDateTime(dateStr, timeStr) {
    try {
        let [d, m, y] = dateStr.split('/');
        let [time, period] = (timeStr || '').trim().split(/\s+/);
        let [hours, minutes] = (time || '0:0').split(':');
        hours = parseInt(hours, 10);
        minutes = parseInt(minutes, 10);
        
        if (period === 'م' || period === 'PM') {
            if (hours !== 12) hours += 12;
        } else if (period === 'ص' || period === 'AM') {
            if (hours === 12) hours = 0;
        }
        
        // دمج الوقت مع (توقيت تركيا وسوريا +03:00)
        const isoString = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00+03:00`;
        return new Date(isoString).getTime();
    } catch (e) {
        return 0;
    }
}

async function checkUpcomingMatches() {
    try {
        const [matches] = await pool.query('SELECT gw, league, date, time FROM matches WHERE actual_h IS NULL');
        if (matches.length === 0) return;

        const firstMatchesPerDay = {};

        // 1. تجميع المباريات لمعرفة "المباراة الافتتاحية" في *كل يوم*
        matches.forEach(m => {
            // 🌟 التعديل الجذري: دمج التاريخ في المفتاح ليكون الفحص يومياً 🌟
            const dayKey = `${m.league || 'EPL'}_${m.gw}_${m.date}`; 
            const matchTime = parseMatchDateTime(m.date, m.time);
            if (matchTime === 0) return;

            // حفظ المباراة صاحبة الوقت الأبكر في هذا اليوم بالتحديد
            if (!firstMatchesPerDay[dayKey] || matchTime < firstMatchesPerDay[dayKey].time) {
                firstMatchesPerDay[dayKey] = { gw: m.gw, league: m.league, time: matchTime, date: m.date };
            }
        });

        const now = Date.now();
        
        // 2. فحص كل مباراة افتتاحية يومية
        Object.keys(firstMatchesPerDay).forEach(async (dayKey) => {
            const firstMatch = firstMatchesPerDay[dayKey];
            const timeDiffMinutes = (firstMatch.time - now) / (1000 * 60);

            // 3. إذا كان الوقت المتبقي هو ساعتين ولم نرسل الإشعار بعد لهذا اليوم
            if (timeDiffMinutes > 118 && timeDiffMinutes <= 120) {
                if (!notifiedDays.has(dayKey)) {
                    notifiedDays.add(dayKey); // قفل الإرسال لهذا اليوم لكي لا يتكرر

                    const leagueName = firstMatch.league === 'UCL' ? 'أبطال أوروبا' : 'الدوري الإنجليزي';
                    const gwLabel = firstMatch.league === 'UCL' ? `الجولة ${firstMatch.gw - 100}` : `الجولة ${firstMatch.gw}`;
                    
                    // 🌟 تعديل نص الإشعار ليناسب اليوم 🌟
                    const title = `🚨 مباريات اليوم من ${gwLabel} تقترب!`;
                    const body = `باقي ساعة واحدة فقط على إغلاق التوقعات لأولى مباريات اليوم في ${leagueName}. ادخل واقنص نقاطك الآن قبل فوات الأوان! ⏱️`;

                    await sendFCMToAll(title, body);
                    console.log(`[Auto-Reminder] Sent for ${dayKey}`);
                }
            }
        });
    } catch (error) {
        console.error("Auto Reminder Error:", error.message);
    }
}

// ⏱️ تشغيل المراقب كل 60 ثانية (دقيقة واحدة)
setInterval(checkUpcomingMatches, 60 * 1000);
app.listen(PORT, () => {
    console.log(`Server running securely on port ${PORT}`);
});
