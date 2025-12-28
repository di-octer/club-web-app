const firebaseConfig = {
  apiKey: "AIzaSyD4fimqj2CE89w1qQRJG_fQGRH5GgUDf8Q",
  authDomain: "club-app-db.firebaseapp.com",
  projectId: "club-app-db",
  storageBucket: "club-app-db.firebasestorage.app",
  messagingSenderId: "993061804495",
  appId: "1:993061804495:web:9ca633885d8986d3f59aba",
  measurementId: "G-94JSQHYZR4"
};
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// --- グローバル変数 ---
let currentUser = null;
let userSettings = {}; 
let registeredCampuses = [];
let registeredGpsAreas = [];
let registeredFaces = [];
let isLoggingIn = false;
let isLateAuth = false;

window.onload = async () => {
    const path = window.location.pathname;
    const isLoginPage = path.includes('pre_login.html');
    const bodyId = document.body.id;

    // Admin画面で認証モーダルが一瞬表示されるのを防ぐ
    const authModal = document.getElementById('authModal');
    if(authModal) authModal.style.display = 'none';

    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        if (user) {
            console.log("Logged in:", user.displayName);

            // ★追加: Discord ID (Username) の取得と保存
            // Discordログインの場合、providerDataに情報が含まれます
            const discordProfile = user.providerData.find(p => p.providerId.includes('discord'));
            if (discordProfile) {
                const discordName = discordProfile.displayName; 
                if (discordName) {
                    // Firestoreに保存 (既存データを上書きしないよう merge: true)
                    db.collection('users').doc(user.uid).set({
                        discordName: discordName
                    }, { merge: true }).catch(err => console.error("Discord info save error:", err));
                }
            }

            if (isLoginPage && !isLoggingIn) window.location.href = 'pre_home.html';
            
            // ユーザー設定読み込み待機
            await loadUserSettings(user.uid);
            await checkGradePromotion(user.uid);
            updateUserDisplay(user);
            
            if (!isLoginPage) setupCommonAppbar();
        } else {
            console.log("Not logged in");
            if (!isLoginPage) window.location.href = 'pre_login.html';
        }
    });

    console.log("初期化開始: bodyId =", bodyId);

    // 共通データロード
    await loadCampuses();
    await loadGpsAreas();
    
    // ページごとの初期化振り分け
    if (bodyId === 'page-admin') {
        if(typeof initAdminPage === 'function') await initAdminPage();
    } else if (bodyId === 'page-check') {
        if(typeof checkAttendance === 'function' && currentUser) checkAttendance();
    } else if (document.getElementById('news-section')) {
        if(typeof loadHomeNews === 'function') loadHomeNews();
    } else if (bodyId === 'page-settings') {
        if(typeof initSettingsPage === 'function') initSettingsPage();
    } else if (bodyId === 'page-calendar') {
        // ★追加: ユーザーカレンダー画面用
        if(typeof initUserCalendarPage === 'function') initUserCalendarPage();
    } else if (bodyId === 'page-portfolio') {
        // ★追加: ポートフォリオ一覧画面用
        if(typeof initPortfolioList === 'function') initPortfolioList();
    } else if (bodyId === 'page-portfolio-detail') {
        // ★追加: ポートフォリオ詳細画面用
        if(typeof initPortfolioDetail === 'function') initPortfolioDetail();
    }
};

async function loadUserSettings(uid) {
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) userSettings = doc.data();
    } catch(e) { console.error("Settings load error:", e); }
}

function updateUserDisplay(user) {
    const nameEls = document.querySelectorAll('#displayUserName, #historyUserName');
    nameEls.forEach(el => el.textContent = user.displayName);
    if(document.body.id === 'page-check') checkAttendance();
}

async function checkGradePromotion(uid) {
    if(!userSettings || Object.keys(userSettings).length === 0) await loadUserSettings(uid);
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    const currentAcademicYear = (currentMonth >= 4) ? currentYear : currentYear - 1;

    let grade = userSettings.grade;
    let promotedYear = userSettings.gradePromotedYear;

    if (grade === undefined || promotedYear === undefined) {
        await db.collection('users').doc(uid).update({ grade: 1, gradePromotedYear: currentAcademicYear });
        return;
    }

    const diff = currentAcademicYear - promotedYear;
    if (diff > 0) {
        const newGrade = parseInt(grade) + diff;
        console.log(`Promoting grade: ${grade} -> ${newGrade} (+${diff} years)`);
        await db.collection('users').doc(uid).update({ grade: newGrade, gradePromotedYear: currentAcademicYear });
        userSettings.grade = newGrade;
        userSettings.gradePromotedYear = currentAcademicYear;
    }
}

function loginWithDiscord() {
    isLoggingIn = true;
    const provider = new firebase.auth.OAuthProvider('oidc.discord');
    provider.addScope('identify');
    auth.signInWithPopup(provider)
        .then(async (result) => {
            const user = result.user;
            const profile = result.additionalUserInfo ? result.additionalUserInfo.profile : {};
            const userRef = db.collection('users').doc(user.uid);
            
            try {
                const doc = await userRef.get();
                const currentData = doc.exists ? doc.data() : {};
                const today = new Date();
                const curAcadYear = (today.getMonth() + 1 >= 4) ? today.getFullYear() : today.getFullYear() - 1;

                const updateData = {
                    displayName: user.displayName, email: user.email, photoURL: user.photoURL,
                    lastLogin: firebase.firestore.FieldValue.serverTimestamp(),
                    discordId: profile.id || "", discordName: profile.username || "", discordIcon: user.photoURL || ""
                };

                if (currentData.realName === undefined) updateData.realName = user.displayName;
                if (currentData.studentId === undefined) updateData.studentId = "";
                if (currentData.isMember === undefined) updateData.isMember = false;
                if (currentData.role === undefined) updateData.role = "仮入部";
                if (currentData.grade === undefined) updateData.grade = 1;
                if (currentData.gradePromotedYear === undefined) updateData.gradePromotedYear = curAcadYear;

                const defaults = { adminMemo: "", rateActivity: 0, rateTeam: 0, rateCurriculum: 0, rateFriends: 0, groups: [], qiitaId: "", gitId: "", faceRegistered: false, isAdmin: false, borrowedItems: [] };
                for (const k in defaults) { if (currentData[k] === undefined) updateData[k] = defaults[k]; }

                await userRef.set(updateData, { merge: true });
                window.location.href = 'pre_home.html';
            } catch (e) {
                console.error("User Init Error:", e);
                window.location.href = 'pre_home.html';
            }
        })
        .catch((error) => { console.error("Login Error:", error); isLoggingIn = false; });
}

function logoutUser() {
    if(confirm("ログアウトしますか？")) {
        auth.signOut().then(() => window.location.href = 'pre_login.html');
    }
}

function setupCommonAppbar() {
    const existing = document.querySelector('header');
    if(existing) existing.remove();

    let iconUrl = "https://via.placeholder.com/36?text=U";
    if (userSettings && userSettings.customIcon) iconUrl = userSettings.customIcon;
    else if (currentUser && currentUser.photoURL) iconUrl = currentUser.photoURL;

    const style = document.createElement('style');
    style.innerHTML = `
        body { padding-top: 70px; margin: 0; }
        .appbar-fixed {
            position: fixed; top: 0; left: 0; width: 100%; height: 60px;
            background-color: #007bff; color: white;
            display: flex; justify-content: space-between; align-items: center;
            z-index: 9999; box-shadow: 0 2px 5px rgba(0,0,0,0.3);
            padding: 0 10px; box-sizing: border-box;
        }
        .appbar-side { display: flex; gap: 10px; flex: 0 0 auto; align-items: center; }
        .appbar-info-group {
            display: flex; align-items: center; justify-content: center;
            background: rgba(0, 0, 0, 0.4);
            border-radius: 6px; height: 38px; padding: 0; overflow: hidden;
            cursor: pointer; flex: 0 1 auto; 
            width: 160px; max-width: 160px; min-width: 120px;
        }
        .appbar-campus {
            font-weight: bold; padding: 0 8px; white-space: nowrap; 
            font-size: 0.8em; color: #fff; background: transparent;
            border-right: 1px solid rgba(255,255,255,0.3); flex: 0 0 auto;
        }
        .appbar-center {
            flex: 1; background: transparent; border-radius: 0; height: 100%;
            display: flex; align-items: center; color: #fff; font-size: 0.9em; 
            font-weight: bold; overflow: hidden; position: relative; padding: 0 5px;
            white-space: nowrap;
        }
        .status-static { width: 100%; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .status-marquee { display: inline-block; white-space: nowrap; padding-left: 100%; animation: marquee-anim 10s linear infinite; }
        @keyframes marquee-anim { 0% { transform: translate(0, 0); } 100% { transform: translate(-100%, 0); } }
        .icon-btn {
            font-size: 1.4em; text-decoration: none; color: white;
            display: flex; align-items: center; justify-content: center;
            width: 36px; height: 36px; border-radius: 50%; transition: background 0.2s;
            border: none; background: transparent; cursor: pointer;
        }
        .icon-btn:hover { background: rgba(255,255,255,0.2); }
        .user-icon-img { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; border: 2px solid white; }
        #statusDetailModal {
            position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
            background: white; color: #333; padding: 15px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.4); border-radius: 8px;
            z-index: 10000; display: none; width: 85%; max-width: 400px; text-align: left;
        }
        #modalOverlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 9998; display: none;
        }
    `;
    document.head.appendChild(style);

    const header = document.createElement('header');
    header.className = 'appbar-fixed';
    header.innerHTML = `
        <div class="appbar-side">
            <a href="pre_home.html" class="icon-btn" title="ホーム">🏠</a>
            <a href="pre_curriculum.html" class="icon-btn" title="カリキュラム">✏️</a>
        </div>
        <div class="appbar-info-group" onclick="toggleStatusModal()">
            <div id="appbarCampus" class="appbar-campus"></div>
            <div class="appbar-center" id="appbarStatus">
                <div class="status-static">...</div>
            </div>
        </div>
        <div class="appbar-side">
            <a href="pre_index.html" class="icon-btn" title="出席認証">👤</a>
            <a href="pre_settings.html" class="icon-btn" title="設定">
                <img src="${iconUrl}" class="user-icon-img" onerror="this.src='https://via.placeholder.com/32'">
            </a>
        </div>
    `;
    document.body.prepend(header);

    if(document.getElementById('modalOverlay')) document.getElementById('modalOverlay').remove();
    if(document.getElementById('statusDetailModal')) document.getElementById('statusDetailModal').remove();

    const overlay = document.createElement('div');
    overlay.id = 'modalOverlay';
    overlay.onclick = toggleStatusModal;
    document.body.appendChild(overlay);

    const modal = document.createElement('div');
    modal.id = 'statusDetailModal';
    modal.innerHTML = `<h4>現在の活動場所一覧</h4><div id="statusDetailContent"></div>`;
    document.body.appendChild(modal);
}

async function updateAppbarStatus() {
    const campusEl = document.getElementById('appbarCampus');
    const statusEl = document.getElementById('appbarStatus');
    if (!statusEl || !registeredCampuses) return;
    
    // ターゲットキャンパスの決定
    let targetCampus = null;
    if (userSettings && userSettings.defaultCampusId) {
        targetCampus = registeredCampuses.find(c => c.id === userSettings.defaultCampusId);
    }
    // デフォルトがない場合は位置情報から…ですが、表示の一貫性のため
    // ここでは「設定がなければリストの先頭」等のフォールバック、またはGPS待ちとします。
    // GPS取得時のコールバック内で最終決定して描画します。

    const render = async (campusName, campusId) => {
        let timeStr = "";
        
        // 時間取得ロジック
        if (campusId) {
            const now = new Date();
            const ymd = formatDate(now);
            const ym = ymd.substring(0, 7);
            const day = now.getDay();
            
            // デフォルト時間
            let start = "17:00";
            let end = "19:40";
            let isAct = false;
            let isBlocked = false;

            try {
                // 1. 例外チェック
                const exId = `${ymd}_${campusId}`;
                const exDoc = await db.collection('activity_exceptions').doc(exId).get();
                if(exDoc.exists) {
                    const d = exDoc.data();
                    start = d.start; end = d.end; isAct = true;
                } else {
                    // 2. カレンダーチェック
                    const calDoc = await db.collection('calendars').doc(ym).get();
                    if(calDoc.exists) {
                        const cData = calDoc.data();
                        isBlocked = cData.noActivityDays && cData.noActivityDays.some(n => n.date === ymd && (n.cid === campusId || !n.cid));
                        if(!isBlocked) {
                            if(cData.activityDays && cData.activityDays[campusId]) {
                                const setting = cData.activityDays[campusId].find(s => s.day === day);
                                if(setting) {
                                    isAct = true;
                                    if(setting.start) start = setting.start;
                                    if(setting.end) end = setting.end;
                                }
                            }
                        }
                    }
                }
            } catch(e) { console.error(e); }

            if (isBlocked) {
                timeStr = " [活動なし]";
            } else if (isAct) {
                timeStr = ` [${start}〜${end}]`;
            } else {
                timeStr = " [活動なし]";
            }
        }

        // 表示更新
        campusEl.textContent = `${campusName}${timeStr}`;

        // エリア情報の表示 (GPSエリア判定は既存ロジック利用)
        // ここではステータスバーのテキスト更新のみ行います
        // ※ statusEl の中身(marquee等)は GPS logic の方で更新されますが、
        //    ここでは活動場所名の部分だけ更新しました。
    };

    if (!navigator.geolocation) { 
        render(targetCampus ? targetCampus.name : "未設定", targetCampus ? targetCampus.id : null);
        statusEl.innerHTML = '<div class="status-static">GPS不可</div>';
        return; 
    }

    navigator.geolocation.getCurrentPosition((pos) => {
        const uLat = pos.coords.latitude;
        const uLon = pos.coords.longitude;
        
        // ターゲットキャンパスが未定ならGPSで決定
        if (!targetCampus) {
            let minDist = Infinity;
            registeredCampuses.forEach(c => {
                const dist = getDistance(uLat, uLon, c.lat, c.lon);
                if (dist < minDist) { minDist = dist; targetCampus = c; }
            });
        }
        
        if (targetCampus) {
            // ここで時間取得を含めてレンダリング
            render(targetCampus.name, targetCampus.id);
            
            // エリア判定
            const targetAreas = registeredGpsAreas.filter(a => a.isActive && a.campusId === targetCampus.id);
            if (targetAreas.length === 0) {
                statusEl.innerHTML = '<div class="status-static">現在地: 活動エリア外</div>';
            } else if (targetAreas.length === 1) {
                statusEl.innerHTML = `<div class="status-static">📍 ${targetAreas[0].name}</div>`;
            } else {
                const text = targetAreas.map(a => a.name).join("　");
                statusEl.innerHTML = `<div class="status-marquee">${text}　　${text}</div>`;
            }
        } else {
            render("キャンパス外", null);
            statusEl.innerHTML = '<div class="status-static">---</div>';
        }
    }, (err) => {
        render(targetCampus ? targetCampus.name : "全キャンパス", targetCampus ? targetCampus.id : null);
    }, { timeout: 5000 });
}

async function loadCampuses() {
    try {
        const snap = await db.collection('campuses').get();
        registeredCampuses = [];
        snap.forEach(doc => registeredCampuses.push({ id: doc.id, ...doc.data() }));
    } catch(e) { console.error("Campus Load Error:", e); }
}

async function loadGpsAreas() {
    try {
        const snap = await db.collection('gps_areas').get();
        registeredGpsAreas = [];
        snap.forEach(doc => registeredGpsAreas.push(doc.data()));
    } catch(e) { console.error("Area Load Error:", e); }
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2) * Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function resolveDateYear(inputStr, baseYear, isAcademic) {
    if (!inputStr) return "";
    if (inputStr.includes(':')) { const [s, e] = inputStr.split(':'); return `${resolveDateYear(s, baseYear, isAcademic)}:${resolveDateYear(e, baseYear, isAcademic)}`; }
    const parts = inputStr.split('-'); if (parts.length !== 2) return inputStr;
    const m = parseInt(parts[0]); const d = parseInt(parts[1]);
    let targetYear = baseYear; if (isAcademic && m >= 1 && m <= 3) targetYear = baseYear + 1;
    return `${targetYear}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function formatDate(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

function toBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

function toggleStatusModal() {
    const modal = document.getElementById('statusDetailModal');
    const overlay = document.getElementById('modalOverlay');
    if (!modal || !overlay) return;
    const isHidden = modal.style.display === 'none' || modal.style.display === '';
    modal.style.display = isHidden ? 'block' : 'none';
    overlay.style.display = isHidden ? 'block' : 'none';
}

// --- 顔認識モデル読み込み (共通関数) ---
async function loadModels() {
    // ★修正: アップロードされたローカルのmodelsフォルダを参照
    const MODEL_URL = '../models'; 
    
    try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        // console.log("Models loaded from local");
    } catch(e) { 
        console.error("Model Load Error:", e);
        alert("モデルの読み込みに失敗しました。\nmodelsフォルダが配置されているか確認してください。");
    }
}