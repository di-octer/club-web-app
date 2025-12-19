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
const auth = firebase.auth(); // ★追加: Auth機能の有効化

// --- グローバル変数 ---
let currentUser = null; // ★追加: ログインユーザー保持用
let registeredCampuses = [];
let registeredGpsAreas = [];
let registeredFaces = [];
let currentStream = null;

// (他の変数はそのまま維持)
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

// 【追加】 ログインユーザー名を取得するヘルパー
function getCurrentUser() {
    return localStorage.getItem('club_app_username');
}

// --- 初期化 ---
window.onload = async () => {
    // ★修正: Auth状態の監視
    auth.onAuthStateChanged(async (user) => {
        currentUser = user;
        const path = window.location.pathname;
        const isLoginPage = path.includes('pre_login.html');

        if (user) {
            // ログイン済み
            console.log("Logged in as:", user.displayName);
            if (isLoginPage) {
                window.location.href = 'pre_home.html';
            }
            // 画面内の名前表示を更新
            updateUserDisplay(user);
        } else {
            // 未ログイン
            console.log("Not logged in");
            if (!isLoginPage) {
                window.location.href = 'pre_login.html';
            }
        }
    });

    console.log("初期化開始: bodyId =", document.body.id);
    setupCommonAppbar();

    const bodyId = document.body.id;
    
    await loadCampuses();
    await loadGpsAreas();
    updateAppbarStatus();
    
    if (bodyId === 'page-admin') {
        console.log("管理者ページ検出");
        await loadModels();
        await loadRegisteredFaces();
        await loadAdminRecommendedArticles(); // ★これが呼べるように後述の「追加」で関数定義します
        switchAdminSubTab('auth'); 
        populateInfoLists();
    } else if (bodyId === 'page-user') {
        // ユーザーページ初期化 (名前入力欄がなくなったため特になし)
    } else if (bodyId === 'page-check') {
        // 出席確認ページ (Auth確定後に動くようにしたいが、簡易的にここでも呼んでおく)
        if(currentUser) checkAttendance();
    } 
    else if (document.getElementById('news-section')) { 
        loadHomeNews();
    }
};

// ★追加: 画面上の名前表示を更新するヘルパー
function updateUserDisplay(user) {
    const nameEls = document.querySelectorAll('#displayUserName, #historyUserName');
    nameEls.forEach(el => el.textContent = user.displayName);
    
    // ログアウトボタンのタイトル更新
    const logoutBtn = document.querySelector('button[title^="ログアウト"]');
    if(logoutBtn) logoutBtn.title = `ログアウト: ${user.displayName}`;
    
    // Auth確定後に出席履歴などを自動読み込み
    if(document.body.id === 'page-check') checkAttendance();
}

function logoutUser() {
    if(confirm("ログアウトしますか？")) {
        auth.signOut().then(() => {
            window.location.href = 'pre_login.html';
        });
    }
}

// ==========================================
//   ★ユーザー情報保持・管理機能 (LocalStorage)
// ==========================================

// 名前を保存する
function saveUserName(name) {
    if(!name) return;
    localStorage.setItem('club_app_username', name);
    // 保存したら画面上の他のフィールドも更新しておく
    restoreUserSession(); 
}

// 保存された名前を取得して入力欄を埋める
function restoreUserSession() {
    const savedName = localStorage.getItem('club_app_username');
    if (!savedName) return;

    // 自動入力対象のinput IDリスト
    const targetIds = ['userNameInput', 'reportName', 'checkNameInput', 'regName'];
    
    targetIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.value = savedName;
            // 既にクリアボタンがなければ追加する
            if (!el.nextElementSibling || el.nextElementSibling.className !== 'clear-user-btn') {
                const clearBtn = document.createElement('span');
                clearBtn.className = 'clear-user-btn';
                clearBtn.innerHTML = ' ×';
                clearBtn.style.cursor = 'pointer';
                clearBtn.style.color = '#dc3545';
                clearBtn.style.fontWeight = 'bold';
                clearBtn.style.marginLeft = '5px';
                clearBtn.title = '名前をクリア';
                clearBtn.onclick = () => {
                    localStorage.removeItem('club_app_username');
                    el.value = '';
                    clearBtn.remove();
                };
                el.parentNode.insertBefore(clearBtn, el.nextSibling);
            }
        }
    });
}

function setupCommonAppbar() {
    const existing = document.querySelector('header');
    if(existing) existing.remove();

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
            cursor: pointer; flex: 0 1 auto; max-width: 60%; min-width: 120px;
        }
        .appbar-campus {
            font-weight: bold; padding: 0 10px; white-space: nowrap; 
            font-size: 0.9em; color: #fff; background: transparent;
            border-right: 1px solid rgba(255,255,255,0.3); flex: 0 0 auto;
        }
        .appbar-center {
            flex: 1; background: transparent; border-radius: 0; height: 100%;
            display: flex; align-items: center; color: #fff; font-size: 0.9em; 
            font-weight: bold; overflow: hidden; position: relative; padding: 0 10px;
            min-width: 80px;
        }
        
        .status-static { width: 100%; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .status-marquee { display: inline-block; white-space: nowrap; padding-left: 100%; animation: marquee-anim 12s linear infinite; }
        @keyframes marquee-anim { 0% { transform: translate(0, 0); } 100% { transform: translate(-100%, 0); } }

        .icon-btn {
            font-size: 1.4em; text-decoration: none; color: white;
            display: flex; align-items: center; justify-content: center;
            width: 36px; height: 36px; border-radius: 50%; transition: background 0.2s;
            border: none; background: transparent; cursor: pointer;
        }
        .icon-btn:hover { background: rgba(255,255,255,0.2); }
        
        /* モーダル関連は省略せずに記述 */
        #statusDetailModal {
            position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
            background: white; color: #333; padding: 15px;
            box-shadow: 0 5px 20px rgba(0,0,0,0.4); border-radius: 8px;
            z-index: 10000; display: none; width: 85%; max-width: 400px; text-align: left;
        }
        #statusDetailModal h4 { margin: 0 0 10px 0; border-bottom: 1px solid #eee; padding-bottom: 5px; }
        .detail-item { padding: 8px 0; border-bottom: 1px solid #f0f0f0; font-size: 0.9em; }
        .detail-badge { background: #28a745; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-right: 5px; }
        #modalOverlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.5); z-index: 9998; display: none;
        }
    `;
    document.head.appendChild(style);

    const header = document.createElement('header');
    header.className = 'appbar-fixed';
    
    // ★修正: ログアウトボタンの追加
    header.innerHTML = `
        <div class="appbar-side">
            <a href="pre_home.html" class="icon-btn" title="ホーム">🏠</a>
            <a href="pre_curriculum.html" class="icon-btn" title="カリキュラム">✏️</a>
        </div>
        <div class="appbar-info-group" onclick="toggleStatusModal()">
            <div id="appbarCampus" class="appbar-campus"></div>
            <div class="appbar-center" id="appbarStatus">
                <div class="status-static">位置情報 取得中...</div>
            </div>
        </div>
        <div class="appbar-side">
            <a href="pre_index.html" class="icon-btn" title="出席認証">👤</a>
            <a href="pre_settings.html" class="icon-btn" title="設定">⚙️</a>
            <button class="icon-btn" title="ログアウト" onclick="logoutUser()">🚪</button>
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
//   ★認証関連機能 (OpenID Connect: Discord)
// ==========================================

function loginWithDiscord() {
    // ★修正: カスタムプロバイダ 'oidc.discord' を使用
    const provider = new firebase.auth.OAuthProvider('oidc.discord');
    provider.addScope('identify');
    
    auth.signInWithPopup(provider)
        .then((result) => {
            const user = result.user;
            console.log("Login success:", user);
            
            db.collection('users').doc(user.uid).set({
                displayName: user.displayName || "No Name",
                email: user.email || "",
                photoURL: user.photoURL || "",
                lastLogin: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            window.location.href = 'pre_home.html';
        })
        .catch((error) => {
            console.error("Login Error:", error);
            const errorEl = document.getElementById('errorMsg');
            if(errorEl) errorEl.textContent = "ログイン失敗: " + error.message;
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
    
    if (!statusEl || !registeredGpsAreas || !registeredCampuses || registeredCampuses.length === 0) return;

    const render = (campusName, areas) => {
        campusEl.textContent = campusName;
        if (areas.length === 0) {
            statusEl.innerHTML = '<div class="status-static">活動なし</div>';
        } else if (areas.length === 1) {
            statusEl.innerHTML = `<div class="status-static">📍 ${areas[0].name}</div>`;
        } else {
            const text = areas.map(a => a.name).join("　　"); 
            statusEl.innerHTML = `<div class="status-marquee">${text}　　　${text}</div>`;
        }
        const modalContent = document.getElementById('statusDetailContent');
        if (areas.length === 0) {
            modalContent.innerHTML = `<p>${campusName} で活動中の場所はありません。</p>`;
        } else {
            modalContent.innerHTML = areas.map(a => `
                <div class="detail-item">
                    <span class="detail-badge">活動中</span>
                    <strong>${campusName}</strong> - ${a.name}
                </div>
            `).join('');
        }
    };

    if (!navigator.geolocation) {
        render("GPS不可", []);
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const uLat = pos.coords.latitude;
            const uLon = pos.coords.longitude;
            let nearest = null;
            let minDist = Infinity;
            registeredCampuses.forEach(c => {
                const dist = getDistance(uLat, uLon, c.lat, c.lon);
                if (dist < minDist) { minDist = dist; nearest = c; }
            });

            if (nearest) {
                const targetAreas = registeredGpsAreas.filter(a => a.isActive && a.campusId === nearest.id);
                render(nearest.name, targetAreas);
            } else {
                render("キャンパス外", []);
            }
        },
        (err) => {
            console.warn("Location error:", err);
            const allActive = registeredGpsAreas.filter(a => a.isActive);
            render("全キャンパス", allActive);
        },
        { timeout: 5000 }
    );
}

// ==========================================
//   共通データ読み込み & ヘルパー
// ==========================================

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
    console.log("顔データを読み込み中...");
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
                         registeredFaces.push({
                             docId: doc.id,
                             label: data.label,
                             thumbnail: data.thumbnail || null,
                             descriptor: float32
                         });
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
        console.log("AI Models Loaded");
    } catch(e) {
        console.error("Model Load Error:", e);
    }
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2) * Math.sin(Δλ/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

// 汎用プロキシ関数 (ニュース取得などで使用)
async function fetchWithProxy(targetUrl) {
    const proxies = [
        (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    ];
    let lastError = null;
    for (const proxyFunc of proxies) {
        try {
            const res = await fetch(proxyFunc(targetUrl));
            if (!res.ok) throw new Error(`Status ${res.status}`);
            return await res.json();
        } catch (e) { lastError = e; }
    }
    throw lastError;
}

// ==========================================
//   ニュース機能 (カルーセルUI & タブ & 管理者機能)
// ==========================================

async function loadHomeNews() {
    console.log("ニュース読み込み開始...");

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
        } catch(e) { 
            console.error(e); 
            slideRec.innerHTML = '<p>読み込みエラー</p>'; 
        }
    }

    const slideTrend = document.getElementById('slide-trend');
    if (slideTrend) {
        try {
            const targetUrl = 'https://qiita.com/api/v2/items?page=1&per_page=20&query=stocks:>20';
            const data = await fetchWithProxy(targetUrl);
            let items = [];
            if (data && data.length > 0) {
                items = data.map(item => ({
                    title: item.title,
                    url: item.url,
                    badge: 'Qiita',
                    color: '#55c500',
                    author: (item.user ? item.user.id : 'unknown')
                }));
            }
            renderNewsSlide(slideTrend, "📈 Qiitaトレンド", "⬅ 管理者おすすめ", items, 0);
        } catch(e) {
            console.error(e);
            slideTrend.innerHTML = '<p style="color:red">取得失敗: 通信環境を確認してください</p>';
        }
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

    if (items.length === 0) {
        container.innerHTML += '<p>記事がありません</p>';
        return;
    }

    const listId = `list-${Math.random().toString(36).substr(2, 9)}`;
    
    if (items.length > 5) {
        const topToggle = document.createElement('button');
        topToggle.className = 'toggle-btn';
        topToggle.textContent = "🔽 もっと見る (全表示)";
        topToggle.onclick = () => toggleNewsItems(listId, topToggle);
        container.appendChild(topToggle);
    }

    const listDiv = document.createElement('div');
    listDiv.id = listId;
    listDiv.className = 'news-list';

    items.forEach((item, index) => {
        const div = createNewsItem(item.title, item.url, item.badge, item.color, item.author);
        if (index >= 5) div.classList.add('hidden-item');
        listDiv.appendChild(div);
    });
    container.appendChild(listDiv);

    if (items.length > 5) {
        const bottomToggle = document.createElement('button');
        bottomToggle.className = 'toggle-btn';
        bottomToggle.textContent = "🔽 もっと見る (全表示)";
        bottomToggle.onclick = () => toggleNewsItems(listId, bottomToggle);
        container.appendChild(bottomToggle);
    }
}

function toggleNewsItems(listId, btn) {
    const list = document.getElementById(listId);
    const isExpanded = !list.children[5].classList.contains('hidden-item');

    if (isExpanded) {
        Array.from(list.children).forEach((child, i) => {
            if (i >= 5) child.classList.add('hidden-item');
        });
        updateToggleButtons(list.parentElement, "🔽 もっと見る");
    } else {
        Array.from(list.children).forEach(child => {
            child.classList.remove('hidden-item');
        });
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

// エラー解消: 管理者おすすめ記事の読み込み
async function loadAdminRecommendedArticles() {
    const listEl = document.getElementById('adminNewsList');
    if (!listEl) return;
    
    listEl.innerHTML = '<p>読み込み中...</p>';
    try {
        const snap = await db.collection('recommended_news').orderBy('timestamp', 'desc').get();
        listEl.innerHTML = '';
        if (snap.empty) {
            listEl.innerHTML = '<p>登録済み記事はありません</p>';
            return;
        }
        snap.forEach(doc => {
            const d = doc.data();
            const div = document.createElement('div');
            div.className = 'list-item-row';
            div.style.padding = "10px 0";
            div.style.borderBottom = "1px solid #eee";
            div.style.display = "flex";
            div.style.alignItems = "center";
            div.style.justifyContent = "space-between";
            div.innerHTML = `
                <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    <a href="${d.url}" target="_blank" style="font-weight:bold; text-decoration:none; color:#333;">${d.title}</a>
                </div>
                <button class="btn-danger" onclick="deleteRecommendedArticle('${doc.id}')" style="margin-left:10px;">削除</button>
            `;
            listEl.appendChild(div);
        });
    } catch (e) {
        console.error(e);
        listEl.innerHTML = '<p>読み込みエラー</p>';
    }
}

async function deleteRecommendedArticle(docId) {
    if (!confirm("この記事を削除しますか？")) return;
    try {
        await db.collection('recommended_news').doc(docId).delete();
        loadAdminRecommendedArticles(); 
    } catch (e) { alert("削除エラー: " + e.message); }
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
            title: data.title,
            url: data.url,
            itemId: itemId,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });

        alert(`追加しました: ${data.title}`);
        input.value = "";
        loadAdminRecommendedArticles();

    } catch(e) {
        console.error(e);
        alert("エラー: " + e.message);
    }
}

// ==========================================
//   管理者: ステータスタブ (Status)
// ==========================================

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    if (event && event.target) event.target.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

function switchAdminSubTab(tab) {
    const authView = document.getElementById('view-auth');
    const reportView = document.getElementById('view-report');
    const btnAuth = document.getElementById('btn-sub-auth');
    const btnReport = document.getElementById('btn-sub-report');

    if (tab === 'auth') {
        authView.style.display = 'block';
        reportView.style.display = 'none';
        btnAuth.classList.add('active');
        btnReport.classList.remove('active');
        refreshRequests();
    } else {
        authView.style.display = 'none';
        reportView.style.display = 'block';
        btnAuth.classList.remove('active');
        btnReport.classList.add('active');
        refreshReports();
    }
}

// 認証リクエスト一覧
async function refreshRequests() {
    const listEl = document.getElementById('requestList');
    listEl.innerHTML = '<p>読み込み中...</p>';
    
    try {
        const snapshot = await db.collection('auth_requests')
            .where('status', '==', 'pending')
            .orderBy('requestTimestamp', 'desc')
            .get();
            
        listEl.innerHTML = '';
        if (snapshot.empty) {
            listEl.innerHTML = '<p>リクエストはありません</p>';
            return;
        }
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.requestTimestamp ? data.requestTimestamp.toDate().toLocaleString() : '';
            const item = document.createElement('div');
            item.className = 'item-card';
            item.innerHTML = `
                <div>
                    <strong>${data.userName}</strong><br>
                    <small>${date}</small><br>
                    <span style="font-size:0.8em; color:#666;">Type: ${data.authType}</span>
                </div>
                <button onclick="openAuthModal('${doc.id}', '${data.userName}', '${data.authType}')">認証へ</button>
            `;
            listEl.appendChild(item);
        });
    } catch(e) {
        listEl.innerHTML = '<p>エラーが発生しました</p>';
        console.error(e);
    }
}

// 届出リスト一覧
async function refreshReports() {
    const listEl = document.getElementById('reportList');
    listEl.innerHTML = '<p>読み込み中...</p>';
    
    try {
        const snapshot = await db.collection('absence_reports')
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
            
        listEl.innerHTML = '';
        if (snapshot.empty) { listEl.innerHTML = '<p>届出なし</p>'; return; }
        
        snapshot.forEach(doc => {
            const d = doc.data();
            const startStr = d.startDate ? d.startDate.toDate().toLocaleString() : '未定';
            const endStr = d.endDate ? d.endDate.toDate().toLocaleString() : '';
            const periodStr = endStr ? `${startStr} 〜 ${endStr}` : `${startStr} 〜`;

            const typeLabel = { 'absence':'欠席', 'late':'遅刻', 'early':'早退' }[d.type] || d.type;
            const statusLabel = { 'pending':'未承認', 'approved':'承認済', 'confirm':'要確認', 'rejected':'否認' }[d.status] || d.status;
            
            let badgeColor = "#666";
            if(d.status==='approved') badgeColor="#007bff"; 
            if(d.status==='confirm') badgeColor="#ffc107";  
            if(d.status==='rejected') badgeColor="#dc3545"; 

            const div = document.createElement('div');
            div.className = 'item-card';
            div.style.display = 'block';
            div.style.padding = '0'; 
            div.style.overflow = 'hidden'; 

            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; background-color:#eeeeee; padding:10px; border-bottom:1px solid #ddd;">
                    <strong>${d.userName}</strong>
                    <span style="background:${badgeColor}; color:white; padding:2px 8px; border-radius:4px; font-size:0.8em;">${statusLabel}</span>
                </div>
                
                <div style="padding:10px;">
                    <div style="font-size:0.9em; margin-bottom:5px;">
                        <span style="color:#007bff; font-weight:bold;">[${typeLabel}]</span> <br>
                        期間: <b>${periodStr}</b><br>
                        理由: ${d.reason}
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
    } catch(e) {
        listEl.innerHTML = '<p>エラー</p>';
        console.error(e);
    }
}

async function updateReportStatus(docId, st) {
    if(!confirm('ステータスを変更しますか？')) return;
    await db.collection('absence_reports').doc(docId).update({ status: st });
    refreshReports();
}

// --- 認証モーダル処理 ---
async function openAuthModal(reqId, userName, authTypeString) {
    currentRequestId = reqId;
    adminAuthStep = 0;
    colorMatchCounter = 0;
    
    const parts = authTypeString.split(',');
    const targetCode = parts[0].includes('code') && parts.length >= 5 ? parts.slice(1, 5) : [];
    
    const registered = registeredFaces.find(f => f.label === userName);
    
    currentAuthUser = {
        name: userName,
        targetCode: targetCode,
        descriptor: registered ? registered.descriptor : null
    };

    const modal = document.getElementById('authModal');
    modal.style.display = 'block';
    updateAdminStatus("コードを枠に合わせてください (安定するまで待機)");
    document.getElementById('approveBtn').disabled = true;
    
    const video = document.getElementById('adminVideo');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            processAdminFrame();
        };
    } catch(e) {
        alert("カメラ起動エラー: " + e.message);
    }
}

function closeAuthModal() {
    document.getElementById('authModal').style.display = 'none';
    const video = document.getElementById('adminVideo');
    if (video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
    if (adminGuideLoopId) {
        cancelAnimationFrame(adminGuideLoopId);
        adminGuideLoopId = null;
    }
}

function updateAdminStatus(msg) {
    document.getElementById('modalTitle').textContent = `${currentAuthUser ? currentAuthUser.name : ''} 認証 (Step ${adminAuthStep+1}/2)`;
    document.getElementById('adminAuthStatus').textContent = msg;
}

async function processAdminFrame() {
    const canvas = document.getElementById('adminCanvas');
    const video = document.getElementById('adminVideo');
    const modal = document.getElementById('authModal');

    if (modal.style.display === 'none' || !canvas || !video || video.paused || video.ended) return;

    if (video.videoWidth > 0 && canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.drawImage(video, 0, 0, w, h);

    if (adminAuthStep === 0) {
        if (currentAuthUser.targetCode.length === 4) {
            const detectedCode = scanColors(ctx, w, h);
            ctx.font = "20px Arial"; ctx.fillStyle = "white";
            ctx.fillText(`Detected: ${detectedCode.join(' ')}`, 10, 30);

            if (isCodeMatch(detectedCode, currentAuthUser.targetCode)) {
                colorMatchCounter++;
                if (colorMatchCounter > 10) {
                    adminAuthStep = 1;
                    updateAdminStatus("コード一致！ 次は「顔」を映してください");
                }
            } else {
                colorMatchCounter = Math.max(0, colorMatchCounter - 1);
            }
        } else {
             adminAuthStep = 1; 
        }

    } else if (adminAuthStep === 1) {
        if (currentAuthUser.descriptor) {
            try {
                const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                    .withFaceLandmarks()
                    .withFaceDescriptor();
                
                if (detection) {
                    const dist = faceapi.euclideanDistance(detection.descriptor, currentAuthUser.descriptor);
                    const box = detection.detection.box;
                    const drawBox = new faceapi.draw.DrawBox(box, { label: `Diff: ${dist.toFixed(2)}` });
                    drawBox.draw(canvas);

                    if (dist < 0.6) {
                        adminAuthStep = 2;
                        updateAdminStatus("本人確認完了！ 承認可能です");
                        document.getElementById('approveBtn').disabled = false;
                        document.getElementById('approveBtn').style.backgroundColor = "#28a745";
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
    const offsetX = (w - refW * scale) / 2;
    const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: Math.floor(offsetX + x * scale), y: Math.floor(offsetY + y * scale) });

    const points = [ t(55, 85), t(115, 55), t(115, 105), t(175, 85) ];
    const imageData = ctx.getImageData(0, 0, w, h).data;
    return points.map(p => {
        const i = (p.y * w + p.x) * 4;
        return classifyColor(imageData[i], imageData[i+1], imageData[i+2]);
    });
}

function classifyColor(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
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
    const offsetX = (w - refW * scale) / 2;
    const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY });

    ctx.lineWidth = 4; ctx.lineCap = "round";
    const alpha = step === 0 ? 1.0 : 0.2;
    
    ctx.strokeStyle = `rgba(255, 0, 0, ${alpha})`;
    ctx.beginPath();
    let p = t(30, 50); ctx.moveTo(p.x, p.y); p = t(30, 30); ctx.lineTo(p.x, p.y); p = t(50, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath();
    p = t(200, 50); ctx.moveTo(p.x, p.y); p = t(200, 30); ctx.lineTo(p.x, p.y); p = t(180, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    
    ctx.strokeStyle = `rgba(0, 0, 255, ${alpha})`;
    ctx.beginPath();
    p = t(30, 120); ctx.moveTo(p.x, p.y); p = t(30, 140); ctx.lineTo(p.x, p.y); p = t(50, 140); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath();
    p = t(200, 120); ctx.moveTo(p.x, p.y); p = t(200, 140); ctx.lineTo(p.x, p.y); p = t(180, 140); ctx.lineTo(p.x, p.y); ctx.stroke();

    if (step === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        const fillRect = (x1,y1,x2,y2) => {
            const s = t(x1,y1); const e = t(x2,y2);
            ctx.fillRect(s.x, s.y, e.x - s.x, e.y - s.y);
        };
        fillRect(70, 40, 80, 130);
        fillRect(80, 70, 150, 80);
        fillRect(150, 40, 160, 130);
        
        if (colorMatchCounter > 0) {
            ctx.fillStyle = "#00ff00";
            ctx.fillRect(10, h - 20, (w - 20) * (colorMatchCounter / 10), 10);
        }
    }
}

async function approveRequest() {
    if(!currentRequestId) return;
    try {
        await db.collection('auth_requests').doc(currentRequestId).update({
            status: 'approved',
            approvalTimestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        await db.collection('attendance_logs').add({
            userName: currentAuthUser.name,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            adminId: 'web_admin'
        });
        alert('承認しました');
        closeAuthModal();
        refreshRequests();
    } catch(e) { alert('エラー: ' + e.message); }
}

// ==========================================
//   管理者: 登録情報 (Info)
// ==========================================

async function registerCampus() {
    const name = document.getElementById('campusName').value;
    const lat = parseFloat(document.getElementById('campusLat').value);
    const lon = parseFloat(document.getElementById('campusLon').value);
    if(!name || isNaN(lat)) return;
    
    await db.collection('campuses').add({ name, lat, lon });
    await loadCampuses();
    populateInfoLists();
    alert("キャンパスを登録しました");
}

async function registerArea() {
    const campusId = document.getElementById('campusSelect').value;
    const name = document.getElementById('areaName').value;
    const lat = parseFloat(document.getElementById('areaLat').value);
    const lon = parseFloat(document.getElementById('areaLon').value);
    if(!name || isNaN(lat) || !campusId) return alert("入力が不足しています");
    
    // ドキュメントIDを「名前」にする (toggleAreaActiveは名前をIDとして受け取るため)
    await db.collection('gps_areas').doc(name).set({ name, campusId, lat, lon, isActive: false });
    await loadGpsAreas();
    populateInfoLists();
    alert("活動場所を登録しました");
}

function populateInfoLists() {
    const select = document.getElementById('campusSelect');
    if(select) {
        select.innerHTML = '<option value="">キャンパスを選択</option>';
        registeredCampuses.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id; opt.innerText = c.name;
            select.appendChild(opt);
        });
    }

    const hierList = document.getElementById('hierarchyList');
    if(hierList) {
        hierList.innerHTML = '';
        if (registeredCampuses.length === 0) {
            hierList.innerHTML = '<p>登録なし</p>';
        } else {
            registeredCampuses.forEach(campus => {
                const areas = registeredGpsAreas.filter(a => a.campusId === campus.id);
                
                const details = document.createElement('details');
                const summary = document.createElement('summary');
                summary.innerHTML = `
                    <div style="display:flex; align-items:center; gap:10px;">
                        <input type="checkbox" class="chk-campus" value="${campus.id}">
                        <span>🏢 ${campus.name} <small>(${areas.length})</small></span>
                    </div>
                `;
                
                const content = document.createElement('div');
                content.className = 'details-content';
                
                if (areas.length > 0) {
                    const actionDiv = document.createElement('div');
                    actionDiv.style.display = 'flex';
                    actionDiv.style.justifyContent = 'flex-end';
                    actionDiv.style.gap = '10px';
                    actionDiv.style.marginBottom = '10px';
                    actionDiv.innerHTML = `
                        <small>エリア操作:</small>
                        <button class="btn-danger" onclick="deleteSelectedAreas('${campus.id}')">選択削除</button>
                        <button class="btn-danger" onclick="deleteAllAreasInCampus('${campus.id}')">全削除</button>
                    `;
                    content.appendChild(actionDiv);

                    areas.forEach(area => {
                        const row = document.createElement('div');
                        row.className = 'list-item-row nested-area';
                        if(area.isActive) row.style.backgroundColor = '#e6ffec';
                        
                        row.innerHTML = `
                            <div class="checkbox-wrapper">
                                <input type="checkbox" class="chk-area-${campus.id}" value="${area.name}">
                                <div>
                                    <strong>📍 ${area.name}</strong> <small>(${area.lat}, ${area.lon})</small><br>
                                    状態: ${area.isActive ? '<b style="color:green">ON</b>' : '<b style="color:gray">OFF</b>'}
                                </div>
                            </div>
                            <div>
                                <button onclick="toggleAreaActive('${area.name}', ${area.isActive})" style="font-size:0.8em; margin-right:5px;">切替</button>
                                <button class="btn-danger" onclick="deleteItem('gps_areas', '${area.name}')">削除</button>
                            </div>
                        `;
                        content.appendChild(row);
                    });
                } else {
                    content.innerHTML = '<div style="padding:10px; color:#999;">(活動場所なし)</div>';
                }
                
                details.appendChild(summary);
                details.appendChild(content);
                hierList.appendChild(details);
            });
        }
    }
    populateFaceList();
}

async function toggleAreaActive(docId, currentStatus) {
    try {
        await db.collection('gps_areas').doc(docId).update({ isActive: !currentStatus });
        await loadGpsAreas(); // データを再ロード
        populateInfoLists();  // リストを更新
    } catch(e) {
        console.error(e);
        alert("更新エラー: " + e.message);
    }
}

function populateFaceList() {
    const el = document.getElementById('faceList');
    if(!el) return;
    el.innerHTML = '';
    
    if (registeredFaces.length === 0) {
        el.innerHTML = '<p>顔データなし</p>';
        return;
    }

    registeredFaces.forEach(f => {
        const div = document.createElement('div');
        div.className = 'list-item-row';
        div.style.padding = '10px';
        
        div.innerHTML = `
            <div class="checkbox-wrapper">
                <input type="checkbox" class="chk-face" value="${f.docId}">
                <div style="width:40px; height:40px; background:#ddd; border-radius:50%; overflow:hidden;">
                    ${f.thumbnail ? `<img src="${f.thumbnail}" style="width:100%; height:100%; object-fit:cover;">` : '👤'}
                </div>
                <strong>${f.label}</strong>
            </div>
            <button class="btn-danger" onclick="deleteItem('faces', '${f.docId}')">削除</button>
        `;
        el.appendChild(div);
    });
}

// --- 削除ロジック ---
async function deleteItem(collection, id) {
    if(!confirm('本当に削除しますか？')) return;
    try {
        await db.collection(collection).doc(id).delete();
        await reloadAllData();
    } catch(e) { alert("削除エラー: "+e.message); }
}

async function deleteSelectedItems(type) {
    let inputs, collection;
    if (type === 'campuses') {
        inputs = document.querySelectorAll('.chk-campus:checked');
        collection = 'campuses';
    } else if (type === 'faces') {
        inputs = document.querySelectorAll('.chk-face:checked');
        collection = 'faces';
    }

    if (inputs.length === 0) return alert("選択されていません");
    if (!confirm(`${inputs.length}件のデータを削除しますか？`)) return;

    try {
        const batch = db.batch();
        inputs.forEach(input => {
            const ref = db.collection(collection).doc(input.value);
            batch.delete(ref);
        });
        await batch.commit();
        alert("削除しました");
        await reloadAllData();
    } catch(e) { alert("削除エラー: " + e.message); }
}

async function deleteSelectedAreas(campusId) {
    const inputs = document.querySelectorAll(`.chk-area-${campusId}:checked`);
    if (inputs.length === 0) return alert("選択されていません");
    if (!confirm(`${inputs.length}件の活動場所を削除しますか？`)) return;

    try {
        const batch = db.batch();
        inputs.forEach(input => {
            const ref = db.collection('gps_areas').doc(input.value);
            batch.delete(ref);
        });
        await batch.commit();
        alert("削除しました");
        await reloadAllData();
    } catch(e) { alert("削除エラー: " + e.message); }
}

async function deleteAllAreasInCampus(campusId) {
    if (!confirm("このキャンパスに紐付く全ての活動場所を削除しますか？")) return;
    try {
        const snap = await db.collection('gps_areas').where('campusId', '==', campusId).get();
        const batch = db.batch();
        snap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        alert("削除しました");
        await reloadAllData();
    } catch(e) { alert("削除エラー: " + e.message); }
}

async function deleteAll(collection) {
    if(!confirm(`「${collection}」の全データを削除します。よろしいですか？`)) return;
    try {
        const snap = await db.collection(collection).get();
        const batch = db.batch();
        snap.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        alert("全削除しました");
        await reloadAllData();
    } catch(e) { alert("全削除エラー: "+e.message); }
}

async function reloadAllData() {
    await loadCampuses();
    await loadGpsAreas();
    await loadRegisteredFaces();
    populateInfoLists();
}


// ==========================================
//   管理者: 顔登録機能 (手動進行・精度向上)
// ==========================================

async function startFaceRegistration() {
    const name = document.getElementById('regName').value.trim();
    if(!name) return alert("登録名を入力してください");
    
    // ★追加: 名前を保存
    saveUserName(name);

    const statusEl = document.getElementById('regStatus');
    const startBtn = document.getElementById('regStartBtn');
    const nextBtn = document.getElementById('regNextBtn');
    
    startBtn.disabled = true;
    nextBtn.disabled = true;
    nextBtn.style.backgroundColor = "#ccc";
    nextBtn.textContent = "検出中...";
    
    // リセット
    regStep = 1;
    regDescriptors = [];
    regThumbnail = "";
    currentDetection = null;
    faceStableCount = 0;
    lastDetectedDesc = null;
    missedFrameCount = 0;
    
    const video = document.getElementById('regVideo');
    const canvas = document.getElementById('regCanvas');

    try {
        await loadModels();
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        regStream = stream;
        video.srcObject = stream;

        video.onloadedmetadata = () => {
            video.play();
            statusEl.textContent = `Step 1/5: ${REG_INSTRUCTIONS[1]}`;
            // 検出ループ開始
            detectFaceLoopManual(video, canvas);
        };
    } catch(e) {
        alert("カメラエラー: " + e.message);
        startBtn.disabled = false;
    }
}

// 常時検出ループ（安定性チェック付き）
async function detectFaceLoopManual(video, canvas) {
    if (regStep > 5 || !regStream || !regStream.active) return;

    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    faceapi.matchDimensions(canvas, displaySize);

    const statusEl = document.getElementById('regStatus');
    const nextBtn = document.getElementById('regNextBtn');

    try {
        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptor();

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (detection && detection.detection.score > 0.85) {
            const resized = faceapi.resizeResults(detection, displaySize);
            faceapi.draw.drawDetections(canvas, resized);
            
            // ★安定性チェック: 同一人物らしき顔が連続しているか
            let isSamePerson = false;
            if (lastDetectedDesc) {
                const dist = faceapi.euclideanDistance(detection.descriptor, lastDetectedDesc);
                if (dist < 0.4) isSamePerson = true; // 閾値
            } else {
                isSamePerson = true; // 初回
            }

            if (isSamePerson) {
                faceStableCount++;
                missedFrameCount = 0;
                lastDetectedDesc = detection.descriptor;
            } else {
                faceStableCount = 0; // 違う顔になったらリセット
                lastDetectedDesc = detection.descriptor;
            }

            // 5フレーム以上安定したらボタン有効化
            if (faceStableCount > 5) {
                currentDetection = detection;
                nextBtn.disabled = false;
                nextBtn.style.backgroundColor = "#28a745"; // 緑
                nextBtn.textContent = "撮影・次へ";
                statusEl.style.color = "green";
                statusEl.textContent = `OK! ボタンを押してください (${REG_INSTRUCTIONS[regStep]})`;
            } else {
                // 安定待ち
                statusEl.style.color = "#007bff";
                statusEl.textContent = `検出中... 顔を動かさないでください (${faceStableCount}/5)`;
            }

        } else {
            // 顔が見つからない場合
            missedFrameCount++;
            // 多少のフレーム抜け(10フレーム)は許容、それ以上でリセット
            if (missedFrameCount > 10) {
                faceStableCount = 0;
                lastDetectedDesc = null;
                currentDetection = null;
                
                nextBtn.disabled = true;
                nextBtn.style.backgroundColor = "#ccc";
                nextBtn.textContent = "検出中...";
                
                statusEl.style.color = "red";
                statusEl.textContent = `顔が見つかりません (${REG_INSTRUCTIONS[regStep]})`;
            }
        }
    } catch(e) { console.error(e); }

    setTimeout(() => detectFaceLoopManual(video, canvas), 100);
}

function proceedToNextStep() {
    if (!currentDetection) return;
    
    const video = document.getElementById('regVideo');
    const descBase64 = float32ToBase64(currentDetection.descriptor);
    regDescriptors.push(descBase64);

    if (regStep === 1) {
        const capCanvas = document.createElement('canvas');
        capCanvas.width = video.videoWidth;
        capCanvas.height = video.videoHeight;
        capCanvas.getContext('2d').drawImage(video, 0, 0);
        regThumbnail = capCanvas.toDataURL('image/jpeg', 0.7);
    }

    regStep++;
    // カウンタリセット
    faceStableCount = 0;
    lastDetectedDesc = null;
    currentDetection = null;
    
    if (regStep <= 5) {
        const statusEl = document.getElementById('regStatus');
        const nextBtn = document.getElementById('regNextBtn');
        nextBtn.disabled = true;
        nextBtn.style.backgroundColor = "#ccc";
        nextBtn.textContent = "検出中...";
        statusEl.style.color = "#007bff";
        statusEl.textContent = `Step ${regStep}/5: ${REG_INSTRUCTIONS[regStep]}`;
    } else {
        saveFaceDataManual();
    }
}

async function saveFaceDataManual() {
    const name = document.getElementById('regName').value.trim();
    const statusEl = document.getElementById('regStatus');
    const startBtn = document.getElementById('regStartBtn');
    const nextBtn = document.getElementById('regNextBtn');
    
    statusEl.textContent = "全ステップ完了！ 保存中...";
    nextBtn.disabled = true;
    nextBtn.textContent = "完了";

    try {
        await db.collection("faces").add({
            label: name,
            thumbnail: regThumbnail,
            descriptors: regDescriptors
        });
        
        alert(`登録完了: ${name}`);
        statusEl.textContent = "登録完了";
        document.getElementById('regName').value = "";
        
        await reloadAllData();

    } catch(e) {
        alert("保存エラー: " + e.message);
    }
    
    if (regStream) {
        regStream.getTracks().forEach(t => t.stop());
        regStream = null;
    }
    const ctx = document.getElementById('regCanvas').getContext('2d');
    ctx.clearRect(0, 0, 1000, 1000);
    startBtn.disabled = false;
}

function float32ToBase64(float32) {
    const buffer = float32.buffer;
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function toggleFormInputs() {
    const type = document.getElementById('reportType').value;
    const dateRangeBox = document.getElementById('input-date-range');
    const dateTimeBox = document.getElementById('input-datetime');
    
    if (type === 'absence') {
        dateRangeBox.style.display = 'block';
        dateTimeBox.style.display = 'none';
    } else {
        dateRangeBox.style.display = 'none';
        dateTimeBox.style.display = 'block';
    }
}

// 届出送信 (名前入力不要)
async function submitReport() {
    if (!currentUser) return alert("ログインしてください");
    const name = currentUser.displayName; // ★修正

    const type = document.getElementById('reportType').value;
    const reason = document.getElementById('reportReason').value.trim();
    const fileInput = document.getElementById('reportImage');
    
    if (!reason) return alert("理由を入力してください");

    let startDate = null;
    let endDate = null;

    if (type === 'absence') {
        const sVal = document.getElementById('reportStartDate').value;
        const eVal = document.getElementById('reportEndDate').value;
        if (!sVal) return alert("開始日を入力してください");
        startDate = new Date(sVal + 'T00:00:00');
        endDate = eVal ? new Date(eVal + 'T23:59:59') : new Date(sVal + 'T23:59:59');
    } else {
        const dtVal = document.getElementById('reportDateTime').value;
        if (!dtVal) return alert("日時を入力してください");
        startDate = new Date(dtVal);
        endDate = new Date(dtVal);
    }

    let imageBase64 = null;
    if (fileInput && fileInput.files[0]) {
        try {
            imageBase64 = await new Promise((resolve) => {
                const r = new FileReader();
                r.onload = e => resolve(e.target.result);
                r.readAsDataURL(fileInput.files[0]);
            });
        } catch(e) { return alert("画像読込エラー"); }
    }

    try {
        await db.collection('absence_reports').add({
            userName: name,
            type: type,
            reason: reason,
            startDate: firebase.firestore.Timestamp.fromDate(startDate),
            endDate: firebase.firestore.Timestamp.fromDate(endDate),
            attachment: imageBase64,
            status: 'pending',
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        alert("送信しました");
        document.getElementById('reportReason').value = "";
        document.getElementById('reportImage').value = "";
        document.getElementById('previewArea').innerHTML = "";
    } catch(e) {
        alert("送信エラー: " + e.message);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('reportImage');
    if (fileInput) {
        fileInput.addEventListener('change', function(e) {
            const area = document.getElementById('previewArea');
            area.innerHTML = "";
            if (this.files && this.files[0]) {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(this.files[0]);
                img.style.maxWidth = "100px";
                img.style.marginTop = "10px";
                area.appendChild(img);
            }
        });
    }
});

// ==========================================
//   ユーザー: 顔認証 (User)
// ==========================================

// 出席認証開始 (名前入力不要)
async function startUserAuthFlow() {
    if (!currentUser) return alert("ログイン情報が読み込まれていません。");
    const name = currentUser.displayName; // ★修正: Authから名前取得
    
    document.getElementById('step-0').classList.remove('active');
    document.getElementById('step-1').classList.add('active');
    
    if (!navigator.geolocation) return alert("位置情報が利用できません");

    navigator.geolocation.getCurrentPosition(async (pos) => {
        // (位置判定は既存ロジックのまま)
        const uLat = pos.coords.latitude;
        const uLon = pos.coords.longitude;
        let inArea = false;
        const activeAreas = registeredGpsAreas.filter(a => a.isActive);
        for(const area of activeAreas) {
            const dist = getDistance(uLat, uLon, area.lat, area.lon);
            if(dist <= 100) { inArea = true; break; }
        }
        if(!inArea) console.log("エリア外: Debug");
        
        startFaceAuth(name); 
    }, (err) => {
        alert("位置情報の取得に失敗しました: " + err.message);
    });
}

async function startFaceAuth(userName) {
    const statusEl = document.getElementById('userStatus');
    statusEl.textContent = "モデルを読み込み中...";
    
    isAuthCompleted = false;
    isDetectingLoop = false;
    
    stopFaceAuth();

    try {
        await loadModels();
        statusEl.textContent = "カメラを起動中...";
        
        const video = document.getElementById('userVideo');
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        currentStream = stream;
        video.srcObject = stream;
        
        video.addEventListener('play', async () => {
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            
            statusEl.textContent = "カメラ準備中... (安定まで待機)";
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (isAuthCompleted) return;
            statusEl.textContent = "顔を映してください...";

            const detectLoop = async () => {
                if (isAuthCompleted || video.paused || video.ended) return;
                
                if (isDetectingLoop) {
                    setTimeout(detectLoop, 100);
                    return;
                }

                isDetectingLoop = true;

                try {
                    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                        .withFaceLandmarks()
                        .withFaceDescriptors();
                    
                    if (isAuthCompleted) return;

                    const resizedDetections = faceapi.resizeResults(detections, displaySize);
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    faceapi.draw.drawDetections(canvas, resizedDetections);
                    
                    if (resizedDetections.length > 0) {
                        isAuthCompleted = true; 
                        statusEl.textContent = "顔を認識しました！";
                        
                        stopFaceAuth();
                        setTimeout(() => { requestAuth(userName); }, 500);
                        return;
                    }
                } catch (err) {
                    console.error("Detect Error:", err);
                } finally {
                    isDetectingLoop = false;
                }

                if (!isAuthCompleted) setTimeout(detectLoop, 200);
            };

            detectLoop();

        }, { once: true });
        
    } catch(e) {
        console.error(e);
        statusEl.textContent = "エラー: " + e.message;
        alert("カメラの起動に失敗しました");
    }
}

function stopFaceAuth() {
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
    const video = document.getElementById('userVideo');
    if (video) video.pause();
    const canvas = document.getElementById('userCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

async function requestAuth(userName) {
    document.getElementById('step-1').classList.remove('active');
    document.getElementById('step-2').classList.add('active');
    
    const colors = ['C', 'Y', 'M', 'G'];
    const myCode = [
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)]
    ];
    
    drawHCode(myCode);
    
    try {
        const docRef = await db.collection('auth_requests').add({
            userName: userName,
            authType: `code,${myCode.join(',')}`,
            status: 'pending',
            requestTimestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        myRequestId = docRef.id;
        document.getElementById('requestStatus').textContent = "リクエスト送信完了。承認待ち...";
    } catch(e) {
        alert("リクエスト送信エラー: " + e.message);
    }
}

async function checkRequestStatus() {
    if(!myRequestId) return;
    try {
        const doc = await db.collection('auth_requests').doc(myRequestId).get();
        if(doc.data().status === 'approved') {
            document.getElementById('step-2').classList.remove('active');
            document.getElementById('step-3').classList.add('active');
        } else {
            alert('まだ承認されていません');
        }
    } catch(e) { console.error(e); }
}

function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    const baseW = 230;
    const baseH = 170;

    const scale = Math.min(w / baseW, h / baseH);
    const dx = (w - (baseW * scale)) / 2;
    const dy = (h - (baseH * scale)) / 2;

    const r = (x, y, rw, rh) => [dx + (x * scale), dy + (y * scale), rw * scale, rh * scale];

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000000";
    ctx.fillRect(...r(0, 0, baseW, baseH));

    ctx.fillStyle = "#FF0000";
    ctx.fillRect(...r(20, 20, 55, 55));
    ctx.fillRect(...r(155, 20, 55, 55));
    ctx.fillRect(...r(75, 130, 80, 10));

    ctx.fillStyle = "#0000FF";
    ctx.fillRect(...r(20, 75, 55, 75));
    ctx.fillRect(...r(155, 75, 55, 75));

    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * scale;
    ctx.strokeRect(...r(30, 30, 170, 110));

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(...r(40, 40, 150, 90));

    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };
    
    ctx.fillStyle = colorMap[codes[0]]; ctx.fillRect(...r(40, 40, 30, 90));
    ctx.fillStyle = colorMap[codes[1]]; ctx.fillRect(...r(80, 40, 70, 30));
    ctx.fillStyle = colorMap[codes[2]]; ctx.fillRect(...r(80, 80, 70, 50));
    ctx.fillStyle = colorMap[codes[3]]; ctx.fillRect(...r(160, 40, 30, 90));
}

// ==========================================
//   出席履歴確認 (Check)
// ==========================================

// 履歴確認 (名前入力不要)
async function checkAttendance() {
    if (!currentUser) return;
    const name = currentUser.displayName; // ★修正
    
    const resultEl = document.getElementById('resultArea');
    if(resultEl) resultEl.style.display = 'block';
    
    try {
        const logSnap = await db.collection('attendance_logs')
            .where('userName', '==', name)
            .orderBy('timestamp', 'desc')
            .get();
            
        checkHistoryDates = [];
        logSnap.forEach(doc => {
            checkHistoryDates.push(doc.data().timestamp.toDate());
        });

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
        
        updateTodayStatus();
        checkDisplayDate = new Date();
        renderCalendar();
        
    } catch(e) {
        console.error(e);
        if(e.code === 'failed-precondition') {
            console.log("インデックス構築待ち...");
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