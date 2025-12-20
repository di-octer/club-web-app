// @ts-nocheck
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
let currentStream = null;

let isAuthCompleted = false; 
let isDetectingLoop = false;
let myRequestId = null;
let adminGuideLoopId = null;
let adminAuthStep = 0; 
let currentAuthUser = null;
let colorMatchCounter = 0;
let regStream = null;
let regStep = 0; 
let regDescriptors = [];
let regThumbnail = ""; 
let currentDetection = null;
let faceStableCount = 0;
let lastDetectedDesc = null;
let missedFrameCount = 0;
let checkDisplayDate = new Date();
let checkHistoryDates = [];
let checkReportRanges = [];
let currentNewsSlide = 0;
let touchStartX = 0;
let touchEndX = 0;

const REG_INSTRUCTIONS = ["", "正面を向いてください", "顔を【左】に向けてください", "顔を【右】に向けてください", "顔を【上】に向けてください", "顔を【下】に向けてください"];

// --- 初期化 ---
window.onload = async () => {
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        const path = window.location.pathname;
        const isLoginPage = path.includes('pre_login.html');

        if (user) {
            console.log("Logged in as:", user.displayName);
            if (isLoginPage) window.location.href = 'pre_home.html';
            await loadUserSettings(user.uid);
            updateUserDisplay(user);
        } else {
            console.log("Not logged in");
            if (!isLoginPage) window.location.href = 'pre_login.html';
        }
    });

    console.log("初期化開始: bodyId =", document.body.id);
    
    // 共通データ読み込み
    await loadCampuses();
    await loadGpsAreas();
    
    if(currentUser) await loadUserSettings(currentUser.uid);
    setupCommonAppbar();
    updateAppbarStatus();
    
    const bodyId = document.body.id;
    if (bodyId === 'page-admin') {
        await loadModels();
        await loadRegisteredFaces();
        await loadAdminRecommendedArticles();
        switchAdminSubTab('auth');
        populateInfoLists();
    } else if (bodyId === 'page-check') {
        if(currentUser) checkAttendance();
    } else if (document.getElementById('news-section')) {
        loadHomeNews();
    } else if (bodyId === 'page-settings') {
        initSettingsPage();
    }
};

// --- ユーザー設定 ---
async function loadUserSettings(uid) {
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) userSettings = doc.data();
        setupCommonAppbar(); 
    } catch(e) { console.error("Settings load error:", e); }
}

function updateUserDisplay(user) {
    const nameEls = document.querySelectorAll('#displayUserName, #historyUserName');
    nameEls.forEach(el => el.textContent = user.displayName);
    if(document.body.id === 'page-check') checkAttendance();
}

// ==========================================
//   共通UI (AppBar)
// ==========================================
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

// ==========================================
//   設定ページ機能 (Settings)
// ==========================================

async function initSettingsPage() {
    if (!currentUser) return;

    const s = userSettings || {};
    
    document.getElementById('setAuthMethod').value = s.authMethod || "";
    document.getElementById('setNewsOrder').value = s.newsOrder || "newest";
    document.getElementById('setNewsDefaultTab').value = s.newsDefaultTab || "trend";
    document.getElementById('setNewsDefaultCount').value = s.newsDefaultCount || 5;
    document.getElementById('setNewsMaxCount').value = s.newsMaxCount || 20;

    const currentIcon = s.customIcon || currentUser.photoURL;
    document.getElementById('previewIcon').src = currentIcon || "https://via.placeholder.com/50";

    document.getElementById('manualInterests').value = (s.manualInterests || []).join(', ');
    document.getElementById('manualTechStack').value = (s.manualTechStack || []).join(', ');
    document.getElementById('profileText').value = s.profileText || "";

    renderAutoTags('autoInterestsList', s.autoInterests || []);
    renderAutoTags('autoTechList', s.autoTechStack || []);

    const campSelect = document.getElementById('setDefaultCampus');
    registeredCampuses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id; opt.innerText = c.name;
        campSelect.appendChild(opt);
    });
    campSelect.value = s.defaultCampusId || "";

    loadApprovedRecurring();
}

function renderAutoTags(containerId, tags) {
    const container = document.getElementById(containerId);
    container.innerHTML = "";
    if (!tags || tags.length === 0) {
        container.innerHTML = '<span style="color:#999; font-size:0.8em;">データなし</span>';
        return;
    }
    tags.forEach(tag => {
        const span = document.createElement('span');
        span.className = 'tag-badge';
        span.style.cssText = "display:inline-block; background:#e0e0e0; border-radius:12px; padding:2px 8px; margin:2px; font-size:0.8em;";
        span.innerHTML = `${tag} <span onclick="removeAutoTag('${containerId}', '${tag}')" style="cursor:pointer; color:#888; margin-left:5px;">×</span>`;
        container.appendChild(span);
    });
}

async function removeAutoTag(type, tag) {
    if(!confirm(`「${tag}」を削除しますか？\n(今後半年間は自動追加されません)`)) return;
    
    const field = (type === 'autoInterestsList') ? 'autoInterests' : 'autoTechStack';
    const hiddenField = (type === 'autoInterestsList') ? 'hiddenInterests' : 'hiddenTechStack';

    const currentList = userSettings[field] || [];
    const newList = currentList.filter(t => t !== tag);
    
    const until = new Date();
    until.setMonth(until.getMonth() + 6);

    const hiddenItem = { tag: tag, until: firebase.firestore.Timestamp.fromDate(until) };

    try {
        await db.collection('users').doc(currentUser.uid).update({
            [field]: newList,
            [hiddenField]: firebase.firestore.FieldValue.arrayUnion(hiddenItem)
        });
        await loadUserSettings(currentUser.uid);
        renderAutoTags(type, newList);
    } catch(e) { alert("更新エラー: " + e.message); }
}

async function resetToDiscordIcon() {
    document.getElementById('previewIcon').src = currentUser.photoURL;
    document.getElementById('iconUploader').value = ""; 
}

async function saveSettings() {
    if (!currentUser) return;
    const uid = currentUser.uid;

    const authMethod = document.getElementById('setAuthMethod').value;
    const newsOrder = document.getElementById('setNewsOrder').value;
    const newsDefaultTab = document.getElementById('setNewsDefaultTab').value;
    const newsDefaultCount = parseInt(document.getElementById('setNewsDefaultCount').value);
    const newsMaxCount = parseInt(document.getElementById('setNewsMaxCount').value);

    const iconInput = document.getElementById('iconUploader');
    let customIcon = userSettings.customIcon || null;
    
    if (iconInput.files && iconInput.files[0]) {
        customIcon = await toBase64(iconInput.files[0]);
    } else if (document.getElementById('previewIcon').src === currentUser.photoURL) {
        customIcon = null; 
    }

    const manualInterests = document.getElementById('manualInterests').value.split(',').map(s => s.trim()).filter(s=>s);
    const manualTechStack = document.getElementById('manualTechStack').value.split(',').map(s => s.trim()).filter(s=>s);
    const profileText = document.getElementById('profileText').value;
    const defaultCampusId = document.getElementById('setDefaultCampus').value;
    const language = document.getElementById('setLanguage').value;

    try {
        await db.collection('users').doc(uid).set({
            authMethod, newsOrder, newsDefaultTab, newsDefaultCount, newsMaxCount,
            customIcon, manualInterests, manualTechStack, profileText, defaultCampusId, language,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        alert("設定を保存しました");
        location.reload(); 
    } catch(e) { alert("保存エラー: " + e.message); }
}

async function submitRecurringAbsence() {
    const semester = document.getElementById('recurringSemester').value;
    const fileInput = document.getElementById('recurringImage');
    
    if (!fileInput.files[0]) return alert("画像を選択してください");
    
    const imageBase64 = await toBase64(fileInput.files[0]);
    
    try {
        await db.collection('recurring_absence_applications').add({
            userId: currentUser.uid,
            userName: currentUser.displayName,
            semester: semester,
            image: imageBase64,
            status: 'pending',
            data: null, 
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert("提出しました。管理者の承認をお待ちください。");
        fileInput.value = "";
    } catch(e) { alert("送信エラー: " + e.message); }
}

async function loadApprovedRecurring() {
    const list = document.getElementById('approvedRecurringList');
    list.innerHTML = "読み込み中...";
    try {
        const snap = await db.collection('recurring_absence_applications')
            .where('userId', '==', currentUser.uid)
            .where('status', '==', 'approved')
            .orderBy('timestamp', 'desc')
            .get();
        
        list.innerHTML = "";
        if (snap.empty) {
            list.innerHTML = "<p>承認済みのデータはありません</p>";
            return;
        }

        snap.forEach(doc => {
            const d = doc.data();
            const div = document.createElement('div');
            div.style.border = "1px solid #ddd"; div.style.padding = "10px"; div.style.marginBottom = "5px";
            let content = `<strong>${d.semester}</strong><br>`;
            if (d.data) {
                content += `<div>不参加: ${d.data}</div>`;
            }
            content += `<img src="${d.image}" style="max-height:100px; display:block; margin-top:5px;">`;
            div.innerHTML = content;
            list.appendChild(div);
        });
    } catch(e) { console.error(e); list.innerHTML = "読み込みエラー"; }
}

function toBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = error => reject(error);
    });
}

// ==========================================
//   認証機能 (Discord OIDC)
// ==========================================
function loginWithDiscord() {
    const provider = new firebase.auth.OAuthProvider('oidc.discord');
    provider.addScope('identify');
    auth.signInWithPopup(provider)
        .then((result) => {
            const user = result.user;
            db.collection('users').doc(user.uid).set({
                displayName: user.displayName, email: user.email, photoURL: user.photoURL,
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            window.location.href = 'pre_home.html';
        })
        .catch((error) => console.error("Login Error:", error));
}

function logoutUser() {
    if(confirm("ログアウトしますか？")) {
        auth.signOut().then(() => window.location.href = 'pre_login.html');
    }
}

// ==========================================
//   管理者機能
// ==========================================
function switchAdminSubTab(tab) {
    const authView = document.getElementById('view-auth');
    const reportView = document.getElementById('view-report');
    const recurringView = document.getElementById('view-recurring');

    // 表示・非表示のリセット
    if(authView) authView.style.display = 'none';
    if(reportView) reportView.style.display = 'none';
    if(recurringView) recurringView.style.display = 'none';
    
    // ボタンのアクティブ状態リセット
    document.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
    const targetBtn = document.getElementById(`btn-sub-${tab}`);
    if(targetBtn) targetBtn.classList.add('active');

    // コンテンツ表示
    if (tab === 'auth') {
        if(authView) authView.style.display = 'block';
        refreshRequests();
    } else if (tab === 'report') {
        if(reportView) reportView.style.display = 'block';
        refreshReports();
    } else if (tab === 'recurring') {
        if(recurringView) recurringView.style.display = 'block';
        refreshRecurring();
    }
}

async function refreshRecurring() {
    const list = document.getElementById('recurringList');
    list.innerHTML = "読み込み中...";
    const snap = await db.collection('recurring_absence_applications').where('status', '==', 'pending').get();
    
    list.innerHTML = "";
    if(snap.empty) { list.innerHTML = "<p>申請なし</p>"; return; }

    snap.forEach(doc => {
        const d = doc.data();
        const div = document.createElement('div');
        div.className = 'item-card';
        div.innerHTML = `
            <div>
                <strong>${d.userName}</strong> (${d.semester})<br>
                <img src="${d.image}" style="max-width:100%; max-height:200px; margin:5px 0;">
                <div class="input-group">
                    <label>除外する曜日・時限を設定</label>
                    <input type="text" id="recData-${doc.id}" placeholder="例: 月1, 水3, 金5">
                </div>
            </div>
            <button onclick="approveRecurring('${doc.id}')" class="btn-primary">承認・保存</button>
        `;
        list.appendChild(div);
    });
}

async function approveRecurring(docId) {
    const dataVal = document.getElementById(`recData-${docId}`).value;
    if(!dataVal) return alert("設定値を入力してください");
    
    if(!confirm("承認しますか？")) return;
    await db.collection('recurring_absence_applications').doc(docId).update({
        status: 'approved',
        data: dataVal
    });
    refreshRecurring();
}

async function refreshAllUsers() {
    const list = document.getElementById('allUsersList');
    list.innerHTML = "読み込み中...";
    const snap = await db.collection('users').get();
    
    list.innerHTML = "";
    snap.forEach(doc => {
        const u = doc.data();
        const uid = doc.id;
        const detailsId = `details-${uid}`;
        
        const div = document.createElement('div');
        div.className = 'item-card';
        div.style.display = 'block';
        
        const hiddenInfo = `
            <ul style="font-size:0.8em; color:#555; text-align:left;">
                <li>所感: ${u.adminMemo || "未設定"}</li>
                <li>参加率: 活動(${u.rateActivity || 0}%) / チーム(${u.rateTeam || 0}%) / カリキュラム(${u.rateCurriculum || 0}%)</li>
                <li>仲の良い人: ${u.closeFriends || "不明"}</li>
                <li>グループ: ${u.groups || "なし"}</li>
                <li>連携: Qiita(${u.qiitaId || "-"}) / Git(${u.gitId || "-"}) / Discord(${u.discordId || "-"})</li>
                <li>顔登録: ${u.faceRegistered ? "済" : "未"}</li>
                <li>Admin権限: ${u.isAdmin ? "あり" : "なし"}</li>
                <li>借用備品: ${u.borrowedItems || "なし"}</li>
            </ul>
        `;

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <img src="${u.customIcon || u.photoURL || 'https://via.placeholder.com/32'}" style="width:32px; height:32px; border-radius:50%;">
                    <strong>${u.displayName}</strong>
                </div>
                <button onclick="document.getElementById('${detailsId}').style.display = document.getElementById('${detailsId}').style.display=='none'?'block':'none'" style="font-size:0.8em;">詳細</button>
            </div>
            <div id="${detailsId}" style="display:none; margin-top:10px; border-top:1px solid #eee; padding-top:5px;">
                ${hiddenInfo}
            </div>
        `;
        list.appendChild(div);
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

async function updateAppbarStatus() {
    const campusEl = document.getElementById('appbarCampus');
    const statusEl = document.getElementById('appbarStatus');
    if (!statusEl || !registeredGpsAreas || !registeredCampuses) return;
    
    let fixedCampus = null;
    if (userSettings && userSettings.defaultCampusId) {
        fixedCampus = registeredCampuses.find(c => c.id === userSettings.defaultCampusId);
    }

    const render = (campusName, areas) => {
        campusEl.textContent = campusName;
        if (areas.length === 0) {
            statusEl.innerHTML = '<div class="status-static">活動なし</div>';
        } else if (areas.length === 1) {
            statusEl.innerHTML = `<div class="status-static">📍 ${areas[0].name}</div>`;
        } else {
            const text = areas.map(a => a.name).join("　");
            statusEl.innerHTML = `<div class="status-marquee">${text}　　${text}</div>`;
        }
        const modalContent = document.getElementById('statusDetailContent');
        if (areas.length === 0) {
            modalContent.innerHTML = `<p>${campusName} で活動中の場所はありません。</p>`;
        } else {
            modalContent.innerHTML = areas.map(a => `
                <div style="padding:8px 0; border-bottom:1px solid #f0f0f0;">
                    <span style="background:#28a745; color:white; padding:2px 6px; border-radius:4px; font-size:0.8em; margin-right:5px;">活動中</span>
                    <strong>${campusName}</strong> - ${a.name}
                </div>`).join('');
        }
    };

    if (!navigator.geolocation) { render("GPS不可", []); return; }

    navigator.geolocation.getCurrentPosition((pos) => {
        const uLat = pos.coords.latitude;
        const uLon = pos.coords.longitude;
        let targetCampus = fixedCampus;
        if (!targetCampus) {
            let minDist = Infinity;
            registeredCampuses.forEach(c => {
                const dist = getDistance(uLat, uLon, c.lat, c.lon);
                if (dist < minDist) { minDist = dist; targetCampus = c; }
            });
        }
        if (targetCampus) {
            const targetAreas = registeredGpsAreas.filter(a => a.isActive && a.campusId === targetCampus.id);
            render(targetCampus.name, targetAreas);
        } else {
            render("キャンパス外", []);
        }
    }, (err) => {
        const allActive = registeredGpsAreas.filter(a => a.isActive);
        render("全キャンパス", allActive);
    }, { timeout: 5000 });
}

// --- その他 共通処理 ---
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

async function loadRegisteredFaces() {
    try {
        const snapshot = await db.collection("faces").get();
        registeredFaces = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.descriptors && data.descriptors.length > 0) {
                 try {
                     const binary = atob(data.descriptors[0]);
                     const len = binary.length;
                     const bytes = new Uint8Array(len);
                     for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
                     const float32 = new Float32Array(bytes.buffer);
                     if (float32.length === 128) {
                         registeredFaces.push({ docId: doc.id, label: data.label, thumbnail: data.thumbnail || null, descriptor: float32 });
                     }
                 } catch(e) {}
            }
        });
    } catch (e) { console.error(e); }
}

async function loadModels() {
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/'; 
    try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    } catch(e) { console.error("Model Load Error:", e); }
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2) * Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// ==========================================
//   ニュース機能 (Swipe & Logic)
// ==========================================
async function loadHomeNews() {
    const section = document.getElementById('news-section');
    if (section && !document.getElementById('news-tab-bar')) {
        const tabBar = document.createElement('div');
        tabBar.id = 'news-tab-bar';
        tabBar.style.display = 'flex';
        tabBar.style.marginBottom = '10px';
        tabBar.style.borderRadius = '5px';
        tabBar.style.overflow = 'hidden';
        tabBar.innerHTML = `
            <button id="tab-news-0" onclick="switchNewsSlide(0)" style="flex:1; padding:12px; border:none; background:#007bff; color:white; font-weight:bold; cursor:pointer;">管理者おすすめ</button>
            <button id="tab-news-1" onclick="switchNewsSlide(1)" style="flex:1; padding:12px; border:none; background:#eee; color:#333; cursor:pointer;">Qiitaトレンド</button>
        `;
        section.insertBefore(tabBar, section.firstChild);
    }

    const slideRec = document.getElementById('slide-rec');
    if (slideRec) {
        try {
            const snap = await db.collection('recommended_news').orderBy('timestamp', 'desc').get();
            let items = [];
            snap.forEach(doc => {
                const d = doc.data();
                items.push({ title: d.title, url: d.url, badge: 'Pick', color: '#ff9800', author: null });
            });
            renderNewsSlide(slideRec, "🏆 管理者おすすめ", "Qiitaトレンド ➡", items, 1);
        } catch(e) { slideRec.innerHTML = '<p>読み込みエラー</p>'; }
    }

    const slideTrend = document.getElementById('slide-trend');
    if (slideTrend) {
        try {
            const targetUrl = 'https://qiita.com/api/v2/items?page=1&per_page=20&query=stocks:>20';
            const data = await fetchWithProxy(targetUrl);
            let items = [];
            if (data && data.length > 0) {
                items = data.map(item => ({
                    title: item.title, url: item.url, badge: 'Qiita', color: '#55c500', author: (item.user ? item.user.id : 'unknown')
                }));
            }
            renderNewsSlide(slideTrend, "📈 Qiitaトレンド", "⬅ 管理者おすすめ", items, 0);
        } catch(e) { slideTrend.innerHTML = '<p style="color:red">取得失敗</p>'; }
    }
}

function handleSwipe() {
    if (touchEndX < touchStartX - 50) {
        // 左スワイプ -> 次へ
        if (currentNewsSlide === 0) switchNewsSlide(1);
    }
    if (touchEndX > touchStartX + 50) {
        // 右スワイプ -> 前へ
        if (currentNewsSlide === 1) switchNewsSlide(0);
    }
}ZZ

async function fetchWithProxy(targetUrl) {
    const proxies = [
        (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    ];
    for (const proxyFunc of proxies) {
        try {
            const res = await fetch(proxyFunc(targetUrl));
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return await res.json();
        } catch (e) { }
    }
}

function switchNewsSlide(index) {
    const track = document.getElementById('newsTrack');
    currentNewsSlide = index;
    const translateVal = index === 0 ? '0%' : '-50%';
    track.style.transform = `translateX(${translateVal})`;
    const tab0 = document.getElementById('tab-news-0');
    const tab1 = document.getElementById('tab-news-1');
    if(tab0 && tab1) {
        if(index === 0) {
            tab0.style.background = '#007bff'; tab0.style.color = 'white';
            tab1.style.background = '#eee';    tab1.style.color = '#333';
        } else {
            tab0.style.background = '#eee';    tab0.style.color = '#333';
            tab1.style.background = '#007bff'; tab1.style.color = 'white';
        }
    }
}

function renderNewsSlide(container, title, navText, items, nextIndex) {
    container.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'news-header';
    
    let leftNav = '', rightNav = '';
    if (nextIndex === 1) { 
         rightNav = `<span class="nav-hint" onclick="switchNewsSlide(${nextIndex})">${navText}</span>`;
         leftNav = `<span class="nav-hint" onclick="switchNewsSlide(1)">⬅ Qiitaトレンド</span>`;
    } else { 
         leftNav = `<span class="nav-hint" onclick="switchNewsSlide(${nextIndex})">${navText}</span>`;
         rightNav = `<span class="nav-hint" onclick="switchNewsSlide(0)">管理者おすすめ ➡</span>`;
    }

    header.innerHTML = `
        <div style="width:30%; text-align:left;">${leftNav}</div>
        <h3 style="width:40%; text-align:center;">${title}</h3>
        <div style="width:30%; text-align:right;">${rightNav}</div>
    `;
    container.appendChild(header);

    if (items.length === 0) { container.innerHTML += '<p>記事がありません</p>'; return; }

    const listId = `list-${Math.random().toString(36).substr(2, 9)}`;
    const count = (userSettings && userSettings.newsDefaultCount) ? parseInt(userSettings.newsDefaultCount) : 5;
    
    if (items.length > count) {
        const topToggle = document.createElement('button');
        topToggle.className = 'toggle-btn';
        topToggle.textContent = "🔽 もっと見る (全表示)";
        topToggle.onclick = () => toggleNewsItems(listId, topToggle, count);
        container.appendChild(topToggle);
    }

    const listDiv = document.createElement('div');
    listDiv.id = listId;
    listDiv.className = 'news-list';

    items.forEach((item, index) => {
        const div = createNewsItem(item.title, item.url, item.badge, item.color, item.author);
        if (index >= count) div.classList.add('hidden-item');
        listDiv.appendChild(div);
    });
    container.appendChild(listDiv);

    if (items.length > count) {
        const bottomToggle = document.createElement('button');
        bottomToggle.className = 'toggle-btn';
        bottomToggle.textContent = "🔽 もっと見る (全表示)";
        bottomToggle.onclick = () => toggleNewsItems(listId, bottomToggle, count);
        container.appendChild(bottomToggle);
    }
}

function toggleNewsItems(listId, btn, count) {
    const list = document.getElementById(listId);
    const isExpanded = !list.children[count].classList.contains('hidden-item');

    if (isExpanded) {
        Array.from(list.children).forEach((child, i) => { if (i >= count) child.classList.add('hidden-item'); });
        updateToggleButtons(list.parentElement, "🔽 もっと見る");
    } else {
        Array.from(list.children).forEach(child => child.classList.remove('hidden-item'));
        updateToggleButtons(list.parentElement, "🔼 閉じる");
    }
}

function updateToggleButtons(container, text) {
    const btns = container.querySelectorAll('.toggle-btn');
    btns.forEach(b => b.textContent = text);
}

function createNewsItem(title, url, badgeText, badgeColor, author = null) {
    const div = document.createElement('div');
    div.className = 'news-item';
    div.innerHTML = `
        <div style="background:${badgeColor}; color:white; font-size:10px; padding:2px 6px; border-radius:4px; margin-right:8px; height:fit-content; flex-shrink:0;">${badgeText}</div>
        <div>
            <a href="${url}" target="_blank" style="text-decoration:none; color:#333; font-weight:bold; display:block;">${title}</a>
            ${author ? `<div style="font-size:0.8em; color:#888;">by @${author}</div>` : ''}
        </div>
    `;
    return div;
}

async function loadAdminRecommendedArticles() {
    const listEl = document.getElementById('adminNewsList');
    if (!listEl) return;
    listEl.innerHTML = '<p>読み込み中...</p>';
    try {
        const snap = await db.collection('recommended_news').orderBy('timestamp', 'desc').get();
        listEl.innerHTML = '';
        if (snap.empty) { listEl.innerHTML = '<p>登録済み記事はありません</p>'; return; }
        snap.forEach(doc => {
            const d = doc.data();
            const div = document.createElement('div');
            div.className = 'list-item-row';
            div.innerHTML = `
                <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    <a href="${d.url}" target="_blank" style="font-weight:bold; text-decoration:none; color:#333;">${d.title}</a>
                </div>
                <button class="btn-danger" onclick="deleteRecommendedArticle('${doc.id}')" style="margin-left:10px;">削除</button>
            `;
            listEl.appendChild(div);
        });
    } catch (e) { listEl.innerHTML = '<p>読み込みエラー</p>'; }
}

async function registerRecommendedArticle() {
    const input = document.getElementById('qiitaInput');
    const urlOrId = input.value.trim();
    if (!urlOrId) return;
    let itemId = urlOrId;
    const match = urlOrId.match(/items\/([a-z0-9]+)/);
    if (match) itemId = match[1];
    try {
        const targetUrl = `https://qiita.com/api/v2/items/${itemId}`;
        const data = await fetchWithProxy(targetUrl);
        await db.collection('recommended_news').add({
            title: data.title, url: data.url, itemId: itemId, timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert(`追加しました: ${data.title}`);
        input.value = "";
        loadAdminRecommendedArticles();
    } catch(e) { alert("エラー: " + e.message); }
}

async function deleteRecommendedArticle(docId) {
    if (!confirm("この記事を削除しますか？")) return;
    await db.collection('recommended_news').doc(docId).delete();
    loadAdminRecommendedArticles();
}

function switchTab(tabName, btnElement) {
    // ボタンのスタイルリセット
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    // コンテンツの非表示
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // クリックされたボタンをアクティブ化
    if (btnElement) {
        btnElement.classList.add('active');
    }
    
    // 対象コンテンツを表示
    const content = document.getElementById(`tab-${tabName}`);
    if (content) {
        content.classList.add('active');
    }
}

// --- 認証リクエスト・カラーコード処理 ---
async function refreshRequests() {
    const listEl = document.getElementById('requestList');
    listEl.innerHTML = '<p>読み込み中...</p>';
    try {
        const snapshot = await db.collection('auth_requests').where('status', '==', 'pending').orderBy('requestTimestamp', 'desc').get();
        listEl.innerHTML = '';
        if (snapshot.empty) { listEl.innerHTML = '<p>リクエストはありません</p>'; return; }
        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.requestTimestamp ? data.requestTimestamp.toDate().toLocaleString() : '';
            const item = document.createElement('div');
            item.className = 'item-card';
            item.innerHTML = `
                <div><strong>${data.userName}</strong><br><small>${date}</small><br><span style="font-size:0.8em; color:#666;">Type: ${data.authType}</span></div>
                <button onclick="openAuthModal('${doc.id}', '${data.userName}', '${data.authType}')">認証へ</button>
            `;
            listEl.appendChild(item);
        });
    } catch(e) { listEl.innerHTML = '<p>エラー</p>'; }
}

async function refreshReports() {
    const listEl = document.getElementById('reportList');
    listEl.innerHTML = '<p>読み込み中...</p>';
    try {
        const snapshot = await db.collection('absence_reports').orderBy('timestamp', 'desc').limit(50).get();
        listEl.innerHTML = '';
        if (snapshot.empty) { listEl.innerHTML = '<p>届出なし</p>'; return; }
        snapshot.forEach(doc => {
            const d = doc.data();
            const periodStr = d.endDate ? `${d.startDate.toDate().toLocaleString()} 〜 ${d.endDate.toDate().toLocaleString()}` : d.startDate.toDate().toLocaleString();
            const statusLabel = { 'pending':'未承認', 'approved':'承認済', 'confirm':'要確認', 'rejected':'否認' }[d.status] || d.status;
            let badgeColor = d.status==='approved'?"#007bff":d.status==='confirm'?"#ffc107":d.status==='rejected'?"#dc3545":"#666";
            
            const div = document.createElement('div');
            div.className = 'item-card';
            div.style.display = 'block';
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; background-color:#eeeeee; padding:10px; border-bottom:1px solid #ddd;">
                    <strong>${d.userName}</strong>
                    <span style="background:${badgeColor}; color:white; padding:2px 8px; border-radius:4px; font-size:0.8em;">${statusLabel}</span>
                </div>
                <div style="padding:10px;">
                    <div style="font-size:0.9em; margin-bottom:5px;">
                        <span style="color:#007bff; font-weight:bold;">[${d.type}]</span> <br>期間: <b>${periodStr}</b><br>理由: ${d.reason}
                    </div>
                    ${d.attachment ? `<img src="${d.attachment}" style="max-height:80px; border:1px solid #ccc; display:block; margin:5px 0;">` : ''}
                    <div style="text-align:right; margin-top:10px;">
                        <button onclick="updateReportStatus('${doc.id}','approved')" style="padding:5px 10px; font-size:0.8em; background:#007bff; color:white; border:none; border-radius:4px; margin-right:5px;">承認</button>
                        <button onclick="updateReportStatus('${doc.id}','confirm')" style="padding:5px 10px; font-size:0.8em; background:#ffc107; color:black; border:none; border-radius:4px; margin-right:5px;">確認</button>
                        <button onclick="updateReportStatus('${doc.id}','rejected')" style="padding:5px 10px; font-size:0.8em; background:#dc3545; color:white; border:none; border-radius:4px;">否認</button>
                    </div>
                </div>
            `;
            listEl.appendChild(div);
        });
    } catch(e) { listEl.innerHTML = '<p>エラー</p>'; }
}

async function updateReportStatus(docId, st) {
    if(!confirm('変更しますか？')) return;
    await db.collection('absence_reports').doc(docId).update({ status: st });
    refreshReports();
}

async function openAuthModal(reqId, userName, authTypeString) {
    currentRequestId = reqId;
    adminAuthStep = 0;
    colorMatchCounter = 0;
    const parts = authTypeString.split(',');
    const targetCode = parts[0].includes('code') && parts.length >= 5 ? parts.slice(1, 5) : [];
    const registered = registeredFaces.find(f => f.label === userName);
    currentAuthUser = { name: userName, targetCode: targetCode, descriptor: registered ? registered.descriptor : null };

    const modal = document.getElementById('authModal');
    modal.style.display = 'block';
    updateAdminStatus("コードを枠に合わせてください");
    document.getElementById('approveBtn').disabled = true;
    
    const video = document.getElementById('adminVideo');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        video.onloadedmetadata = () => { video.play(); processAdminFrame(); };
    } catch(e) { alert("カメラ起動エラー: " + e.message); }
}

function closeAuthModal() {
    document.getElementById('authModal').style.display = 'none';
    const video = document.getElementById('adminVideo');
    if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    if (adminGuideLoopId) { cancelAnimationFrame(adminGuideLoopId); adminGuideLoopId = null; }
}

function updateAdminStatus(msg) {
    document.getElementById('modalTitle').textContent = `${currentAuthUser ? currentAuthUser.name : ''} 認証`;
    document.getElementById('adminAuthStatus').textContent = msg;
}

async function processAdminFrame() {
    const canvas = document.getElementById('adminCanvas');
    const video = document.getElementById('adminVideo');
    const modal = document.getElementById('authModal');
    if (modal.style.display === 'none' || !canvas || !video || video.paused || video.ended) return;

    if (video.videoWidth > 0 && canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    const ctx = canvas.getContext('2d');
    const w = canvas.width; const h = canvas.height;
    ctx.drawImage(video, 0, 0, w, h);

    if (adminAuthStep === 0) {
        if (currentAuthUser.targetCode.length === 4) {
            const detectedCode = scanColors(ctx, w, h);
            if (isCodeMatch(detectedCode, currentAuthUser.targetCode)) {
                colorMatchCounter++;
                if (colorMatchCounter > 10) { adminAuthStep = 1; updateAdminStatus("コード一致！ 次は「顔」を映してください"); }
            } else { colorMatchCounter = Math.max(0, colorMatchCounter - 1); }
        } else { adminAuthStep = 1; }
    } else if (adminAuthStep === 1) {
        if (currentAuthUser.descriptor) {
            try {
                const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
                if (detection) {
                    const dist = faceapi.euclideanDistance(detection.descriptor, currentAuthUser.descriptor);
                    if (dist < 0.6) {
                        adminAuthStep = 2;
                        updateAdminStatus("本人確認完了！");
                        document.getElementById('approveBtn').disabled = false;
                    }
                }
            } catch(e) {}
        } else {
            updateAdminStatus("顔データなし (スキップ可)");
            document.getElementById('approveBtn').disabled = false;
        }
    }
    drawAdminGuide(ctx, w, h, adminAuthStep);
    adminGuideLoopId = requestAnimationFrame(processAdminFrame);
}

function scanColors(ctx, w, h) {
    const refW = 230; const refH = 170;
    const scale = Math.min(w / refW, h / refH) * 0.8;
    const offsetX = (w - refW * scale) / 2; const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: Math.floor(offsetX + x * scale), y: Math.floor(offsetY + y * scale) });
    // H型の4箇所をサンプリング
    const points = [ t(55, 85), t(115, 55), t(115, 105), t(175, 85) ];
    const imageData = ctx.getImageData(0, 0, w, h).data;
    return points.map(p => {
        const i = (p.y * w + p.x) * 4;
        return classifyColor(imageData[i], imageData[i+1], imageData[i+2]);
    });
}

function classifyColor(r, g, b) {
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    if ((max - min) < 40) return '?';
    if (g > 150 && b > 150 && r < 120) return 'C'; // Cyan
    if (r > 150 && g > 150 && b < 120) return 'Y'; // Yellow
    if (r > 150 && b > 150 && g < 120) return 'M'; // Magenta
    if (g > 100 && r < 100 && b < 100) return 'G'; // Green
    return '?';
}

function isCodeMatch(detected, target) {
    for (let i = 0; i < 4; i++) if (detected[i] !== target[i]) return false;
    return true;
}

function drawAdminGuide(ctx, w, h, step) {
    const refW = 230; const refH = 170;
    const scale = Math.min(w / refW, h / refH) * 0.8;
    const offsetX = (w - refW * scale) / 2; const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY });
    ctx.lineWidth = 4; ctx.lineCap = "round";
    const alpha = step === 0 ? 1.0 : 0.2;
    
    // ガイド枠描画 (H型の周辺)
    ctx.strokeStyle = `rgba(255, 0, 0, ${alpha})`;
    ctx.beginPath(); let p = t(30, 50); ctx.moveTo(p.x, p.y); p = t(30, 30); ctx.lineTo(p.x, p.y); p = t(50, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    
    if (step === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        const fillRect = (x1,y1,x2,y2) => { const s = t(x1,y1); const e = t(x2,y2); ctx.fillRect(s.x, s.y, e.x - s.x, e.y - s.y); };
        // H型の透過マスク
        fillRect(40, 40, 70, 130); fillRect(70, 70, 150, 100); fillRect(150, 40, 180, 130);
    }
}

async function approveRequest() {
    if(!currentRequestId) return;
    await db.collection('auth_requests').doc(currentRequestId).update({ status: 'approved', approvalTimestamp: firebase.firestore.FieldValue.serverTimestamp() });
    await db.collection('attendance_logs').add({ userName: currentAuthUser.name, timestamp: firebase.firestore.FieldValue.serverTimestamp(), adminId: 'web_admin' });
    alert('承認しました');
    closeAuthModal();
    refreshRequests();
}

async function registerCampus() {
    const name = document.getElementById('campusName').value;
    const lat = parseFloat(document.getElementById('campusLat').value);
    const lon = parseFloat(document.getElementById('campusLon').value);
    await db.collection('campuses').add({ name, lat, lon });
    loadCampuses(); populateInfoLists(); alert("登録しました");
}

async function registerArea() {
    const campusId = document.getElementById('campusSelect').value;
    const name = document.getElementById('areaName').value;
    const lat = parseFloat(document.getElementById('areaLat').value);
    const lon = parseFloat(document.getElementById('areaLon').value);
    await db.collection('gps_areas').doc(name).set({ name, campusId, lat, lon, isActive: false });
    loadGpsAreas(); populateInfoLists(); alert("登録しました");
}

// --- 情報リスト生成 (修正: クラス付与とレイアウト調整) ---
function populateInfoLists() {
    const select = document.getElementById('campusSelect');
    if(select) {
        select.innerHTML = '<option value="">キャンパスを選択</option>';
        registeredCampuses.forEach(c => { const opt = document.createElement('option'); opt.value = c.id; opt.innerText = c.name; select.appendChild(opt); });
    }
    const hierList = document.getElementById('hierarchyList');
    if(hierList) {
        hierList.innerHTML = '';
        registeredCampuses.forEach(campus => {
            const areas = registeredGpsAreas.filter(a => a.campusId === campus.id);
            
            // ★修正: CSSクラス 'settings-details' を付与してスタイル崩れ(縦書き)を防止
            const details = document.createElement('details');
            details.className = 'settings-details';
            
            const summary = document.createElement('summary');
            // ★修正: Flexboxで横並び・左詰めを明示
            summary.innerHTML = `<div style="display:flex; align-items:center; gap:5px;"><input type="checkbox" class="chk-campus" value="${campus.id}"><span>🏢 ${campus.name} (${areas.length})</span></div>`;
            
            const content = document.createElement('div');
            content.className = 'details-content';
            
            if (areas.length > 0) {
                const actionDiv = document.createElement('div');
                actionDiv.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-bottom:10px;';
                // 選択削除ボタンにも確認ダイアログが入るdeleteSelectedAreasを呼ぶ
                actionDiv.innerHTML = `<button class="btn-danger" onclick="deleteSelectedAreas('${campus.id}')">選択削除</button><button class="btn-danger" onclick="deleteAllAreasInCampus('${campus.id}')">全削除</button>`;
                content.appendChild(actionDiv);
                
                areas.forEach(area => {
                    const row = document.createElement('div');
                    row.className = 'list-item-row nested-area';
                    if(area.isActive) row.style.backgroundColor = '#e6ffec';
                    
                    // ★修正: gapを5pxに縮め、空白を削減
                    row.innerHTML = `
                        <div class="checkbox-wrapper" style="gap:5px;">
                            <input type="checkbox" class="chk-area-${campus.id}" value="${area.name}">
                            <div style="text-align:left;"><strong>📍 ${area.name}</strong></div>
                        </div>
                        <div>
                            <button onclick="toggleAreaActive('${area.name}', ${area.isActive})">切替</button>
                            <button class="btn-danger" onclick="deleteItem('gps_areas', '${area.name}')">削除</button>
                        </div>`;
                    content.appendChild(row);
                });
            } else {
                content.innerHTML = '<p style="color:#888; text-align:left; padding-left:10px;">(エリア未登録)</p>';
            }
            
            details.appendChild(summary); details.appendChild(content); hierList.appendChild(details);
        });
    }
    populateFaceList();
}

async function toggleAreaActive(docId, currentStatus) {
    await db.collection('gps_areas').doc(docId).update({ isActive: !currentStatus });
    loadGpsAreas(); populateInfoLists();
}

function populateFaceList() {
    const el = document.getElementById('faceList');
    if(!el) return;
    el.innerHTML = '';
    registeredFaces.forEach(f => {
        const div = document.createElement('div');
        div.className = 'list-item-row';
        div.innerHTML = `<div class="checkbox-wrapper"><input type="checkbox" class="chk-face" value="${f.docId}"><strong>${f.label}</strong></div><button class="btn-danger" onclick="deleteItem('faces', '${f.docId}')">削除</button>`;
        el.appendChild(div);
    });
}

async function deleteItem(collection, id) {
    if(!confirm('削除しますか？')) return;
    await db.collection(collection).doc(id).delete();
    reloadAllData();
}

// --- 選択削除 (修正: 確認ダイアログ追加) ---
async function deleteSelectedItems(type) {
    let inputs, collection;
    if (type === 'campuses') { inputs = document.querySelectorAll('.chk-campus:checked'); collection = 'campuses'; }
    else if (type === 'faces') { inputs = document.querySelectorAll('.chk-face:checked'); collection = 'faces'; }
    
    if (inputs.length === 0) return alert("選択されていません");
    
    // ★追加: 警告ダイアログ
    if (!confirm(`${inputs.length}件のデータを削除しますか？\nこの操作は取り消せません。`)) return;

    const batch = db.batch();
    inputs.forEach(input => { batch.delete(db.collection(collection).doc(input.value)); });
    await batch.commit();
    reloadAllData();
}

async function deleteSelectedAreas(campusId) {
    const inputs = document.querySelectorAll(`.chk-area-${campusId}:checked`);
    const batch = db.batch();
    inputs.forEach(input => { batch.delete(db.collection('gps_areas').doc(input.value)); });
    await batch.commit();
    reloadAllData();
}

// --- エリア選択削除 (修正: 確認ダイアログ追加) ---
async function deleteSelectedAreas(campusId) {
    const inputs = document.querySelectorAll(`.chk-area-${campusId}:checked`);
    
    if (inputs.length === 0) return alert("選択されていません");

    // ★追加: 警告ダイアログ
    if (!confirm(`${inputs.length}件の活動場所を削除しますか？`)) return;

    const batch = db.batch();
    inputs.forEach(input => { batch.delete(db.collection('gps_areas').doc(input.value)); });
    await batch.commit();
    reloadAllData();
}

async function deleteAll(collection) {
    const snap = await db.collection(collection).get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    reloadAllData();
}

async function reloadAllData() {
    await loadCampuses(); await loadGpsAreas(); await loadRegisteredFaces(); populateInfoLists();
}

async function startFaceRegistration() {
    const name = document.getElementById('regName').value.trim();
    if(!name) return alert("登録名を入力してください");
    regStep = 1; regDescriptors = []; regThumbnail = ""; currentDetection = null; faceStableCount = 0;
    const video = document.getElementById('regVideo');
    const canvas = document.getElementById('regCanvas');
    try {
        await loadModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        regStream = stream; video.srcObject = stream;
        video.onloadedmetadata = () => { video.play(); document.getElementById('regStatus').textContent = `Step 1/5`; detectFaceLoopManual(video, canvas); };
    } catch(e) { alert("カメラエラー"); }
}

async function detectFaceLoopManual(video, canvas) {
    if (regStep > 5 || !regStream) return;
    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    faceapi.matchDimensions(canvas, displaySize);
    try {
        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
        const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (detection && detection.detection.score > 0.85) {
            faceapi.draw.drawDetections(canvas, faceapi.resizeResults(detection, displaySize));
            if (faceStableCount > 5) {
                currentDetection = detection;
                document.getElementById('regNextBtn').disabled = false;
                document.getElementById('regNextBtn').style.backgroundColor = "#28a745";
            } else { faceStableCount++; }
        }
    } catch(e) {}
    setTimeout(() => detectFaceLoopManual(video, canvas), 100);
}

function proceedToNextStep() {
    if (!currentDetection) return;
    regDescriptors.push(float32ToBase64(currentDetection.descriptor));
    if (regStep === 1) {
        const v = document.getElementById('regVideo');
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0); regThumbnail = c.toDataURL('image/jpeg', 0.7);
    }
    regStep++; faceStableCount = 0; currentDetection = null;
    document.getElementById('regNextBtn').disabled = true;
    document.getElementById('regNextBtn').style.backgroundColor = "#ccc";
    if (regStep <= 5) document.getElementById('regStatus').textContent = `Step ${regStep}/5`;
    else saveFaceDataManual();
}

async function saveFaceDataManual() {
    const name = document.getElementById('regName').value.trim();
    await db.collection("faces").add({ label: name, thumbnail: regThumbnail, descriptors: regDescriptors });
    alert(`登録完了`);
    reloadAllData();
    if (regStream) { regStream.getTracks().forEach(t => t.stop()); regStream = null; }
}

function float32ToBase64(float32) {
    const buffer = float32.buffer; const bytes = new Uint8Array(buffer);
    let binary = ''; for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function toggleFormInputs() {
    const type = document.getElementById('reportType').value;
    if (type === 'absence') {
        document.getElementById('input-date-range').style.display = 'block';
        document.getElementById('input-datetime').style.display = 'none';
    } else {
        document.getElementById('input-date-range').style.display = 'none';
        document.getElementById('input-datetime').style.display = 'block';
    }
}

async function submitReport() {
    if (!currentUser) return alert("ログインしてください");
    const type = document.getElementById('reportType').value;
    const reason = document.getElementById('reportReason').value.trim();
    const fileInput = document.getElementById('reportImage');
    if (!reason) return alert("理由を入力してください");

    let startDate = null, endDate = null;
    if (type === 'absence') {
        const s = document.getElementById('reportStartDate').value;
        startDate = new Date(s + 'T00:00:00');
        endDate = new Date(s + 'T23:59:59');
    } else {
        const dt = document.getElementById('reportDateTime').value;
        startDate = new Date(dt); endDate = new Date(dt);
    }

    let imageBase64 = null;
    if (fileInput.files[0]) imageBase64 = await toBase64(fileInput.files[0]);

    await db.collection('absence_reports').add({
        userName: currentUser.displayName, type, reason,
        startDate: firebase.firestore.Timestamp.fromDate(startDate),
        endDate: firebase.firestore.Timestamp.fromDate(endDate),
        attachment: imageBase64, status: 'pending',
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    alert("送信しました");
}

// ==========================================
//   認証リクエスト (User: H Code Drawing)
// ==========================================
async function startUserAuthFlow() {
    if (!currentUser) return alert("ログイン情報が読み込まれていません。");
    
    document.getElementById('step-0').classList.remove('active');
    document.getElementById('step-1').classList.add('active');
    
    if (!navigator.geolocation) return alert("位置情報が利用できません");
    navigator.geolocation.getCurrentPosition(async (pos) => {
        startFaceAuth(currentUser.displayName);
    }, (err) => alert("位置情報エラー"));
}

async function startFaceAuth(userName) {
    document.getElementById('userStatus').textContent = "カメラ起動中...";
    isAuthCompleted = false; isDetectingLoop = false;
    try {
        await loadModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        currentStream = stream;
        const video = document.getElementById('userVideo');
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            const detectLoop = async () => {
                if (isAuthCompleted || video.paused) return;
                const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
                const resized = faceapi.resizeResults(detections, displaySize);
                canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                faceapi.draw.drawDetections(canvas, resized);
                if (resized.length > 0) {
                    isAuthCompleted = true;
                    stopFaceAuth();
                    requestAuth(userName);
                }
                if (!isAuthCompleted) setTimeout(detectLoop, 200);
            };
            detectLoop();
        };
    } catch(e) { alert("カメラエラー"); }
}

function stopFaceAuth() {
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
}

async function requestAuth(userName) {
    document.getElementById('step-1').classList.remove('active');
    document.getElementById('step-2').classList.add('active');
    const colors = ['C', 'Y', 'M', 'G'];
    const myCode = [colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)], colors[Math.floor(Math.random()*4)]];
    drawHCode(myCode);
    const docRef = await db.collection('auth_requests').add({
        userName: userName, authType: `code,${myCode.join(',')}`,
        status: 'pending', requestTimestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    myRequestId = docRef.id;
}

// ★カラーコードの完全なH型描画ロジック (Dart版準拠・枠線追加)
function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Flet/Dartコードの基準サイズ
    const baseW = 230;
    const baseH = 170;

    // 比率維持のスケール計算
    const scale = Math.min(w / baseW, h / baseH);
    const dx = (w - (baseW * scale)) / 2;
    const dy = (h - (baseH * scale)) / 2;

    const r = (x, y, rw, rh) => [dx + (x * scale), dy + (y * scale), rw * scale, rh * scale];

    ctx.clearRect(0, 0, w, h);
    
    // 1. 背景 (黒)
    ctx.fillStyle = "#000000";
    ctx.fillRect(...r(0, 0, baseW, baseH));

    // 2. マーカー (赤・青)
    ctx.fillStyle = "#FF0000";
    ctx.fillRect(...r(20, 20, 55, 55));   // 左上
    ctx.fillRect(...r(155, 20, 55, 55));  // 右上
    ctx.fillRect(...r(75, 130, 80, 10));  // 中央下の帯

    ctx.fillStyle = "#0000FF";
    ctx.fillRect(...r(20, 75, 55, 75));   // 左下
    ctx.fillRect(...r(155, 75, 55, 75));  // 右下

    // 3. 黒いストローク (枠線) - Dart版の strokePaint に相当
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * scale;
    // x=30, y=30, w=170, h=110 の矩形線
    ctx.strokeRect(...r(30, 30, 170, 110));

    // 4. データエリア背景 (白)
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(...r(40, 40, 150, 90));

    // 5. カラーコード (4色)
    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };
    
    ctx.fillStyle = colorMap[codes[0]]; ctx.fillRect(...r(40, 40, 30, 90));  // 左縦
    ctx.fillStyle = colorMap[codes[1]]; ctx.fillRect(...r(80, 40, 70, 30));  // 上横
    ctx.fillStyle = colorMap[codes[2]]; ctx.fillRect(...r(80, 80, 70, 50));  // 下横
    ctx.fillStyle = colorMap[codes[3]]; ctx.fillRect(...r(160, 40, 30, 90)); // 右縦
}

async function checkRequestStatus() {
    if(!myRequestId) return;
    const doc = await db.collection('auth_requests').doc(myRequestId).get();
    if(doc.data().status === 'approved') {
        document.getElementById('step-2').classList.remove('active');
        document.getElementById('step-3').classList.add('active');
    } else { alert('まだです'); }
}

// 履歴確認（完全版）
async function checkAttendance() {
    if (!currentUser) return;
    const name = currentUser.displayName; // Authの名前を使用
    
    // 画面表示
    const resultEl = document.getElementById('resultArea');
    if(resultEl) resultEl.style.display = 'block';
    
    try {
        // 1. 出席ログ取得
        const logSnap = await db.collection('attendance_logs')
            .where('userName', '==', name)
            .orderBy('timestamp', 'desc')
            .get();
            
        checkHistoryDates = [];
        logSnap.forEach(doc => {
            // timestampをDateオブジェクトに変換して保持
            checkHistoryDates.push(doc.data().timestamp.toDate());
        });

        // 2. 届出取得
        const reportSnap = await db.collection('absence_reports')
            .where('userName', '==', name)
            .orderBy('timestamp', 'desc')
            .get();
            
        checkReportRanges = [];
        reportSnap.forEach(doc => {
            const d = doc.data();
            if(d.startDate) {
                let s = d.startDate.toDate();
                let e = d.endDate ? d.endDate.toDate() : s;
                
                checkReportRanges.push({
                    status: d.status, 
                    type: d.type,
                    start: new Date(s.getFullYear(), s.getMonth(), s.getDate()),
                    end: new Date(e.getFullYear(), e.getMonth(), e.getDate())
                });
            }
        });
        
        // 今日の状態更新 & カレンダー描画
        updateTodayStatus();
        checkDisplayDate = new Date();
        renderCalendar();
        
    } catch(e) {
        console.error(e);
        // インデックス未作成エラーのハンドリング
        if(e.code === 'failed-precondition') {
            console.log("Firestoreインデックスが必要です。コンソールのリンクから作成してください。");
        }
    }
}

function updateTodayStatus() {
    const today = new Date();
    const isAttended = checkHistoryDates.some(d => 
        d.getFullYear() === today.getFullYear() && 
        d.getMonth() === today.getMonth() && 
        d.getDate() === today.getDate()
    );
    
    const statusEl = document.getElementById('todayStatus');
    if (isAttended) {
        statusEl.textContent = "今日の出席：完了 ✅";
        statusEl.className = "status-card status-ok";
    } else {
        statusEl.textContent = "今日の出席：未 ☁️";
        statusEl.className = "status-card status-no";
    }
}

function changeMonth(offset) {
    checkDisplayDate.setMonth(checkDisplayDate.getMonth() + offset);
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = "";
    
    const year = checkDisplayDate.getFullYear();
    const month = checkDisplayDate.getMonth();
    document.getElementById('calendarTitle').textContent = `${year}年 ${month + 1}月`;
    
    // 曜日
    ['日','月','火','水','木','金','土'].forEach(w => {
        const el = document.createElement('div');
        el.className = 'day-cell';
        el.style.border='none'; el.style.fontWeight='bold'; el.style.backgroundColor='#f0f0f0';
        el.textContent = w;
        grid.appendChild(el);
    });
    
    const firstDay = new Date(year, month, 1).getDay();
    for(let i=0; i<firstDay; i++) grid.appendChild(document.createElement('div'));
    
    const lastDay = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    
    for(let d=1; d<=lastDay; d++) {
        const currentCellDate = new Date(year, month, d); // 00:00:00
        
        const el = document.createElement('div');
        el.className = 'day-cell';
        el.style.display = 'flex';
        el.style.flexDirection = 'column';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'flex-start';
        el.textContent = d;
        
        if(year===today.getFullYear() && month===today.getMonth() && d===today.getDate()) {
            el.classList.add('today-circle');
        }
        
        // --- データ集計 ---
        // 1. 出席ログがあるか
        const hasLog = checkHistoryDates.some(hd => 
            hd.getFullYear()===year && hd.getMonth()===month && hd.getDate()===d
        );

        // 2. この日の届出を抽出
        const dayReports = checkReportRanges.filter(range => 
            currentCellDate.getTime() >= range.start.getTime() && 
            currentCellDate.getTime() <= range.end.getTime()
        );

        // 3. 承認済み欠席があるか (出席扱い用)
        const isApprovedAbsence = dayReports.some(r => r.status === 'approved' && r.type === 'absence');

        // --- アイコン表示コンテナ ---
        const iconContainer = document.createElement('div');
        iconContainer.style.marginTop = '2px';
        iconContainer.style.display = 'flex';
        iconContainer.style.gap = '2px';
        iconContainer.style.flexWrap = 'wrap';
        iconContainer.style.justifyContent = 'center';

        // A. 出席アイコン (必須・緑)
        if (hasLog || isApprovedAbsence) {
            const icon = document.createElement('div');
            // 数字を入れるため少し大きくする
            icon.style.width = '14px'; icon.style.height = '14px';
            icon.style.borderRadius = '50%';
            icon.style.backgroundColor = '#28a745'; // 緑
            icon.title = hasLog ? "出席" : "欠席(承認済)";
            iconContainer.appendChild(icon);
            el.classList.add('active-area'); 
        }

        // B. 届出アイコン描画ヘルパー
        const renderReportIcons = (reports) => {
            let pendingCount = 0;

            reports.forEach(r => {
                if (r.status === 'pending') {
                    pendingCount++;
                } else {
                    // 承認(approved)・確認(confirm)・否認(rejected) は個数分表示
                    const icon = document.createElement('div');
                    icon.style.width = '14px'; icon.style.height = '14px';
                    icon.style.borderRadius = '50%';
                    icon.style.margin = '1px';
                    
                    if (r.status === 'approved') icon.style.backgroundColor = '#007bff'; // 青
                    else if (r.status === 'confirm') icon.style.backgroundColor = '#ffc107'; // 黄
                    else if (r.status === 'rejected') icon.style.backgroundColor = '#dc3545'; // 赤
                    
                    // ツールチップ
                    const typeMap = { 'absence':'欠席', 'late':'遅刻', 'early':'早退' };
                    icon.title = `${typeMap[r.type] || r.type} (${r.status})`;
                    
                    iconContainer.appendChild(icon);
                }
            });

            // 申請中(pending) はまとめて1つ表示 (数字入り)
            if (pendingCount > 0) {
                const icon = document.createElement('div');
                icon.style.width = '14px'; icon.style.height = '14px';
                icon.style.borderRadius = '50%';
                icon.style.backgroundColor = 'gray'; // 灰
                icon.style.margin = '1px';
                
                // 数字表示スタイル
                icon.style.display = 'flex';
                icon.style.alignItems = 'center';
                icon.style.justifyContent = 'center';
                icon.style.color = 'white';
                icon.style.fontSize = '9px';
                icon.style.fontWeight = 'bold';
                icon.textContent = pendingCount.toString();
                
                icon.title = `申請中: ${pendingCount}件`;
                iconContainer.appendChild(icon);
            }
        };

        // グループ1: 欠席 (Absence)
        const absences = dayReports.filter(r => r.type === 'absence');
        renderReportIcons(absences);

        // グループ2: 遅刻・早退 (Late/Early)
        const lateEarlies = dayReports.filter(r => r.type === 'late' || r.type === 'early');
        renderReportIcons(lateEarlies);

        el.appendChild(iconContainer);
        grid.appendChild(el);
    }
}