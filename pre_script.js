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

// --- グローバル変数 ---
let registeredCampuses = [];
let registeredGpsAreas = [];
let registeredFaces = [];
let faceMatcher = null;
let currentStream = null;
let detectionInterval = null; // 検出ループ用

// H型カラーコード用定数
const COLORS = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#008000' };

// --- 初期化 (ページ読み込み時) ---
window.onload = async () => {
    const bodyId = document.body.id;
    
    // 共通データ読み込み
    await loadCampuses();
    await loadGpsAreas();
    
    if (bodyId === 'page-admin') {
        await loadRegisteredFaces(); // 管理者用
        refreshRequests();
        populateInfoLists();
        populateFaceList();
    } else if (bodyId === 'page-user') {
        // ユーザー用は認証開始時に読み込む
    } else if (bodyId === 'page-check') {
        // 出席確認用
    }
};

// ==========================================
//   共通ヘルパー & 読み込み
// ==========================================

async function loadCampuses() {
    try {
        const snap = await db.collection('campuses').get();
        registeredCampuses = [];
        snap.forEach(doc => {
            registeredCampuses.push({ id: doc.id, ...doc.data() });
        });
    } catch(e) { console.error("キャンパス読込エラー", e); }
}

async function loadGpsAreas() {
    try {
        const snap = await db.collection('gps_areas').get();
        registeredGpsAreas = [];
        snap.forEach(doc => {
            registeredGpsAreas.push(doc.data());
        });
    } catch(e) { console.error("エリア読込エラー", e); }
}

// 顔データ読み込み (Web版face-api.js用)
// ※Flutter版のデータ(192次元)はWeb版(128次元)と互換性がないため、
// Web版で登録されたデータのみを読み込むか、簡易的に名前照合のみにする等の対応が必要。
// 今回は「Web版で登録されたデータがあれば読み込む」形にします。
async function loadRegisteredFaces() {
    console.log("顔データを読み込み中...");
    try {
        const snapshot = await db.collection("faces").get();
        if (snapshot.empty) {
            console.log("登録済みの顔はありません。");
            registeredFaces = [];
            return;
        }

        const loadedFaces = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // データ形式チェック (Web版かFlutter版か)
            // Web版は descriptorArray を JSON.stringify して保存している想定
            // または Float32Array を Base64化しているが、次元数が違う
            
            // 簡易実装: ここでは詳細な互換性チェックを省略し、データがあれば読み込む
            // 実運用では `platform: 'web'` フィールドなどで区別することを推奨
            
            loadedFaces.push({
                label: data.label,
                thumbnail: data.thumbnail,
                // descriptors: ... (Webでの照合には128次元のFloat32Arrayが必要)
            });
        });
        
        registeredFaces = loadedFaces;
        console.log(`${registeredFaces.length} 件の顔データを読み込みました。`);
        
        // FaceMatcher構築 (データが正しい形式なら)
        // rebuildFaceMatcher(); 

    } catch (e) {
        console.error("顔データ読み込み失敗:", e);
        registeredFaces = [];
    }
}

// モデル読み込み
async function loadModels() {
    // モデルファイルのパスは環境に合わせて調整してください
    // (例: ./models フォルダにある場合)
    const MODEL_URL = './models'; 
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    console.log("AIモデル読み込み完了");
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; 
  const φ1 = lat1 * Math.PI/180, φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180, Δλ = (lon2-lon1) * Math.PI/180;
  const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2) * Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}


// ==========================================
//   ユーザー機能 (User)
// ==========================================

async function startUserAuthFlow() {
    const name = document.getElementById('userNameInput').value.trim();
    if (!name) return alert("名前を入力してください");
    
    document.getElementById('step-0').classList.remove('active');
    document.getElementById('step-1').classList.add('active');
    
    // 1. GPSチェック
    navigator.geolocation.getCurrentPosition(async (pos) => {
        const uLat = pos.coords.latitude;
        const uLon = pos.coords.longitude;
        
        let inArea = false;
        // 活動中のエリアかつ100m以内
        const activeAreas = registeredGpsAreas.filter(a => a.isActive);
        for(const area of activeAreas) {
            const dist = getDistance(uLat, uLon, area.lat, area.lon);
            if(dist <= 100) { inArea = true; break; }
        }
        
        if(!inArea) {
            // エリア外でもデバッグ用に進める場合はコメントアウト
            // alert("エリア外です。活動場所の近くで認証してください。"); return; 
            console.log("エリア外(デバッグ通過)");
        }
        
        // 2. 顔認証開始
        startFaceAuth(name);

    }, (err) => alert("位置情報エラー: " + err.message));
}

let isAuthCompleted = false; // 二重送信防止用フラグ
let isDetectingLoop = false;

// 顔認証処理
async function startFaceAuth(userName) {
    const statusEl = document.getElementById('userStatus');
    statusEl.textContent = "モデルを読み込み中...";
    
    // フラグのリセット
    isAuthCompleted = false;
    isDetectingLoop = false;
    
    // 既存のループがあれば停止
    stopFaceAuth();

    try {
        await loadModels();
        statusEl.textContent = "カメラを起動中...";
        
        const video = document.getElementById('userVideo');
        
        // カメラ権限取得
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        currentStream = stream;
        video.srcObject = stream;
        
        // ★修正: イベントが重複しないよう { once: true } を付与
        video.addEventListener('play', () => {
            statusEl.textContent = "顔を映してください...";
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            
            // 検出ループ開始関数
            const detectLoop = async () => {
                // 完了済み、またはビデオが停止していたら終了
                if (isAuthCompleted || video.paused || video.ended) return;
                
                // 前回の処理が終わっていない場合はスキップ（多重実行防止）
                if (isDetectingLoop) {
                    setTimeout(detectLoop, 100); // 少し待って再トライ
                    return;
                }

                isDetectingLoop = true; // ロック開始

                try {
                    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                        .withFaceLandmarks()
                        .withFaceDescriptors();
                    
                    // 処理中に完了していたらここで中断
                    if (isAuthCompleted) return;

                    const resizedDetections = faceapi.resizeResults(detections, displaySize);
                    
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    faceapi.draw.drawDetections(canvas, resizedDetections);
                    
                    if (resizedDetections.length > 0) {
                        // ★発見！即座にロック
                        isAuthCompleted = true; 
                        
                        statusEl.textContent = "顔を認識しました！";
                        
                        // カメラと描画を停止
                        stopFaceAuth();
                        
                        // リクエスト送信 (1回のみ)
                        setTimeout(() => {
                            requestAuth(userName); 
                        }, 500);
                        
                        return; // ループ終了
                    }
                } catch (err) {
                    console.error("検出エラー:", err);
                } finally {
                    isDetectingLoop = false; // ロック解除
                }

                // 次のフレームを予約 (処理が終わってから200ms後)
                if (!isAuthCompleted) {
                    setTimeout(detectLoop, 200);
                }
            };

            // ループ始動
            detectLoop();

        }, { once: true }); // ★重要: 1回だけ実行
        
    } catch(e) {
        console.error(e);
        statusEl.textContent = "エラー: " + e.message;
        alert("カメラまたはAIの起動に失敗しました");
    }
}

function stopFaceAuth() {
    // 既存のストリームを停止
    if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
        currentStream = null;
    }
    const video = document.getElementById('userVideo');
    if (video) video.pause(); // ビデオも止める

    const canvas = document.getElementById('userCanvas');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}


let myRequestId = null;
// リクエスト送信関数
async function requestAuth(userName) {
    document.getElementById('step-1').classList.remove('active');
    document.getElementById('step-2').classList.add('active');
    
    // カラーコード生成
    const colors = ['C', 'Y', 'M', 'G'];
    const myCode = [
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)]
    ];
    
    drawHCode(myCode);
    
    // ★修正: ここでフィールドを確実に指定する
    // platform, gps_valid, face_valid は書かない限り送信されません
    const docRef = await db.collection('auth_requests').add({
        userName: userName,
        authType: `code,${myCode.join(',')}`,
        status: 'pending',
        requestTimestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    
    myRequestId = docRef.id;
    document.getElementById('requestStatus').textContent = "承認待ち...";
}

async function checkRequestStatus() {
    if(!myRequestId) return;
    const doc = await db.collection('auth_requests').doc(myRequestId).get();
    if(doc.data().status === 'approved') {
        document.getElementById('step-2').classList.remove('active');
        document.getElementById('step-3').classList.add('active');
    } else {
        alert('まだ承認されていません');
    }
}

function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    
    // 背景
    ctx.fillStyle = "#000";
    ctx.fillRect(0,0,w,h);
    
    // 四隅マーカー (赤/青)
    ctx.lineWidth = 10;
    ctx.strokeStyle = "red";
    ctx.beginPath(); ctx.moveTo(0,30); ctx.lineTo(0,0); ctx.lineTo(30,0); ctx.stroke(); // 左上
    ctx.beginPath(); ctx.moveTo(w-30,0); ctx.lineTo(w,0); ctx.lineTo(w,30); ctx.stroke(); // 右上
    ctx.strokeStyle = "blue";
    ctx.beginPath(); ctx.moveTo(0,h-30); ctx.lineTo(0,h); ctx.lineTo(30,h); ctx.stroke(); // 左下
    ctx.beginPath(); ctx.moveTo(w-30,h); ctx.lineTo(w,h); ctx.lineTo(w,h-30); ctx.stroke(); // 右下
    
    // H型配置
    const boxW = w * 0.6;
    const boxH = boxW * 0.7; // 縦圧縮
    const startX = (w - boxW)/2;
    const startY = (h - boxH)/2;
    const unitX = boxW / 19;
    
    const colorMap = {'C':'cyan', 'Y':'yellow', 'M':'magenta', 'G':'lime'};
    
    // 左 (Code[0])
    ctx.fillStyle = colorMap[codes[0]];
    ctx.fillRect(startX + unitX*5, startY, unitX, boxH);
    
    // 右 (Code[3])
    ctx.fillStyle = colorMap[codes[3]];
    ctx.fillRect(startX + unitX*13, startY, unitX, boxH);
    
    // 中上 (Code[1])
    const unitY = boxH/9;
    ctx.fillStyle = colorMap[codes[1]];
    ctx.fillRect(startX + unitX*6, startY, unitX*7, unitY*3);
    
    // 中下 (Code[2])
    ctx.fillStyle = colorMap[codes[2]];
    ctx.fillRect(startX + unitX*6, startY + unitY*4, unitX*7, unitY*5);
    
    // 横棒 (白)
    ctx.fillStyle = "white";
    ctx.fillRect(startX + unitX*6, startY + unitY*3, unitX*7, unitY);
}


// ==========================================
//   管理者機能 (Admin)
// ==========================================

// タブ切り替え
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

// リクエスト一覧取得
async function refreshRequests() {
    const listEl = document.getElementById('requestList');
    listEl.innerHTML = '<p>読み込み中...</p>';
    
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
}

// 承認モーダル
let currentRequestId = null;
function openAuthModal(reqId, userName, authType) {
    currentRequestId = reqId;
    document.getElementById('authModal').style.display = 'block';
    document.getElementById('modalTitle').textContent = `${userName} さんの認証`;
    document.getElementById('approveBtn').disabled = false; 
    
    // カメラ起動（プレビュー用）
    const video = document.getElementById('adminVideo');
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
            .then(stream => { video.srcObject = stream; })
            .catch(e => console.log("カメラ起動不可(PC等):", e));
    }
}

function closeAuthModal() {
    document.getElementById('authModal').style.display = 'none';
    const video = document.getElementById('adminVideo');
    if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());
}

async function approveRequest() {
    if(!currentRequestId) return;
    try {
        await db.collection('auth_requests').doc(currentRequestId).update({
            status: 'approved',
            approvalTimestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        const reqDoc = await db.collection('auth_requests').doc(currentRequestId).get();
        const reqData = reqDoc.data();
        await db.collection('attendance_logs').add({
            userName: reqData.userName,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            adminId: 'web_admin'
        });

        alert('承認しました');
        closeAuthModal();
        refreshRequests();
    } catch(e) {
        alert('エラー: ' + e.message);
    }
}

// 情報管理 (キャンパス/エリア登録)
async function registerCampus() {
    const name = document.getElementById('campusName').value;
    const lat = parseFloat(document.getElementById('campusLat').value);
    const lon = parseFloat(document.getElementById('campusLon').value);
    if(!name || isNaN(lat)) return;
    
    await db.collection('campuses').add({ name, lat, lon });
    await loadCampuses();
    populateInfoLists();
}

async function registerArea() {
    const campusId = document.getElementById('campusSelect').value;
    const name = document.getElementById('areaName').value;
    const lat = parseFloat(document.getElementById('areaLat').value);
    const lon = parseFloat(document.getElementById('areaLon').value);
    
    if(!name || isNaN(lat)) return;
    
    await db.collection('gps_areas').doc(name).set({
        name, campusId, lat, lon, isActive: false
    });
    await loadGpsAreas();
    populateInfoLists();
}

async function toggleAreaActive(name, currentStatus) {
    await db.collection('gps_areas').doc(name).update({ isActive: !currentStatus });
    await loadGpsAreas();
    populateInfoLists();
}

function populateInfoLists() {
    const cList = document.getElementById('campusList');
    if(!cList) return;
    cList.innerHTML = '';
    const select = document.getElementById('campusSelect');
    select.innerHTML = '<option>キャンパスを選択</option>';
    
    registeredCampuses.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.innerText = c.name;
        select.appendChild(opt);
        
        const item = document.createElement('div');
        item.className = 'item-card';
        item.innerHTML = `<span>${c.name}</span> <small>${c.lat}, ${c.lon}</small>`;
        cList.appendChild(item);
    });

    const aList = document.getElementById('areaList');
    aList.innerHTML = '';
    registeredGpsAreas.forEach(a => {
        const item = document.createElement('div');
        item.className = `item-card ${a.isActive ? 'active-area' : ''}`;
        item.innerHTML = `
            <span>${a.name}</span>
            <button onclick="toggleAreaActive('${a.name}', ${a.isActive})">
                ${a.isActive ? '停止' : '開始'}
            </button>
        `;
        aList.appendChild(item);
    });
}
function populateFaceList() {
    // 省略 (顔一覧)
}

// ==========================================
//   出席確認 (Check)
// ==========================================
async function checkAttendance() {
    const name = document.getElementById('checkNameInput').value.trim();
    if (!name) { alert("名前を入力してください"); return; }
    
    // UIリセット
    document.getElementById('resultArea').style.display = 'block';
    
    // 履歴取得
    const snapshot = await db.collection('attendance_logs')
        .where('userName', '==', name)
        .orderBy('timestamp', 'desc')
        .get();
        
    const historyDates = [];
    snapshot.forEach(doc => {
        historyDates.push(doc.data().timestamp.toDate());
    });
    
    // 今日のステータス
    const today = new Date();
    const isAttended = historyDates.some(d => 
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
    
    // カレンダー描画 (簡易実装)
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = "";
    document.getElementById('calendarTitle').textContent = `${today.getFullYear()}/${today.getMonth()+1}`;
    
    // 日付セル生成 (1~31)
    const lastDay = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
    for(let i=1; i<=lastDay; i++) {
        const el = document.createElement('div');
        el.className = 'day-cell';
        el.textContent = i;
        if(i === today.getDate()) el.classList.add('today-circle');
        
        // 出席マーク
        const hasLog = historyDates.some(d => d.getDate() === i && d.getMonth() === today.getMonth());
        if(hasLog) {
            const mark = document.createElement('div');
            mark.className = 'attended-mark';
            el.appendChild(mark);
        }
        grid.appendChild(el);
    }
}
function changeMonth(offset) {
    // 月変更ロジック (省略)
}