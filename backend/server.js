const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();
const compression = require('compression');
const NOTIFICATION_ICON_URL = 'https://i.ibb.co/23nmL2fs/goal-sniper.png';

const app = express();       // 👈 تعريف app لمرة واحدة فقط هنا
app.use(compression());      // 👈 تفعيل الضغط

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

// 1. إشعار للاعب محدد
async function sendFCMToUser(username, title, body) {
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;
    if (!appId || !apiKey) throw new Error("مفاتيح الإشعارات (API Keys) مفقودة من السيرفر!");

    const res = await fetch('https://onesignal.com/api/v1/notifications', {
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
            large_icon: NOTIFICATION_ICON_URL,
            ios_attachments: { id: NOTIFICATION_ICON_URL }
        })
    });
    
    const data = await res.json();
    if (data.errors) {
        throw new Error(JSON.stringify(data.errors));
    }
}

// 2. إشعار جماعي لكل اللاعبين
async function sendFCMToAll(title, body) {
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;
    if (!appId || !apiKey) throw new Error("مفاتيح الإشعارات (API Keys) مفقودة من السيرفر!");

    const res = await fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': `Basic ${apiKey}`
        },
        body: JSON.stringify({
            app_id: appId,
            included_segments: ["All"], // 🚀 التعديل الحاسم: العودة للشريحة الأصلية
            headings: { "en": title, "ar": title },
            contents: { "en": body, "ar": body },
            large_icon: NOTIFICATION_ICON_URL,
            ios_attachments: { id: NOTIFICATION_ICON_URL }
        })
    });
    
    const data = await res.json();
    if (data.errors) {
        throw new Error(JSON.stringify(data.errors));
    }
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

// 🌟 5. مسار ربط الحساب من داخل التطبيق (مباشر وآمن عبر التوكن) 🌟
app.post('/api/auth/google/link-internal', authenticateToken, async (req, res) => {
    const { token } = req.body;
    const username = req.user.username; // السيرفر عرف اسم اللاعب تلقائياً من التوكن (بدون سؤال)
    
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: "59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com",
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];

        // التأكد من أن هذا الإيميل غير مستخدم في حساب قناص آخر
        const [existing] = await pool.query('SELECT username FROM users WHERE (email = ? OR google_id = ?) AND username != ?', [email, googleId, username]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'هذا الإيميل مربوط بحساب قناص آخر مسبقاً.' });
        }

        // التحديث المباشر لحساب اللاعب الحالي
        await pool.query('UPDATE users SET google_id = ?, email = ? WHERE username = ?', [googleId, email, username]);
        
        // جلب بيانات اللاعب المحدثة وإرسالها للتطبيق
        const [updatedUser] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        const jwtToken = jwt.sign({ username: username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        
        res.json({ success: true, message: 'تم ربط حسابك بغوغل بنجاح، وهو الآن محمي!', user: updatedUser[0], token: jwtToken });

    } catch (error) {
        console.error("Internal Google Link Error:", error);
        res.status(500).json({ success: false, message: 'فشل ربط الحساب.' });
    }
});

// 🌟 4. مسار استعادة/تغيير الرمز السري عبر غوغل 🌟
app.post('/api/auth/google/reset-pin', async (req, res) => {
    const { token, newPin } = req.body;
    
    if (!newPin || newPin.length < 4) {
        return res.status(400).json({ success: false, message: 'الرمز السري يجب أن يكون 4 رموز على الأقل.' });
    }

    try {
        // التحقق من صحة توكن غوغل المرفق
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: "59332683123-kn1b91eqf87da9ld641tecnrcb0kj0jm.apps.googleusercontent.com",
        });
        const payload = ticket.getPayload();
        const googleId = payload['sub'];
        const email = payload['email'];

        // البحث عن المستخدم باستخدام إيميل غوغل أو المُعرّف
        const [users] = await pool.query('SELECT * FROM users WHERE email = ? OR google_id = ?', [email, googleId]);

        if (users.length === 0) {
            return res.status(404).json({ success: false, message: 'لا يوجد حساب قناص مرتبط بحساب غوغل هذا.' });
        }

        // تحديث الرمز السري في قاعدة البيانات
        await pool.query('UPDATE users SET pin = ? WHERE id = ?', [newPin, users[0].id]);

        // إصدار توكن الدخول وتمرير بيانات المستخدم ليدخل التطبيق فوراً بعد التغيير
        const jwtToken = jwt.sign({ username: users[0].username }, process.env.JWT_SECRET || 'sniper_secret_key_123', { expiresIn: '365d' });
        res.json({ success: true, message: 'تم تغيير الرمز السري بنجاح!', user: { username: users[0].username, email: users[0].email, tokens: users[0].tokens || 0 }, token: jwtToken });

    } catch (error) {
        console.error("Google Reset PIN Error:", error);
        res.status(500).json({ success: false, message: 'فشل التحقق من هوية حساب غوغل.' });
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

// 🌟 مسار متجر التوكن (محدث لدعم الدروع المنفصلة للبطولات - EPL أو UCL) 🌟
app.post('/api/store/purchase', authenticateToken, async (req, res) => {
    const { username, item, leagueCode, targetComp } = req.body; 

    if (req.user.username !== username) return res.status(403).json({ success: false, message: 'غير مصرح.' });

    let cost = 0;
    if (item === 'shield') cost = 70; 
    else if (item === 'sniper') cost = 120; 
    else if (item === 'tshirt') cost = 500; 
    else return res.status(400).json({ success: false, message: 'عنصر غير معروف.' });

    try {
        const [users] = await pool.query('SELECT tokens FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'حساب غير موجود.' });

        if (users[0].tokens < cost) {
            return res.status(400).json({ success: false, message: 'رصيد التوكن غير كافٍ.' });
        }

        if (item === 'shield') {
            if (!leagueCode || !targetComp) return res.status(400).json({ success: false, message: 'يجب تحديد الدوري والبطولة.' });
            
            // تحديد عمود الدرع بناءً على البطولة المختارة
            const shieldCol = targetComp === 'UCL' ? 'active_shields_ucl' : 'active_shields_epl';
            
            // خصم التوكن
            await pool.query('UPDATE users SET tokens = tokens - ? WHERE username = ?', [cost, username]);
            // إضافة الدرع السري للبطولة المحددة
            await pool.query(`UPDATE mini_league_members SET ${shieldCol} = ${shieldCol} + 1 WHERE league_code = ? AND username = ?`, [leagueCode, username]);
            
        } else if (item === 'sniper') {
            await pool.query('UPDATE users SET tokens = tokens - ?, extra_snipers = extra_snipers + 1 WHERE username = ?', [cost, username]);
        } else if (item === 'tshirt') {
            await pool.query('UPDATE users SET tokens = tokens - ? WHERE username = ?', [cost, username]);
        }

        const [updatedUsers] = await pool.query('SELECT tokens FROM users WHERE username = ?', [username]);
        res.json({ success: true, message: `تم شراء الدرع وتفعيله سرياً لبطولة (${targetComp}) بنجاح!`, newTokens: updatedUsers[0].tokens });

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

// 🌟 مسار إطلاق رصاصة القناص (محدث لدعم الدروع المنفصلة) 🌟
app.post('/api/sniper/shoot', authenticateToken, async (req, res) => {
    const { leagueCode, gw, sniper, victim, pointsDeducted, isBought } = req.body;
    if (req.user.username !== sniper) return res.status(403).json({ success: false, message: 'لا يمكنك إطلاق النار نيابة عن لاعب آخر!' });

    try {
        const [existing] = await pool.query('SELECT id FROM sniper_shots WHERE league_code = ? AND gw = ? AND sniper = ?', [leagueCode, gw, sniper]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'استخدمت رصاصتك في هذا الدوري لهذه الجولة مسبقاً!' });

        // التمييز البرمجي بين البطولتين
        const isUCL = Number(gw) >= 101;
        const shieldCol = isUCL ? 'active_shields_ucl' : 'active_shields_epl';
        const compName = isUCL ? 'أبطال أوروبا' : 'الدوري الإنجليزي';

        const [victimLeagueData] = await pool.query(`SELECT ${shieldCol} AS active_shields FROM mini_league_members WHERE league_code = ? AND username = ?`, [leagueCode, victim]);
        const [victimGlobalData] = await pool.query('SELECT shields FROM users WHERE username = ?', [victim]);
        const [sniperData] = await pool.query('SELECT extra_snipers FROM users WHERE username = ?', [sniper]);

        if (isBought && sniperData[0].extra_snipers <= 0) return res.status(400).json({ success: false, message: 'لا تملك رصاصات إضافية.' });

        let actualDeduction = pointsDeducted;
        let msg = 'تمت عملية القنص بنجاح!';

        const hasLeagueShield = victimLeagueData.length > 0 && victimLeagueData[0].active_shields > 0;
        const hasGlobalShield = victimGlobalData.length > 0 && victimGlobalData[0].shields > 0;

        if (hasLeagueShield) {
            actualDeduction = 0; 
            msg = `💥 الضربة طاشت! [${victim}] كان يمتلك درعاً حصيناً مخصصاً لـ (${compName})!`;
            
            await pool.query(`UPDATE mini_league_members SET ${shieldCol} = ${shieldCol} - 1 WHERE league_code = ? AND username = ?`, [leagueCode, victim]);
            sendFCMToUser(victim, '🛡️ ضربة طائشة!', `حاول ${sniper} قنصك في (${compName})، لكن درعك السري تصدى للرصاصة!`);
        } 
        else if (hasGlobalShield) {
            actualDeduction = 0; 
            msg = `💥 الضربة طاشت! [${victim}] تصدى للرصاصة باستخدام درع عام!`;
            
            await pool.query('UPDATE users SET shields = GREATEST(0, shields - 1) WHERE username = ?', [victim]);
            sendFCMToUser(victim, '🛡️ ضربة طائشة!', `حاول ${sniper} قنصك، لكن درعك العام القديم أنقذك!`);
        }
        else {
            sendFCMToUser(victim, '💥 تمت إصابتك!', `القناص ${sniper} قنصك وخصم من رصيدك في دوري ${leagueCode}!`);
        }

        if (isBought) await pool.query('UPDATE users SET extra_snipers = extra_snipers - 1 WHERE username = ?', [sniper]);

        await pool.query('INSERT INTO sniper_shots (league_code, gw, sniper, victim, points_deducted) VALUES (?, ?, ?, ?, ?)', [leagueCode, gw, sniper, victim, actualDeduction]);
        res.json({ success: true, message: msg });

    } catch (error) { res.status(500).json({ success: false, message: 'خطأ في السيرفر.' }); }
});

// ==========================================
// 4. لوحة الإدارة (تمت حمايتها بالكامل 🔒)
// ==========================================

// دالة مساعدة للتحقق من أن المستخدم هو الإدارة
const isAdmin = (req, res, next) => {
    if (!req.user || req.user.username.toLowerCase() !== 'red army') {
        return res.status(403).json({ success: false, message: 'غير مصرح لك! هذا الإجراء للإدارة فقط.' });
    }
    next();
};

app.post('/api/admin/match', authenticateToken, isAdmin, async (req, res) => {
    const { id, gw, home, away, date, time } = req.body;
    try {
        await pool.query('INSERT INTO matches (id, gw, home, away, date, time) VALUES (?, ?, ?, ?, ?, ?)', [id, gw, home, away, date, time]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

app.delete('/api/admin/match/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        await pool.query('DELETE FROM matches WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// 🌟 مسار حفظ النتيجة الديناميكي (مضاد لخلل البوتات ويدعم الكلاسيكو) 🌟
app.post('/api/admin/result', authenticateToken, isAdmin, async (req, res) => {
    const { matchId, actualH, actualA } = req.body;
    try {
        const [oldMatchData] = await pool.query('SELECT actual_h, actual_a, gw, home, away FROM matches WHERE id = ?', [matchId]);
        if (oldMatchData.length === 0) return res.status(404).json({success: false, message: 'المباراة غير موجودة'});
        
        const matchGw = Number(oldMatchData[0].gw);
        const homeCode = oldMatchData[0].home;
        const awayCode = oldMatchData[0].away;
        
        // جلب النتيجة القديمة (قبل تحديث البوت الجديد)
        const oldH = oldMatchData[0].actual_h !== null && oldMatchData[0].actual_h !== '' ? Number(oldMatchData[0].actual_h) : null;
        const oldA = oldMatchData[0].actual_a !== null && oldMatchData[0].actual_a !== '' ? Number(oldMatchData[0].actual_a) : null;

        // 🌟 دمج قوانين الكلاسيكو (GW 99) الذي أضفناه في الواجهة 🌟
        const isSpecialClasico = (matchGw === 99 || (homeCode === 'BAR' && awayCode === 'RMA'));
        const isEligibleForTokens = isSpecialClasico || (matchGw >= 6 && matchGw !== 101);

        // دالة مساعدة لحساب التوكن المستحق لأي نتيجة
        const getTokensEarned = (ph, pa, ah, aa, isMagnet) => {
            if (ph === null || pa === null || ah === null || aa === null) return 0;
            let isExact = (ph === ah && pa === aa);
            if (isMagnet && !isExact && (Math.abs(ph - ah) + Math.abs(pa - aa) === 1)) isExact = true; 
            
            if (isSpecialClasico) {
                const isOutcomeCorrect = (ph > pa && ah > aa) || (ph < pa && ah < aa) || (ph === pa && ah === aa);
                if (isExact) return 100;
                if (isOutcomeCorrect) return 50;
                return 0;
            } else {
                return isExact ? 10 : 0;
            }
        };

        const [predictions] = await pool.query('SELECT username, pred_h, pred_a, is_magnet FROM predictions WHERE match_id = ?', [matchId]);
        const tokenUpdates = {}; // محفظة التغيرات الذكية { 'Ahmed': +10, 'Ali': -10 }

        // 1. حساب التوكن القديم (لسحبه في حال تعديل النتيجة من قبل البوت)
        if (oldH !== null && oldA !== null && isEligibleForTokens) {
            predictions.forEach(p => {
                if (p.pred_h === '' || p.pred_h === null || p.pred_a === '' || p.pred_a === null) return;
                const earnedOld = getTokensEarned(Number(p.pred_h), Number(p.pred_a), oldH, oldA, p.is_magnet === 1 || p.is_magnet === 'true');
                if (earnedOld > 0) tokenUpdates[p.username] = (tokenUpdates[p.username] || 0) - earnedOld;
            });
        }

        // 2. حالة إلغاء النتيجة تماماً (Cancel) عبر زر الواجهة
        if (actualH === null || actualA === null || actualH === '') {
            for (const [user, net] of Object.entries(tokenUpdates)) {
                if (net < 0) await pool.query('UPDATE users SET tokens = GREATEST(0, COALESCE(tokens, 0) - ?) WHERE username = ?', [Math.abs(net), user]);
            }
            await pool.query('UPDATE matches SET actual_h = NULL, actual_a = NULL WHERE id = ?', [matchId]);
            return res.json({ success: true, message: 'تم إلغاء النتيجة وسحب التوكن المرتبط بها.' });
        }

        // 3. حالة حفظ أو تحديث النتيجة عبر البوت
        const newH = Number(actualH);
        const newA = Number(actualA);
        await pool.query('UPDATE matches SET actual_h = ?, actual_a = ? WHERE id = ?', [newH, newA, matchId]);

        // حساب التوكن الجديد للنتيجة الحالية
        if (isEligibleForTokens) {
            predictions.forEach(p => {
                if (p.pred_h === '' || p.pred_h === null || p.pred_a === '' || p.pred_a === null) return;
                const earnedNew = getTokensEarned(Number(p.pred_h), Number(p.pred_a), newH, newA, p.is_magnet === 1 || p.is_magnet === 'true');
                if (earnedNew > 0) tokenUpdates[p.username] = (tokenUpdates[p.username] || 0) + earnedNew;
            });
        }

        // 4. تطبيق التغيرات الصافية (Net Changes) في قاعدة البيانات وإرسال الإشعارات
        let notificationsSent = 0;
        for (const [user, netTokens] of Object.entries(tokenUpdates)) {
            if (netTokens > 0) {
                // 1. إضافة التوكن في قاعدة البيانات بأمان تام
                await pool.query('UPDATE users SET tokens = COALESCE(tokens, 0) + ? WHERE username = ?', [netTokens, user]);
                
                let msg = isSpecialClasico ? `توقعك للكلاسيكو كان مذهلاً! منحك ${netTokens} توكن، تفقد المتجر.` : `توقعك للمباراة كان دقيقاً. تمت إضافة ${netTokens} توكن لمحفظتك في المتجر!`;
                
                // 🌟 التعديل الحاسم: استخدام .catch لمنع انهيار الحلقة إذا فشل الإشعار (مثل لاعبي الآيفون) 🌟
                sendFCMToUser(user, '🎯 قناص محترف!', msg).catch(err => console.log(`FCM Ignored for ${user}`));
                
                notificationsSent++;
            } else if (netTokens < 0) {
                // سحب التوكن السريع ممن فقدوا النتيجة بعد تحديث البوت
                await pool.query('UPDATE users SET tokens = GREATEST(0, COALESCE(tokens, 0) - ?) WHERE username = ?', [Math.abs(netTokens), user]);
            }
        }

        // إرسال الإشعار الجماعي مع حمايته أيضاً من التسبب بانهيار السيرفر
        sendFCMToAll('⏱️ تم تثبيت النتيجة!', 'انتهت إحدى المواجهات، ادخل فوراً لترى كم نقطة وتوكن حصدت!').catch(err => console.log('Global FCM Ignored'));

        res.json({ success: true, message: `تم حفظ النتيجة! وتم محاولة إرسال ${notificationsSent} إشعار مكافأة.` });

        // إرسال الإشعار الجماعي لكل القناصين
        sendFCMToAll('⏱️ تم تثبيت النتيجة!', 'انتهت إحدى المواجهات، ادخل فوراً لترى كم نقطة وتوكن حصدت!');

        res.json({ success: true, message: `تم حفظ النتيجة! وتم إرسال ${notificationsSent} إشعار مكافأة.` });
    } catch (error) { 
        console.error("Result Save Error:", error);
        res.status(500).json({ success: false, message: 'فشل حفظ النتيجة.' }); 
    }
});

app.post('/api/admin/update-time', authenticateToken, isAdmin, async (req, res) => {
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
    if (adminPassword !== '101383') return res.status(403).json({ success: false, message: 'كلمة المرور غير صحيحة!' });

    try {
        await sendFCMToAll(title, body);
        res.json({ success: true, message: 'تم إطلاق الإشعار لجميع القناصين بنجاح 🚀' });
    } catch (error) { 
        console.error("Broadcast Error:", error.message);
        res.status(500).json({ success: false, message: 'رفض من السيرفر: ' + error.message }); 
    }
});

// 🌟 مسار إرسال إشعار مخصص للاعب محدد 🌟
app.post('/api/admin/notify-user', authenticateToken, isAdmin, async (req, res) => {
    const { targetUsername, title, body } = req.body;

    try {
        const [users] = await pool.query('SELECT username FROM users WHERE username = ?', [targetUsername]);
        if (users.length === 0) return res.status(404).json({ success: false, message: 'اللاعب غير موجود.' });

        await sendFCMToUser(users[0].username, title, body);
        res.json({ success: true, message: `تم إرسال الإشعار بنجاح إلى ${targetUsername} 🎯` });
    } catch (error) { 
        console.error("Single Notify Error:", error.message);
        res.status(500).json({ success: false, message: 'رفض من السيرفر: ' + error.message }); 
    }
});

const PORT = process.env.PORT || 5000;

// ==========================================
// 🌟 نظام المراقب الآلي للتذكير بالمباريات (النسخة المدرعة) 🌟
// ==========================================

// ذاكرة ذكية تحتفظ بمعرّف الإشعار ليوم واحد فقط لمنع التكرار، وسيتم تنظيفها تلقائياً
let notifiedDays = new Set(); 
let lastCleanupTime = Date.now();

// 1. دالة حساب الوقت المعيارية الدقيقة (تقرأ التاريخ مهما كان التنسيق)
function parseMatchDateTime(dateStr, timeStr) {
    try {
        if (!dateStr || !timeStr) return 0;
        
        let dStr = String(dateStr).trim();
        // توحيد الفواصل إلى /
        dStr = dStr.replace(/[\s\.-]+/g, '/').replace(/\/+/g, '/');
        
        let parts = dStr.match(/\d+/g);
        if (!parts || parts.length < 3) return 0;

        let d, m, y;
        // التعرف الذكي: إذا كان الجزء الأول 4 أرقام فهو سنة (YYYY/MM/DD)
        if (parts[0].length === 4) {
            y = parts[0]; m = parts[1]; d = parts[2];
        } else {
            // وإلا فهو (DD/MM/YYYY)
            d = parts[0]; m = parts[1]; y = parts[2];
            if (y.length === 2) y = '20' + y;
        }

        // معالجة الوقت
        let tStr = String(timeStr).trim().toLowerCase();
        let isPM = tStr.includes('م') || tStr.includes('pm');
        let isAM = tStr.includes('ص') || tStr.includes('am');
        
        let timeNumbers = tStr.replace(/[^\d:]/g, ''); 
        let [hours, minutes] = timeNumbers.split(':');
        hours = parseInt(hours, 10) || 0;
        minutes = parseInt(minutes, 10) || 0;
        
        if (isPM && hours !== 12) hours += 12;
        if (isAM && hours === 12) hours = 0;
        
        // بناء التاريخ بتوقيت المنطقة القياسي لتركيا وسوريا (+03:00)
        const isoString = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00+03:00`;
        return new Date(isoString).getTime();
    } catch (e) {
        console.error("Time Parse Error:", e.message);
        return 0;
    }
}

// 2. المحرك الأساسي للفحص
async function checkUpcomingMatches() {
    try {
        if (Date.now() - lastCleanupTime > 24 * 60 * 60 * 1000) {
            notifiedDays.clear();
            lastCleanupTime = Date.now();
        }

        const [matches] = await pool.query("SELECT id, gw, date, time FROM matches WHERE actual_h IS NULL OR actual_h = ''");
        if (matches.length === 0) return;

        const firstMatchesPerDay = {};

        matches.forEach(m => {
            const matchTime = parseMatchDateTime(m.date, m.time);
            if (matchTime === 0) return;

            const dDate = new Date(matchTime);
            if (isNaN(dDate.getTime())) return;
            
            // 🌟 استخدام توقيت UTC المطلق لضمان عدم تأثر السيرفر بتوقيت ألمانيا المحلي 🌟
            const cleanDate = `${dDate.getUTCFullYear()}-${dDate.getUTCMonth() + 1}-${dDate.getUTCDate()}`;
            const matchLeague = Number(m.gw) >= 101 ? 'UCL' : 'EPL';
            const dayKey = `${matchLeague}_gw${m.gw}_${cleanDate}`; 

            if (!firstMatchesPerDay[dayKey] || matchTime < firstMatchesPerDay[dayKey].time) {
                firstMatchesPerDay[dayKey] = { gw: m.gw, league: matchLeague, time: matchTime };
            }
        });

        const now = Date.now();
        
        for (const [dayKey, firstMatch] of Object.entries(firstMatchesPerDay)) {
            const timeDiffMinutes = (firstMatch.time - now) / (1000 * 60);

            // 🚀 التعديل الذهبي: توسيع نافذة الرادار لتكون بين 125 و 60 دقيقة
            if (timeDiffMinutes <= 125 && timeDiffMinutes >= 60) {
                if (!notifiedDays.has(dayKey)) {
                    notifiedDays.add(dayKey); 

                    const isUCL = firstMatch.league === 'UCL';
                    const leagueName = isUCL ? 'أبطال أوروبا' : 'الدوري الإنجليزي';
                    
                    let gwLabel = '';
                    if (isUCL) {
                        if (firstMatch.gw >= 101 && firstMatch.gw <= 108) gwLabel = `الجولة ${firstMatch.gw - 100}`;
                        else gwLabel = 'الأدوار الإقصائية';
                    } else {
                        if (firstMatch.gw === 99) gwLabel = 'الحدث الاستثنائي الكلاسيكو';
                        else gwLabel = `الجولة ${firstMatch.gw}`;
                    }
                    
                    const title = `🚨 مباريات اليوم من ${gwLabel} تقترب!`;
                    const body = `باقي ساعتين على أولى مباريات اليوم في ${leagueName}.. أي أنه متبقي "ساعة واحدة فقط" لإغلاق التوقعات! ادخل الآن ⏱️`;

                    await sendFCMToAll(title, body);
                    console.log(`[Auto-Reminder] Sent for: ${dayKey} (Mins left: ${Math.round(timeDiffMinutes)})`);
                }
            }
        }
    } catch (error) {
        console.error("[Auto-Reminder] Error:", error.message);
    }
}

// ⏱️ تشغيل المراقب كل 60 ثانية (دقيقة واحدة)
setInterval(checkUpcomingMatches, 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server running securely on port ${PORT}`);
});
