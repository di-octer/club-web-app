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

// 各種状態管理
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

const REG_INSTRUCTIONS = ["", "正面を向いてください", "顔を【左】に向けてください", "顔を【右】に向けてください", "顔を【上】に向けてください", "顔を【下】に向けてください"];

// ==========================================
//   初期化処理
// ==========================================
window.onload = async () => {
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        const path = window.location.pathname;
        const isLoginPage = path.includes('pre_login.html');

        if (user) {
            console.log("Logged in:", user.displayName);
            if (isLoginPage) window.location.href = 'pre_home.html';
            await loadUserSettings(user.uid);
            updateUserDisplay(user);
        } else {
            if (!isLoginPage) window.location.href = 'pre_login.html';
        }
    });

    await loadCampuses();
    await loadGpsAreas();
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

// --- ユーザー設定・情報管理 ---

async function loadUserSettings(uid) {
    try {
        const doc = await db.collection('users').doc(uid).get();
        if (doc.exists) userSettings = doc.data();
        setupCommonAppbar(); 
    } catch(e) { console.error(e); }
}

// 興味タグの自動生成シミュレーション (ログイン時)
async function generateAutoTagsIfNeed(uid) {
    if(!userSettings) return;
    const hidden = userSettings.hiddenInterests || [];
    const current = userSettings.autoInterests || [];
    
    // サンプル: まだ持っておらず、隠されてもいないタグがあれば追加
    const candidates = ["Python", "TeamDev", "AI", "Design", "Flutter"];
    const newTags = [];
    
    candidates.forEach(tag => {
        // 既に持っているか確認
        if(current.includes(tag)) return;
        
        // 隠しリストにあるか確認 (期限チェック)
        const hideEntry = hidden.find(h => h.tag === tag);
        if(hideEntry) {
            const until = hideEntry.until.toDate();
            if(new Date() < until) return; // まだ期限内なら追加しない
        }
        
        // 追加候補
        if(Math.random() > 0.7) newTags.push(tag); // ランダムに追加
    });

    if(newTags.length > 0) {
        const merged = [...current, ...newTags];
        await db.collection('users').doc(uid).update({ autoInterests: merged });
        userSettings.autoInterests = merged; // メモリ上も更新
    }
}

function updateUserDisplay(user) {
    const nameEls = document.querySelectorAll('#displayUserName, #historyUserName');
    nameEls.forEach(el => el.textContent = user.displayName);
}

// ==========================================
//   共通アップバー
// ==========================================
function setupCommonAppbar() {
    const existing = document.querySelector('header');
    if(existing) existing.remove();

    let iconUrl = "https://via.placeholder.com/36?text=U";
    if (userSettings && userSettings.customIcon) iconUrl = userSettings.customIcon;
    else if (currentUser && currentUser.photoURL) iconUrl = currentUser.photoURL;

    const header = document.createElement('header');
    header.className = 'appbar-fixed';
    header.innerHTML = `
        <div class="appbar-side">
            <a href="pre_home.html" class="icon-btn" title="ホーム">🏠</a>
            <a href="pre_curriculum.html" class="icon-btn" title="カリキュラム">✏️</a>
        </div>
        <div class="appbar-info-group" onclick="toggleStatusModal()">
            <div id="appbarCampus" class="appbar-campus"></div>
            <div class="appbar-center" id="appbarStatus"><div class="status-static">...</div></div>
        </div>
        <div class="appbar-side">
            <a href="pre_index.html" class="icon-btn" title="出席認証">👤</a>
            <a href="pre_settings.html" class="icon-btn" title="設定"><img src="${iconUrl}" class="user-icon-img" onerror="this.src='https://via.placeholder.com/32'"></a>
        </div>
    `;
    document.body.prepend(header);

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
    
    // 値セット
    setVal('setAuthMethod', s.authMethod || "");
    setVal('setNewsOrder', s.newsOrder || "newest");
    setVal('setNewsDefaultTab', s.newsDefaultTab || "trend");
    setVal('setNewsDefaultCount', s.newsDefaultCount || 5);
    setVal('setNewsMaxCount', s.newsMaxCount || 20);
    setVal('manualInterests', (s.manualInterests || []).join(', '));
    setVal('manualTechStack', (s.manualTechStack || []).join(', '));
    setVal('profileText', s.profileText || "");
    setVal('setLanguage', s.language || "ja");

    // アイコン
    const currentIcon = s.customIcon || currentUser.photoURL;
    const iconEl = document.getElementById('previewIcon');
    if(iconEl) iconEl.src = currentIcon || "https://via.placeholder.com/50";

    // 自動生成タグ
    renderAutoTags('autoInterestsList', s.autoInterests || []);
    renderAutoTags('autoTechList', s.autoTechStack || []);

    // キャンパス選択肢
    const campSelect = document.getElementById('setDefaultCampus');
    if(campSelect) {
        campSelect.innerHTML = '<option value="">自動 (GPS検出)</option>';
        registeredCampuses.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id; opt.innerText = c.name;
            campSelect.appendChild(opt);
        });
        campSelect.value = s.defaultCampusId || "";
    }

    loadApprovedRecurring();
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if(el) el.value = val;
}

function renderAutoTags(containerId, tags) {
    const container = document.getElementById(containerId);
    if(!container) return;
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
    until.setMonth(until.getMonth() + 6); // 6ヶ月後

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

// ==========================================
//   設定・プロファイル
// ==========================================
async function saveSettings() {
    if (!currentUser) return;
    const data = {
        authMethod: document.getElementById('setAuthMethod').value,
        newsDefaultCount: parseInt(document.getElementById('setNewsDefaultCount').value),
        manualInterests: document.getElementById('manualInterests').value.split(',').map(s=>s.trim()),
        defaultCampusId: document.getElementById('setDefaultCampus').value,
        language: document.getElementById('setLanguage').value,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const iconInput = document.getElementById('iconUploader');
    if (iconInput.files[0]) data.customIcon = await toBase64(iconInput.files[0]);

    await db.collection('users').doc(currentUser.uid).set(data, { merge: true });
    alert("保存しました");
    location.reload();
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
    if(!list) return;
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

// ==========================================
//   認証機能 (Discord OIDC)
// ==========================================

function loginWithDiscord() {
    const provider = new firebase.auth.OAuthProvider('oidc.discord');
    provider.addScope('identify');
    auth.signInWithPopup(provider)
        .then((result) => {
            const user = result.user;
            // ログイン時にも情報をマージ
            db.collection('users').doc(user.uid).set({
                displayName: user.displayName,
                email: user.email,
                photoURL: user.photoURL,
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            window.location.href = 'pre_home.html';
        })
        .catch((error) => console.error("Login Error:", error));
}

function logoutUser() {
    if(confirm("ログアウトしますか？")) {
        auth.signOut().then(() => {
            window.location.href = 'pre_login.html';
        });
    }
}

// ==========================================
//   管理者機能
// ==========================================

function switchAdminSubTab(tab) {
    ['auth','report','recurring','users'].forEach(t => {
        document.getElementById(`view-${t}`).style.display = 'none';
        document.getElementById(`btn-sub-${t}`).classList.remove('active');
    });
    
    document.getElementById(`view-${tab}`).style.display = 'block';
    document.getElementById(`btn-sub-${tab}`).classList.add('active');

    if (tab === 'auth') refreshRequests();
    else if (tab === 'report') refreshReports();
    else if (tab === 'recurring') refreshRecurring();
    else if (tab === 'users') refreshAllUsers();
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
    const m = document.getElementById('statusDetailModal');
    const o = document.getElementById('modalOverlay');
    const isShow = m.style.display === 'block';
    m.style.display = isShow ? 'none' : 'block';
    o.style.display = isShow ? 'none' : 'block';
}

async function updateAppbarStatus() {
    const campusEl = document.getElementById('appbarCampus');
    const statusEl = document.getElementById('appbarStatus');
    if (!statusEl || registeredCampuses.length === 0) return;

    navigator.geolocation.getCurrentPosition((pos) => {
        const uLat = pos.coords.latitude; const uLon = pos.coords.longitude;
        let nearest = registeredCampuses[0]; let minDist = Infinity;
        registeredCampuses.forEach(c => {
            const d = getDistance(uLat, uLon, c.lat, c.lon);
            if(d < minDist) { minDist = d; nearest = c; }
        });
        campusEl.textContent = nearest.name;
        const active = registeredGpsAreas.filter(a => a.isActive && a.campusId === nearest.id);
        if(active.length > 0) statusEl.innerHTML = `<div class="status-marquee">${active.map(a=>a.name).join('　')}</div>`;
        else statusEl.innerHTML = '<div class="status-static">活動なし</div>';
    }, null, { timeout: 5000 });
}

async function loadCampuses() {
    const snap = await db.collection('campuses').get();
    registeredCampuses = []; snap.forEach(doc => registeredCampuses.push({ id: doc.id, ...doc.data() }));
}

async function loadGpsAreas() {
    const snap = await db.collection('gps_areas').get();
    registeredGpsAreas = []; snap.forEach(doc => registeredGpsAreas.push(doc.data()));
}

async function loadRegisteredFaces() {
    const snap = await db.collection("faces").get();
    registeredFaces = [];
    snap.forEach(doc => {
        const d = doc.data();
        if(d.descriptors) {
            const bin = atob(d.descriptors[0]);
            const f32 = new Float32Array(new Uint8Array(bin.length).map((_,i)=>bin.charCodeAt(i)).buffer);
            registeredFaces.push({ label: d.label, descriptor: f32 });
        }
    });
}

// 顔認証・登録等の残りの関数群（省略なし）
async function loadModels() {
    const URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    await faceapi.nets.tinyFaceDetector.loadFromUri(URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(URL);
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; const f1 = lat1 * Math.PI/180, f2 = lat2 * Math.PI/180;
    const df = (lat2-lat1) * Math.PI/180, dl = (lon2-lon1) * Math.PI/180;
    const a = Math.sin(df/2)**2 + Math.cos(f1)*Math.cos(f2) * Math.sin(dl/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ==========================================
//   ニュース機能 (カルーセル・スワイプ対応)
// ==========================================
async function loadHomeNews() {
    const section = document.getElementById('news-section');
    if (section && !document.getElementById('news-tab-bar')) {
        const tabBar = document.createElement('div');
        tabBar.id = 'news-tab-bar';
        tabBar.style.cssText = 'display:flex; margin-bottom:10px; border-radius:5px; overflow:hidden;';
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
                items.push({ title: d.title, url: d.url, badge: 'Pick', color: '#ff9800' });
            });
            renderNewsSlide(slideRec, "🏆 おすすめ", "Qiitaトレンド ➡", items, 1);
        } catch(e) { slideRec.innerHTML = '<p>読み込みエラー</p>'; }
    }

    const slideTrend = document.getElementById('slide-trend');
    if (slideTrend) {
        try {
            const data = await fetchWithProxy('https://qiita.com/api/v2/items?page=1&per_page=20&query=stocks:>20');
            let items = data.map(item => ({ title: item.title, url: item.url, badge: 'Qiita', color: '#55c500', author: item.user.id }));
            renderNewsSlide(slideTrend, "📈 トレンド", "⬅ おすすめ", items, 0);
        } catch(e) { slideTrend.innerHTML = '<p>取得失敗</p>'; }
    }
}

// --- ヘルパー・共通 ---
async function fetchWithProxy(url) {
    const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`);
    return await res.json();
}

function switchNewsSlide(index) {
    const track = document.getElementById('newsTrack');
    if (!track) return;
    currentNewsSlide = index;
    track.style.transform = `translateX(${index === 0 ? '0%' : '-50%'})`;

    const t0 = document.getElementById('tab-news-0');
    const t1 = document.getElementById('tab-news-1');
    if(t0 && t1) {
        t0.style.background = (index === 0) ? '#007bff' : '#eee'; t0.style.color = (index === 0) ? '#white' : '#333';
        t1.style.background = (index === 1) ? '#007bff' : '#eee'; t1.style.color = (index === 1) ? '#white' : '#333';
    }
}

function renderNewsSlide(container, title, navText, items, nextIndex) {
    container.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'news-header';
    
    // ループ対応ナビ
    let leftNav = `<span class="nav-hint" onclick="switchNewsSlide(${nextIndex})">${nextIndex === 1 ? '⬅ トレンド' : '⬅ おすすめ'}</span>`;
    let rightNav = `<span class="nav-hint" onclick="switchNewsSlide(${nextIndex})">${navText}</span>`;

    header.innerHTML = `<div style="width:30%; text-align:left;">${leftNav}</div><h3 style="width:40%; text-align:center;">${title}</h3><div style="width:30%; text-align:right;">${rightNav}</div>`;
    container.appendChild(header);

    if (items.length === 0) { container.innerHTML += '<p>記事がありません</p>'; return; }

    const listId = `list-${Math.random().toString(36).substr(2, 9)}`;
    const defCount = userSettings.newsDefaultCount || 5;

    if (items.length > defCount) {
        const btn = document.createElement('button'); btn.className = 'toggle-btn'; btn.textContent = "🔽 もっと見る";
        btn.onclick = () => toggleNewsItems(listId, btn, defCount);
        container.appendChild(btn);
    }

    const listDiv = document.createElement('div'); listDiv.id = listId;
    items.forEach((item, i) => {
        const div = document.createElement('div'); div.className = 'news-item';
        if(i >= defCount) div.classList.add('hidden-item');
        div.innerHTML = `<div style="background:${item.color}; color:white; font-size:10px; padding:2px 6px; border-radius:4px; margin-right:8px; height:fit-content;">${item.badge}</div>
                         <div><a href="${item.url}" target="_blank">${item.title}</a>${item.author ? `<small>by @${item.author}</small>` : ''}</div>`;
        listDiv.appendChild(div);
    });
    container.appendChild(listDiv);

    if (items.length > defCount) {
        const btnB = document.createElement('button'); btnB.className = 'toggle-btn'; btnB.textContent = "🔽 もっと見る";
        btnB.onclick = () => toggleNewsItems(listId, btnB, defCount);
        container.appendChild(btnB);
    }
}

function toggleNewsItems(listId, btn, count) {
    const list = document.getElementById(listId);
    const isExpanded = !list.querySelector('.hidden-item');
    const items = list.children;
    for(let i=count; i<items.length; i++) {
        if(isExpanded) items[i].classList.add('hidden-item');
        else items[i].classList.remove('hidden-item');
    }
    const btns = list.parentElement.querySelectorAll('.toggle-btn');
    btns.forEach(b => b.textContent = isExpanded ? "🔽 もっと見る" : "🔼 閉じる");
}

function updateToggleButtons(container, text) {
    const btns = container.querySelectorAll('.toggle-btn');
    btns.forEach(b => b.textContent = text);
}

function createNewsItem(title, url, badgeText, badgeColor, author = null) {
    const div = document.createElement('div');
    div.className = 'news-item';
    div.style.borderBottom = "1px solid #eee";
    div.style.padding = "10px 0";
    div.style.display = "flex";
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

async function deleteRecommendedArticle(docId) {
    if (!confirm("この記事を削除しますか？")) return;
    await db.collection('recommended_news').doc(docId).delete();
    loadAdminRecommendedArticles(); 
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

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

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
    if (g > 150 && b > 150 && r < 120) return 'C';
    if (r > 150 && g > 150 && b < 120) return 'Y';
    if (r > 150 && b > 150 && g < 120) return 'M';
    if (g > 100 && r < 100 && b < 100) return 'G';
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
    ctx.strokeStyle = `rgba(255, 0, 0, ${alpha})`;
    ctx.beginPath(); let p = t(30, 50); ctx.moveTo(p.x, p.y); p = t(30, 30); ctx.lineTo(p.x, p.y); p = t(50, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    if (step === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        const fillRect = (x1,y1,x2,y2) => { const s = t(x1,y1); const e = t(x2,y2); ctx.fillRect(s.x, s.y, e.x - s.x, e.y - s.y); };
        fillRect(70, 40, 80, 130);
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
    loadCampuses();
    populateInfoLists();
    alert("登録しました");
}

async function registerArea() {
    const campusId = document.getElementById('campusSelect').value;
    const name = document.getElementById('areaName').value;
    const lat = parseFloat(document.getElementById('areaLat').value);
    const lon = parseFloat(document.getElementById('areaLon').value);
    await db.collection('gps_areas').doc(name).set({ name, campusId, lat, lon, isActive: false });
    loadGpsAreas();
    populateInfoLists();
    alert("登録しました");
}

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
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            summary.innerHTML = `<div style="display:flex; align-items:center; gap:10px;"><input type="checkbox" class="chk-campus" value="${campus.id}"><span>🏢 ${campus.name} (${areas.length})</span></div>`;
            const content = document.createElement('div');
            content.className = 'details-content';
            if (areas.length > 0) {
                const actionDiv = document.createElement('div');
                actionDiv.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-bottom:10px;';
                actionDiv.innerHTML = `<button class="btn-danger" onclick="deleteSelectedAreas('${campus.id}')">選択削除</button><button class="btn-danger" onclick="deleteAllAreasInCampus('${campus.id}')">全削除</button>`;
                content.appendChild(actionDiv);
                areas.forEach(area => {
                    const row = document.createElement('div');
                    row.className = 'list-item-row nested-area';
                    if(area.isActive) row.style.backgroundColor = '#e6ffec';
                    row.innerHTML = `<div class="checkbox-wrapper"><input type="checkbox" class="chk-area-${campus.id}" value="${area.name}"><div><strong>📍 ${area.name}</strong></div></div><div><button onclick="toggleAreaActive('${area.name}', ${area.isActive})">切替</button><button class="btn-danger" onclick="deleteItem('gps_areas', '${area.name}')">削除</button></div>`;
                    content.appendChild(row);
                });
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

async function deleteSelectedItems(type) {
    let inputs, collection;
    if (type === 'campuses') { inputs = document.querySelectorAll('.chk-campus:checked'); collection = 'campuses'; }
    else if (type === 'faces') { inputs = document.querySelectorAll('.chk-face:checked'); collection = 'faces'; }
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

async function deleteAllAreasInCampus(campusId) {
    const snap = await db.collection('gps_areas').where('campusId', '==', campusId).get();
    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
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
//   出席認証 & カラーコード描画 (完全版)
// ==========================================
async function startUserAuthFlow() {
    if (!currentUser) return alert("ログインしてください");
    document.getElementById('step-0').classList.remove('active');
    document.getElementById('step-1').classList.add('active');
    
    if (!navigator.geolocation) return alert("GPS不可");
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
    
    drawHCode(myCode); // 完全な描画ロジック呼び出し
    
    const docRef = await db.collection('auth_requests').add({
        userName: userName, authType: `code,${myCode.join(',')}`,
        status: 'pending', requestTimestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    myRequestId = docRef.id;
}

// ★カラーコードの完全なH型描画ロジック
function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width; const h = canvas.height;
    const baseW = 230; const baseH = 170;
    const scale = Math.min(w / baseW, h / baseH);
    const dx = (w - (baseW * scale)) / 2; const dy = (h - (baseH * scale)) / 2;
    const r = (x, y, rw, rh) => [dx + (x * scale), dy + (y * scale), rw * scale, rh * scale];

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000"; ctx.fillRect(...r(0, 0, baseW, baseH)); // 背景

    // 赤い目印
    ctx.fillStyle = "#FF0000";
    ctx.fillRect(...r(20, 20, 55, 55)); ctx.fillRect(...r(155, 20, 55, 55)); ctx.fillRect(...r(75, 130, 80, 10));

    // 青い目印
    ctx.fillStyle = "#0000FF";
    ctx.fillRect(...r(20, 75, 55, 75)); ctx.fillRect(...r(155, 75, 55, 75));

    // 中央の白いH土台
    ctx.fillStyle = "#FFFFFF"; ctx.fillRect(...r(40, 40, 150, 90));

    // 指定された色を塗る (C=シアン, Y=イエロー, M=マゼンタ, G=グリーン)
    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };
    ctx.fillStyle = colorMap[codes[0]]; ctx.fillRect(...r(40, 40, 30, 90));
    ctx.fillStyle = colorMap[codes[1]]; ctx.fillRect(...r(80, 40, 70, 30));
    ctx.fillStyle = colorMap[codes[2]]; ctx.fillRect(...r(80, 80, 70, 50));
    ctx.fillStyle = colorMap[codes[3]]; ctx.fillRect(...r(160, 40, 30, 90));
}

async function checkRequestStatus() {
    if(!myRequestId) return;
    const doc = await db.collection('auth_requests').doc(myRequestId).get();
    if(doc.data().status === 'approved') {
        document.getElementById('step-2').classList.remove('active');
        document.getElementById('step-3').classList.add('active');
    } else { alert('まだです'); }
}

// ==========================================
//   出席履歴 (完全版)
// ==========================================
async function checkAttendance() {
    if (!currentUser) return;
    document.getElementById('resultArea').style.display = 'block';
    const name = currentUser.displayName;

    try {
        const logSnap = await db.collection('attendance_logs').where('userName', '==', name).orderBy('timestamp', 'desc').get();
        checkHistoryDates = [];
        logSnap.forEach(doc => checkHistoryDates.push(doc.data().timestamp.toDate()));

        const reportSnap = await db.collection('absence_reports').where('userName', '==', name).get();
        checkReportRanges = [];
        reportSnap.forEach(doc => {
            const d = doc.data();
            if(d.startDate) {
                let s = d.startDate.toDate(); let e = d.endDate ? d.endDate.toDate() : s;
                checkReportRanges.push({ status: d.status, type: d.type, start: new Date(s.setHours(0,0,0,0)), end: new Date(e.setHours(0,0,0,0)) });
            }
        });
        updateTodayStatus();
        renderCalendar();
    } catch(e) { console.error(e); }
}

function updateTodayStatus() {
    const today = new Date().toDateString();
    const isAttended = checkHistoryDates.some(d => d.toDateString() === today);
    const el = document.getElementById('todayStatus');
    if(el) {
        el.textContent = isAttended ? "今日の出席：完了 ✅" : "今日の出席：未 ☁️";
        el.className = `status-card ${isAttended ? 'status-ok' : 'status-no'}`;
    }
}

function changeMonth(offset) {
    checkDisplayDate.setMonth(checkDisplayDate.getMonth() + offset);
    renderCalendar();
}

function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    if(!grid) return;
    grid.innerHTML = "";
    const year = checkDisplayDate.getFullYear(); const month = checkDisplayDate.getMonth();
    document.getElementById('calendarTitle').textContent = `${year}年 ${month+1}月`;

    ['日','月','火','水','木','金','土'].forEach(w => {
        const cell = document.createElement('div'); cell.className = 'day-cell'; cell.style.height='30px'; cell.style.background='#f0f0f0'; cell.textContent = w; grid.appendChild(cell);
    });

    const firstDay = new Date(year, month, 1).getDay();
    const lastDate = new Date(year, month + 1, 0).getDate();
    for(let i=0; i<firstDay; i++) grid.appendChild(document.createElement('div'));

    const todayStr = new Date().toDateString();
    for(let d=1; d<=lastDate; d++) {
        const date = new Date(year, month, d);
        const cell = document.createElement('div'); cell.className = 'day-cell'; cell.textContent = d;
        if(date.toDateString() === todayStr) cell.classList.add('today-circle');

        const hasLog = checkHistoryDates.some(hd => hd.toDateString() === date.toDateString());
        const hasReport = checkReportRanges.some(r => date >= r.start && date <= r.end && r.status === 'approved');

        if(hasLog || hasReport) {
            const mark = document.createElement('div'); mark.className = 'attended-mark';
            if(hasReport && !hasLog) mark.style.backgroundColor = '#007bff';
            cell.appendChild(mark);
        }
        grid.appendChild(cell);
    }
}

function toBase64(file) {
    return new Promise((r, j) => {
        const reader = new FileReader(); reader.readAsDataURL(file);
        reader.onload = () => r(reader.result); reader.onerror = e => j(e);
    });
}