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
        let cupMatches = [];
        try {
            const [cupRows] = await pool.query('SELECT * FROM cup_matches ORDER BY round_size DESC, slot ASC');
            cupMatches = cupRows;
        } catch (e) { cupMatches = []; }

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

        res.json({ success: true, data: { users, matches, predictions: formattedPreds, miniLeagues: formattedLeagues, sniperShots: shots, cupMatches } });
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

// 🌟 مسار متجر التوكن (محدث لدعم الدروع المنفصلة للبطولات وتخصيص رسائل الشراء) 🌟
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

        let successMessage = 'تمت عملية الشراء بنجاح!';

        if (item === 'shield') {
            if (!leagueCode || !targetComp) return res.status(400).json({ success: false, message: 'يجب تحديد الدوري والبطولة.' });

            const shieldCol = targetComp === 'UCL' ? 'active_shields_ucl' : 'active_shields_epl';
            const compLabel = targetComp === 'UCL' ? 'أبطال أوروبا' : 'الدوري الإنجليزي';

            await pool.query('UPDATE users SET tokens = tokens - ? WHERE username = ?', [cost, username]);
            await pool.query(`UPDATE mini_league_members SET ${shieldCol} = COALESCE(${shieldCol}, 0) + 1 WHERE league_code = ? AND username = ?`, [leagueCode, username]);
            successMessage = `تم شراء الدرع وتفعيله سرياً لبطولة (${compLabel}) بنجاح!`;

        } else if (item === 'sniper') {
            await pool.query('UPDATE users SET tokens = tokens - ?, extra_snipers = COALESCE(extra_snipers, 0) + 1 WHERE username = ?', [cost, username]);
            successMessage = 'تم شراء رصاصة قناص إضافية وإضافتها إلى مخزونك السري بنجاح!';

        } else if (item === 'tshirt') {
            await pool.query('UPDATE users SET tokens = tokens - ? WHERE username = ?', [cost, username]);
            successMessage = 'تم شراء التيشيرت بنجاح! ستتواصل معك الإدارة لتأكيد التسليم.';
        }

        const [updatedUsers] = await pool.query('SELECT tokens FROM users WHERE username = ?', [username]);
        res.json({ success: true, message: successMessage, newTokens: updatedUsers[0].tokens });

    } catch (error) {
        console.error("Store Purchase Error:", error);
        res.status(500).json({ success: false, message: 'فشل إتمام العملية بسبب خطأ في السيرفر.' });
    }
});

// 🌟 مسار سري لجلب عدد الدروع الخفية الخاصة باللاعب الحالي فقط لكل دوري 🌟
app.get('/api/my-shields', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT league_code, COALESCE(active_shields_epl, 0) AS epl, COALESCE(active_shields_ucl, 0) AS ucl FROM mini_league_members WHERE username = ?',
            [req.user.username]
        );
        const shieldsMap = {};
        rows.forEach(r => {
            shieldsMap[r.league_code] = {
                EPL: Number(r.epl) || 0,
                UCL: Number(r.ucl) || 0
            };
        });
        res.json({ success: true, shields: shieldsMap });
    } catch (error) {
        res.status(500).json({ success: false, message: 'فشل جلب بيانات الدروع.' });
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

// 🌟 مسار إطلاق رصاصة القناص (محدث لدعم الدروع التلقائية ومنع القنص المزدوج) 🌟
app.post('/api/sniper/shoot', authenticateToken, async (req, res) => {
    const { leagueCode, gw, sniper, victim, pointsDeducted, isBought } = req.body;
    if (req.user.username !== sniper) return res.status(403).json({ success: false, message: 'لا يمكنك إطلاق النار نيابة عن لاعب آخر!' });

    try {
        // 1. فحص القناص (لمنع إطلاق رصاصتين من نفس الشخص)
        const [existing] = await pool.query('SELECT id FROM sniper_shots WHERE league_code = ? AND gw = ? AND sniper = ?', [leagueCode, gw, sniper]);
        if (existing.length > 0) return res.status(400).json({ success: false, message: 'استخدمت رصاصتك في هذا الدوري لهذه الجولة مسبقاً!' });

        // 2. فحص القنص المزدوج (منع ضرب الضحية مرتين في نفس الجولة) 🛡️
        const [victimThisGw] = await pool.query('SELECT id FROM sniper_shots WHERE league_code = ? AND gw = ? AND victim = ?', [leagueCode, gw, victim]);
        if (victimThisGw.length > 0) return res.status(400).json({ success: false, message: 'تأخرت! هذا اللاعب تلقى رصاصة بالفعل في هذه الجولة، لا يمكن قنصه مرتين.' });

        // 3. فحص الدرع التلقائي (حماية الضحية فقط إذا خُصمت منه نقاط فعلياً في الجولة الماضية) 🛡️
        const prevGw = Number(gw) - 1;
        const [victimLastGw] = await pool.query('SELECT id FROM sniper_shots WHERE league_code = ? AND gw = ? AND victim = ? AND points_deducted > 0', [leagueCode, prevGw, victim]);
        if (victimLastGw.length > 0) return res.status(400).json({ success: false, message: 'طاشت الرصاصة! هذا اللاعب يمتلك درع حصانة تلقائي لأنه تعرض للقنص في الجولة الماضية.' });
        
        // التمييز البرمجي بين البطولتين للعتاد المشتراة
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
            msg = `💥 الضربة طاشت! [${victim}] كان يمتلك درعاً مشتراة مخصصاً لـ (${compName})!`;
            await pool.query(`UPDATE mini_league_members SET ${shieldCol} = ${shieldCol} - 1 WHERE league_code = ? AND username = ?`, [leagueCode, victim]);
            sendFCMToUser(victim, '🛡️ ضربة طائشة!', `حاول ${sniper} قنصك في (${compName})، لكن درعك السري تصدى للرصاصة!`).catch(() => {});
        } 
        else if (hasGlobalShield) {
            actualDeduction = 0; 
            msg = `💥 الضربة طاشت! [${victim}] تصدى للرصاصة باستخدام درع عام!`;
            await pool.query('UPDATE users SET shields = GREATEST(0, shields - 1) WHERE username = ?', [victim]);
            sendFCMToUser(victim, '🛡️ ضربة طائشة!', `حاول ${sniper} قنصك، لكن درعك العام القديم أنقذك!`).catch(() => {});
        }
        else {
            sendFCMToUser(victim, '💥 تمت إصابتك!', `القناص ${sniper} قنصك وخصم من رصيدك في دوري ${leagueCode}!`).catch(() => {});
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

// ==========================================
// 🌟 مسار حفظ النتيجة + المراقب الآلي لتوزيع التوكن 🌟
// ==========================================
const SILENT_TOKEN_MODE = false;        // 🔇 لتعويض الـ 34 مباراة بصمت الآن، ثم غيّرها إلى false بعد دقيقة
const SEND_GLOBAL_RESULT_NOTIF = false; // 📢 اجعلها false إذا كان البوت يرسل إشعاراً جماعياً بنفسه

// 1. مسار حفظ وتعديل النتيجة من لوحة الإدارة
app.post('/api/admin/result', authenticateToken, isAdmin, async (req, res) => {
    const { matchId, actualH, actualA } = req.body;
    try {
        const [oldMatchData] = await pool.query(
            'SELECT actual_h, actual_a, gw, home, away, is_token_distributed FROM matches WHERE id = ?',
            [matchId]
        );
        if (oldMatchData.length === 0) {
            return res.status(404).json({ success: false, message: 'المباراة غير موجودة' });
        }

        const m = oldMatchData[0];
        const isDistributed = Number(m.is_token_distributed) === 1;
        const isSpecialClasico = (Number(m.gw) === 99 || (m.home === 'BAR' && m.away === 'RMA'));

        // حالة الإلغاء وتصفير النتيجة
        if (actualH === null || actualA === null || String(actualH).trim() === '' || String(actualA).trim() === '') {
            if (isDistributed) {
                const [predictions] = await pool.query(
                    'SELECT username, pred_h, pred_a, is_magnet FROM predictions WHERE match_id = ?',
                    [matchId]
                );
                for (const p of predictions) {
                    const earned = calculateTokensForPrediction(p.pred_h, p.pred_a, m.actual_h, m.actual_a, p.is_magnet, isSpecialClasico);
                    if (earned > 0) {
                        await pool.query(
                            'UPDATE users SET tokens = GREATEST(0, COALESCE(tokens, 0) - ?) WHERE username = ?',
                            [earned, p.username]
                        );
                    }
                }
            }
            await pool.query('UPDATE matches SET actual_h = NULL, actual_a = NULL, is_token_distributed = 0 WHERE id = ?', [matchId]);
            return res.json({ success: true, message: 'تم إلغاء النتيجة وسحب التوكن بنجاح.' });
        }

        // حالة التثبيت اليدوي
        await pool.query('UPDATE matches SET actual_h = ?, actual_a = ? WHERE id = ?', [Number(actualH), Number(actualA), matchId]);
        const result = await distributeTokensForMatch(matchId);

        if (result.distributed) {
            res.json({ success: true, message: `تم التثبيت وتوزيع التوكن بنجاح لـ ${result.count} لاعب!` });
        } else {
            res.json({ success: true, message: 'تم تحديث النتيجة (التوكن موزع مسبقاً لهذه المباراة).' });
        }
    } catch (error) {
        console.error('Result Save Error:', error);
        res.status(500).json({ success: false, message: 'فشل حفظ النتيجة.' });
    }
});

// 2. دالة حساب التوكن (تدعم الصفر والمغناطيس والكلاسيكو بدون مضاعفة الكابتن/الجوكر)
function calculateTokensForPrediction(ph, pa, ah, aa, isMagnetStr, isSpecialClasico) {
    if (ph === null || pa === null || ah === null || aa === null) return 0;
    if (String(ph).trim() === '' || String(pa).trim() === '' || String(ah).trim() === '' || String(aa).trim() === '') return 0;

    const numPh = Number(ph), numPa = Number(pa), numAh = Number(ah), numAa = Number(aa);
    if (isNaN(numPh) || isNaN(numPa) || isNaN(numAh) || isNaN(numAa)) return 0;

    const isMagnet = (isMagnetStr === 1 || isMagnetStr === '1' || String(isMagnetStr).toLowerCase() === 'true');
    let isExact = (numPh === numAh && numPa === numAa);

    if (isMagnet && !isExact && (Math.abs(numPh - numAh) + Math.abs(numPa - numAa) === 1)) {
        isExact = true;
    }

    if (isSpecialClasico) {
        const isOutcomeCorrect = (numPh > numPa && numAh > numAa) || (numPh < numPa && numAh < numAa) || (numPh === numPa && numAh === numAa);
        if (isExact) return 100;
        if (isOutcomeCorrect) return 50;
        return 0;
    }
    return isExact ? 10 : 0;
}

// 3. دالة التوزيع المحمية بقفل ذري لمنع التكرار
async function distributeTokensForMatch(matchId) {
    const [lockResult] = await pool.query(
        `UPDATE matches 
         SET is_token_distributed = 1 
         WHERE id = ? 
           AND actual_h IS NOT NULL AND actual_a IS NOT NULL 
           AND TRIM(CAST(actual_h AS CHAR)) != '' 
           AND TRIM(CAST(actual_a AS CHAR)) != '' 
           AND COALESCE(is_token_distributed, 0) = 0`,
        [matchId]
    );

    if (lockResult.affectedRows === 0) {
        return { distributed: false, count: 0 };
    }

    const [matchRows] = await pool.query('SELECT gw, home, away, actual_h, actual_a FROM matches WHERE id = ?', [matchId]);
    if (matchRows.length === 0) return { distributed: false, count: 0 };

    const m = matchRows[0];
    const isSpecialClasico = (Number(m.gw) === 99 || (m.home === 'BAR' && m.away === 'RMA'));
    const [predictions] = await pool.query('SELECT username, pred_h, pred_a, is_magnet FROM predictions WHERE match_id = ?', [matchId]);

    let winnersCount = 0;
    for (const p of predictions) {
        const earned = calculateTokensForPrediction(p.pred_h, p.pred_a, m.actual_h, m.actual_a, p.is_magnet, isSpecialClasico);
        if (earned > 0) {
            await pool.query('UPDATE users SET tokens = COALESCE(tokens, 0) + ? WHERE username = ?', [earned, p.username]);
            if (!SILENT_TOKEN_MODE) {
                const msg = isSpecialClasico
                    ? `توقعك للكلاسيكو مذهل! كسبت ${earned} توكن.`
                    : `توقع دقيق! تمت إضافة ${earned} توكن لمحفظتك.`;
                sendFCMToUser(p.username, '🎯 قناص محترف!', msg).catch(() => {});
            }
            winnersCount++;
        }
    }

    if (!SILENT_TOKEN_MODE && SEND_GLOBAL_RESULT_NOTIF) {
        sendFCMToAll('⏱️ تم تثبيت النتيجة!', 'انتهت إحدى المواجهات، ادخل لترى رصيدك!').catch(() => {});
    }

    console.log(`[Token-Distributor] Match ${matchId} (${m.home} ${m.actual_h}-${m.actual_a} ${m.away}) -> Distributed to ${winnersCount} players (Silent: ${SILENT_TOKEN_MODE})`);
    return { distributed: true, count: winnersCount };
}

// 4. المراقب الآلي لالتقاط النتائج التي يثبتها البوت مباشرة في MySQL
let isCheckingTokens = false;
async function checkPendingTokenDistributions() {
    if (isCheckingTokens) return;
    isCheckingTokens = true;
    try {
        const [pendingMatches] = await pool.query(
            `SELECT id FROM matches 
             WHERE actual_h IS NOT NULL AND actual_a IS NOT NULL 
               AND TRIM(CAST(actual_h AS CHAR)) != '' 
               AND TRIM(CAST(actual_a AS CHAR)) != '' 
               AND COALESCE(is_token_distributed, 0) = 0`
        );

        for (const m of pendingMatches) {
            await distributeTokensForMatch(m.id);
        }
    } catch (error) {
        console.error('[Token-Distributor] Error:', error.message);
    } finally {
        isCheckingTokens = false;
    }
}

// تشغيل الفحص بعد 5 ثوانٍ من بدء السيرفر ثم كل 60 ثانية تلقائياً
setTimeout(checkPendingTokenDistributions, 5000);
setInterval(checkPendingTokenDistributions, 60 * 1000);

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
// 🌟 نظام الملف الشخصي السري (السوشال ميديا) 🌟
// ==========================================

// 1. مسار لجلب اللاعب لروابطه الخاصة فقط
app.get('/api/profile/social', authenticateToken, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT fb_link, ig_link FROM users WHERE username = ?', [req.user.username]);
        if (rows.length > 0) res.json({ success: true, data: rows[0] });
        else res.json({ success: false });
    } catch (error) { res.status(500).json({ success: false }); }
});

// 2. مسار لحفظ أو تحديث الروابط من قبل اللاعب
app.post('/api/profile/social', authenticateToken, async (req, res) => {
    const { fb, ig } = req.body;
    try {
        await pool.query('UPDATE users SET fb_link = ?, ig_link = ? WHERE username = ?', 
        [fb || '', ig || '', req.user.username]);
        res.json({ success: true, message: 'تم حفظ بيانات ملفك الشخصي بنجاح!' });
    } catch (error) { res.status(500).json({ success: false, message: 'فشل الحفظ.' }); }
});

// 3. مسار خاص بالإدارة فقط (للبحث عن روابط أي لاعب)
app.post('/api/admin/get-social', authenticateToken, isAdmin, async (req, res) => {
    const { targetUsername } = req.body;
    try {
        const [rows] = await pool.query('SELECT fb_link, ig_link FROM users WHERE username = ?', [targetUsername]);
        if (rows.length > 0) res.json({ success: true, data: rows[0] });
        else res.json({ success: false, message: 'القناص غير موجود في السجلات.' });
    } catch (error) { res.status(500).json({ success: false, message: 'خطأ في السيرفر.' }); }
});

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

// ==========================================
// 🏆 محرك كأس الدوري الإنجليزي (64 لاعباً - أتمتة كاملة) 🏆
// ==========================================
const CUP_BIG_TEAMS = ['ARS', 'MCI', 'LIV', 'MUN', 'CHE', 'TOT'];
const ENABLE_CUP_NOTIFICATIONS = false; // غيّرها إلى true عند النشر الرسمي
const toBoolFlag = v => v === 1 || v === '1' || v === true || String(v).toLowerCase() === 'true';

function calcEplPointsServer(homeCode, awayCode, predH, predA, actualH, actualA, isCaptain, isTripleCaptain, isMagnet) {
    if (homeCode === 'BAR' && awayCode === 'RMA') return 0;
    if (predH === '' || predA === '' || predH === null || predA === null || predH === undefined || predA === undefined) return 0;
    if (actualH === '' || actualA === '' || actualH === null || actualA === null || actualH === undefined || actualA === undefined) return 0;

    const ph = Number(predH), pa = Number(predA), ah = Number(actualH), aa = Number(actualA);
    if (isNaN(ph) || isNaN(pa) || isNaN(ah) || isNaN(aa)) return 0;

    let isExact = (ph === ah && pa === aa);
    if (isMagnet && !isExact && (Math.abs(ph - ah) + Math.abs(pa - aa) === 1)) isExact = true;

    let isOutcomeCorrect = (ph > pa && ah > aa) || (ph < pa && ah < aa) || (ph === pa && ah === aa);
    if (isMagnet && isExact) isOutcomeCorrect = true;
    if (!isOutcomeCorrect && !isExact) return 0;

    const isDraw = (ah === aa);
    const homeIsBig = CUP_BIG_TEAMS.includes(homeCode), awayIsBig = CUP_BIG_TEAMS.includes(awayCode);
    const totalGoals = ah + aa;
    let pts = 0;

    if (!homeIsBig && !awayIsBig) {
        if (isExact) pts = (totalGoals >= 5 || (ah === 0 && aa === 0)) ? 5 : 3;
        else if (isOutcomeCorrect) pts = 1;
    } else if (homeIsBig && awayIsBig) {
        if (isDraw) pts = isExact ? 3 : 2;
        else pts = isExact ? 5 : 3;
    } else {
        const bigWon = (homeIsBig && ah > aa) || (awayIsBig && aa > ah);
        const bigLost = (homeIsBig && ah < aa) || (awayIsBig && aa < ah);
        if (isDraw) pts = isExact ? 4 : 3;
        else if (bigWon) pts = isExact ? 3 : 1;
        else if (bigLost) pts = isExact ? 6 : 4;
    }

    if (isTripleCaptain) return pts * 3;
    if (isCaptain) return pts * 2;
    return pts;
}

async function computeEplStatsForCup() {
    const [users] = await pool.query('SELECT id, username FROM users');
    const [matches] = await pool.query('SELECT id, gw, home, away, date, time, actual_h, actual_a FROM matches WHERE gw BETWEEN 1 AND 38');
    const [preds] = await pool.query('SELECT username, match_id, pred_h, pred_a, is_captain, is_triple_captain, is_magnet FROM predictions');

    const predsMap = {};
    preds.forEach(p => {
        if (!predsMap[p.username]) predsMap[p.username] = {};
        predsMap[p.username][p.match_id] = p;
    });

    const matchesByGw = {};
    matches.forEach(m => {
        const g = Number(m.gw);
        if (!matchesByGw[g]) matchesByGw[g] = [];
        matchesByGw[g].push(m);
    });
    Object.keys(matchesByGw).forEach(g => {
        matchesByGw[g].sort((a, b) => parseMatchDateTime(a.date, a.time) - parseMatchDateTime(b.date, b.time));
    });

    const userStats = {};
    users.forEach(u => {
        userStats[u.username] = { id: u.id, username: u.username, overallPts: 0, byGw: {} };
    });

    const isPlayed = m => m.actual_h !== null && m.actual_a !== null && String(m.actual_h).trim() !== '' && String(m.actual_a).trim() !== '';

    const gwCompletion = {};
    Object.entries(matchesByGw).forEach(([gwStr, gwMatches]) => {
        const gw = Number(gwStr);
        const playedCount = gwMatches.filter(isPlayed).length;
        gwCompletion[gw] = { total: gwMatches.length, played: playedCount, isComplete: gwMatches.length > 0 && playedCount === gwMatches.length };

        const lastMatchId = gwMatches.length > 0 ? gwMatches[gwMatches.length - 1].id : null;
        const autoMagId = gw >= 6 && gwMatches.length > 0 ? (gwMatches.length > 1 ? gwMatches[gwMatches.length - 2].id : gwMatches[0].id) : null;

        users.forEach(u => {
            const uPreds = predsMap[u.username] || {};
            const hasExplicitCap = gwMatches.some(m => uPreds[m.id] && toBoolFlag(uPreds[m.id].is_captain));
            const hasExplicitMag = gw >= 6 && gwMatches.some(m => uPreds[m.id] && toBoolFlag(uPreds[m.id].is_magnet));

            let pts = 0, exacts = 0, correctOutcomes = 0, participated = false;
            gwMatches.forEach(m => {
                const p = uPreds[m.id];
                if (!p || p.pred_h === null || p.pred_a === null || String(p.pred_h).trim() === '' || String(p.pred_a).trim() === '') return;
                participated = true;
                if (!isPlayed(m)) return;

                const isCap = toBoolFlag(p.is_captain) || (!hasExplicitCap && m.id === lastMatchId);
                const isTC = toBoolFlag(p.is_triple_captain);
                const isMag = toBoolFlag(p.is_magnet) || (gw >= 6 && !hasExplicitMag && m.id === autoMagId);

                const mPts = calcEplPointsServer(m.home, m.away, p.pred_h, p.pred_a, m.actual_h, m.actual_a, isCap, isTC, isMag);
                pts += mPts;

                const ph = Number(p.pred_h), pa = Number(p.pred_a), ah = Number(m.actual_h), aa = Number(m.actual_a);
                if (ph === ah && pa === aa) exacts++;
                if ((ph > pa && ah > aa) || (ph < pa && ah < aa) || (ph === pa && ah === aa)) correctOutcomes++;
            });

            userStats[u.username].overallPts += pts;
            userStats[u.username].byGw[gw] = { pts, exacts, correctOutcomes, participated };
        });
    });

    return { userStats, gwCompletion };
}

function decideCupWinner(p1Name, p2Name, gw, userStats) {
    const s1 = userStats[p1Name] || { id: 999999, overallPts: 0, byGw: {} };
    const s2 = userStats[p2Name] || { id: 999999, overallPts: 0, byGw: {} };
    const g1 = s1.byGw[gw] || { pts: 0, exacts: 0, correctOutcomes: 0 };
    const g2 = s2.byGw[gw] || { pts: 0, exacts: 0, correctOutcomes: 0 };

    if (g1.pts !== g2.pts) return { winner: g1.pts > g2.pts ? p1Name : p2Name, loser: g1.pts > g2.pts ? p2Name : p1Name, note: null };
    if (g1.exacts !== g2.exacts) return { winner: g1.exacts > g2.exacts ? p1Name : p2Name, loser: g1.exacts > g2.exacts ? p2Name : p1Name, note: 'بأفضلية التطابق التام' };
    if (g1.correctOutcomes !== g2.correctOutcomes) return { winner: g1.correctOutcomes > g2.correctOutcomes ? p1Name : p2Name, loser: g1.correctOutcomes > g2.correctOutcomes ? p2Name : p1Name, note: 'بأفضلية التوقعات الصحيحة' };
    if (s1.overallPts !== s2.overallPts) return { winner: s1.overallPts > s2.overallPts ? p1Name : p2Name, loser: s1.overallPts > s2.overallPts ? p2Name : p1Name, note: 'بأفضلية الترتيب العام' };
    return { winner: s1.id <= s2.id ? p1Name : p2Name, loser: s1.id <= s2.id ? p2Name : p1Name, note: 'بأفضلية الأقدمية' };
}

async function advanceCupWinner(cupId, roundSize, slot, winnerName) {
    if (roundSize <= 2) return;
    const nextRound = roundSize / 2;
    const nextSlot = Math.ceil(slot / 2);
    const col = (slot % 2 === 1) ? 'player1' : 'player2';
    await pool.query(
        `UPDATE cup_matches SET ${col} = ? WHERE cup_id = ? AND round_size = ? AND slot = ?`,
        [winnerName, cupId, nextRound, nextSlot]
    );
}

let isSyncingCup = false;
async function syncCupProgress(sendNotifs = true) {
    if (isSyncingCup) return { updated: 0, finalized: 0 };
    isSyncingCup = true;
    let updated = 0, finalized = 0;

    try {
        const [activeMatches] = await pool.query(
            "SELECT * FROM cup_matches WHERE status != 'finished' ORDER BY round_size DESC, slot ASC"
        );
        if (activeMatches.length === 0) return { updated: 0, finalized: 0 };

        const { userStats, gwCompletion } = await computeEplStatsForCup();
        const roundNames = { 64: 'دور الـ 32', 32: 'دور الـ 16', 16: 'ربع النهائي', 8: 'نصف النهائي', 4: 'النهائي 🏆' };

        for (const m of activeMatches) {
            if (!m.player1 || !m.player2) continue;

            // معالجة التأهل المباشر (BYE)
            if (m.player1 === 'BYE' || m.player2 === 'BYE') {
                const realPlayer = m.player1 === 'BYE' ? m.player2 : m.player1;
                await pool.query("UPDATE cup_matches SET winner = ?, tiebreak_note = 'تأهل مباشر', status = 'finished' WHERE id = ?", [realPlayer, m.id]);
                await advanceCupWinner(m.cup_id, m.round_size, m.slot, realPlayer);
                finalized++;
                continue;
            }

            const gwInfo = gwCompletion[m.gw];
            if (!gwInfo || gwInfo.played === 0) continue;

            const s1 = (userStats[m.player1]?.byGw[m.gw]?.pts) || 0;
            const s2 = (userStats[m.player2]?.byGw[m.gw]?.pts) || 0;

            if (!gwInfo.isComplete) {
                if (m.score1 !== s1 || m.score2 !== s2 || m.status !== 'live') {
                    await pool.query("UPDATE cup_matches SET score1 = ?, score2 = ?, status = 'live' WHERE id = ?", [s1, s2, m.id]);
                    updated++;
                }
            } else {
                const result = decideCupWinner(m.player1, m.player2, m.gw, userStats);
                const [lock] = await pool.query(
                    "UPDATE cup_matches SET score1 = ?, score2 = ?, winner = ?, tiebreak_note = ?, status = 'finished' WHERE id = ? AND status != 'finished'",
                    [s1, s2, result.winner, result.note, m.id]
                );
                if (lock.affectedRows > 0) {
                    await advanceCupWinner(m.cup_id, m.round_size, m.slot, result.winner);
                    finalized++;

                    if (sendNotifs && ENABLE_CUP_NOTIFICATIONS) {
                        if (m.round_size === 2) {
                            sendFCMToAll('🏆 بطل كأس الدوري الإنجليزي!', `تُوج القناص [${result.winner}] بطلاً لكأس Goal Sniper بعد تفوقه على [${result.loser}]!`).catch(() => {});
                        } else {
                            const nextLabel = roundNames[m.round_size] || 'الدور القادم';
                            const noteTxt = result.note ? ` (${result.note})` : '';
                            sendFCMToUser(result.winner, '🎉 تأهلت في الكأس!', `تفوقت على ${result.loser}${noteTxt} وتأهلت إلى ${nextLabel}!`).catch(() => {});
                            sendFCMToUser(result.loser, '💔 وداع مشرّف للكأس', `انتهى مشوارك في الكأس أمام ${result.winner}${noteTxt}. حظاً أوفر في البطولات القادمة!`).catch(() => {});
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('[Cup-Sync] Error:', error.message);
    } finally {
        isSyncingCup = false;
    }
    return { updated, finalized };
}

// فحص وتحديث نقاط الكأس تلقائياً كل 60 ثانية
setInterval(() => syncCupProgress(true), 60 * 1000);

// 1. مسار سحب قرعة الكأس (أول 64 لاعباً من جولة التصفيات)
app.post('/api/admin/cup/draw', authenticateToken, isAdmin, async (req, res) => {
    const qualifierGw = Number(req.body.qualifierGw || 13);
    const startGw = Number(req.body.startGw || 14);
    const cupId = req.body.cupId || 'epl_cup_1';

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cup_matches (
                id INT AUTO_INCREMENT PRIMARY KEY,
                cup_id VARCHAR(50) NOT NULL DEFAULT 'epl_cup_1',
                round_size INT NOT NULL,
                gw INT NOT NULL,
                slot INT NOT NULL,
                player1 VARCHAR(100) DEFAULT NULL,
                player2 VARCHAR(100) DEFAULT NULL,
                score1 INT DEFAULT NULL,
                score2 INT DEFAULT NULL,
                winner VARCHAR(100) DEFAULT NULL,
                tiebreak_note VARCHAR(100) DEFAULT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                UNIQUE KEY uniq_cup_slot (cup_id, round_size, slot)
            )
        `);

        const [existing] = await pool.query('SELECT id FROM cup_matches WHERE cup_id = ? LIMIT 1', [cupId]);
        if (existing.length > 0) {
            return res.status(400).json({ success: false, message: 'القرعة موجودة مسبقاً! احذفها أولاً إذا أردت إعادة السحب.' });
        }

        const { userStats, gwCompletion } = await computeEplStatsForCup();
        if (!gwCompletion[qualifierGw] || !gwCompletion[qualifierGw].isComplete) {
            return res.status(400).json({ success: false, message: `لا يمكن إجراء القرعة قبل اكتمال جميع مباريات الجولة ${qualifierGw} رسمياً.` });
        }

        const ranked = Object.values(userStats)
            .filter(u => u.byGw[qualifierGw] && u.byGw[qualifierGw].participated)
            .sort((a, b) => {
                const ga = a.byGw[qualifierGw], gb = b.byGw[qualifierGw];
                if (gb.pts !== ga.pts) return gb.pts - ga.pts;
                if (gb.exacts !== ga.exacts) return gb.exacts - ga.exacts;
                if (gb.correctOutcomes !== ga.correctOutcomes) return gb.correctOutcomes - ga.correctOutcomes;
                if (b.overallPts !== a.overallPts) return b.overallPts - a.overallPts;
                return a.id - b.id;
            })
            .slice(0, 64)
            .map(u => u.username);

        if (ranked.length < 2) {
            return res.status(400).json({ success: false, message: 'لا يوجد عدد كافٍ من اللاعبين المشاركين في هذه الجولة.' });
        }

        // خلط عشوائي (Fisher-Yates)
        for (let i = ranked.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ranked[i], ranked[j]] = [ranked[j], ranked[i]];
        }

        // تجهيز 32 مواجهة مع حماية ضد BYE vs BYE إن قل العدد عن 64
        const pairings = [];
        const byesCount = Math.max(0, 64 - ranked.length);
        let idx = 0;
        for (let b = 0; b < byesCount && idx < ranked.length; b++) {
            pairings.push([ranked[idx++], 'BYE']);
        }
        while (idx < ranked.length) {
            const p1 = ranked[idx++];
            const p2 = idx < ranked.length ? ranked[idx++] : 'BYE';
            pairings.push([p1, p2]);
        }
        while (pairings.length < 32) {
            pairings.push(['BYE', 'BYE']);
        }
        for (let i = pairings.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pairings[i], pairings[j]] = [pairings[j], pairings[i]];
        }

        // بناء الشجرة الكاملة (64 -> 32 -> 16 -> 8 -> 4 -> 2)
        const rounds = [64, 32, 16, 8, 4, 2];
        for (let rIdx = 0; rIdx < rounds.length; rIdx++) {
            const rSize = rounds[rIdx];
            const rGw = startGw + rIdx;
            const slotsCount = rSize / 2;

            for (let slot = 1; slot <= slotsCount; slot++) {
                const p1 = rSize === 64 ? pairings[slot - 1][0] : null;
                const p2 = rSize === 64 ? pairings[slot - 1][1] : null;
                await pool.query(
                    'INSERT INTO cup_matches (cup_id, round_size, gw, slot, player1, player2, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [cupId, rSize, rGw, slot, p1, p2, 'pending']
                );
            }
        }

        await syncCupProgress(false);
        if (ENABLE_CUP_NOTIFICATIONS) {
            sendFCMToAll('🏆 انطلاق كأس الدوري الإنجليزي!', `تم سحب قرعة أفضل ${ranked.length} قناصاً! ادخل الآن لمعرفة خصمك في دور الـ 64 (الجولة ${startGw}).`).catch(() => {});
        }

        res.json({ success: true, message: `تم سحب قرعة الكأس بنجاح لـ ${ranked.length} لاعباً وبناء الشجرة حتى النهائي!` });
    } catch (error) {
        console.error('Cup Draw Error:', error);
        res.status(500).json({ success: false, message: 'فشل إجراء القرعة: ' + error.message });
    }
});

// 2. مسار تحديث نتائج الكأس يدوياً
app.post('/api/admin/cup/sync', authenticateToken, isAdmin, async (req, res) => {
    const result = await syncCupProgress(true);
    res.json({ success: true, message: `تم التحديث! (تحديث مباشر: ${result.updated} | حسم وتأهيل: ${result.finalized})` });
});

// 3. مسار إعادة ضبط الكأس
app.post('/api/admin/cup/reset', authenticateToken, isAdmin, async (req, res) => {
    const cupId = req.body.cupId || 'epl_cup_1';
    try {
        await pool.query('DELETE FROM cup_matches WHERE cup_id = ?', [cupId]);
        res.json({ success: true, message: 'تم مسح بيانات الكأس بنجاح، يمكنك إعادة القرعة الآن.' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'فشل حذف الكأس.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running securely on port ${PORT}`);
});
