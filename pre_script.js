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
    
    // 既存のストリームがあれば停止
    stopFaceAuth();

    try {
        await loadModels();
        statusEl.textContent = "カメラを起動中...";
        
        const video = document.getElementById('userVideo');
        
        // カメラ権限取得
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        currentStream = stream;
        video.srcObject = stream;
        
        // ★修正: async関数にして待機処理を入れる
        video.addEventListener('play', async () => {
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            
            // --- ウォームアップ待機 (ここが修正ポイント) ---
            statusEl.textContent = "カメラ準備中... (安定まで待機)";
            
            // 2秒間待つ (この間はリクエストを送らない)
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (isAuthCompleted) return; // 待機中に何かあれば終了
            statusEl.textContent = "顔を映してください...";

            // --- 検出ループ関数 ---
            const detectLoop = async () => {
                // 完了済み、ビデオ停止時は終了
                if (isAuthCompleted || video.paused || video.ended) return;
                
                // 前の処理が終わっていない場合は少し待って再試行
                if (isDetectingLoop) {
                    setTimeout(detectLoop, 100);
                    return;
                }

                isDetectingLoop = true; // ロック開始

                try {
                    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                        .withFaceLandmarks()
                        .withFaceDescriptors();
                    
                    // 処理中に完了していたら中断
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

                // 次のフレームを予約 (200ms後)
                if (!isAuthCompleted) {
                    setTimeout(detectLoop, 200);
                }
            };

            // 待機後にループ始動
            detectLoop();

        }, { once: true }); // 1回だけ実行
        
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

// pre_script.js の drawHCode 関数をこれに差し替えてください

function drawHCode(codes) {
    const canvas = document.getElementById('codeCanvas');
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // Fletコードの基準サイズ
    const baseW = 230;
    const baseH = 170;

    // 1. 比率維持のためのスケール計算
    const scale = Math.min(w / baseW, h / baseH);

    // 2. 中央寄せオフセット
    const dx = (w - (baseW * scale)) / 2;
    const dy = (h - (baseH * scale)) / 2;

    // 座標変換ヘルパー
    // (x, y, w, h) -> [screenX, screenY, screenW, screenH]
    const r = (x, y, rw, rh) => [
        dx + (x * scale), 
        dy + (y * scale), 
        rw * scale, 
        rh * scale
    ];

    // キャンバス全体をクリア (余白ができる可能性があるため)
    ctx.clearRect(0, 0, w, h);

    // 背景 (黒) 基準サイズ分だけ塗る
    ctx.fillStyle = "#000000";
    ctx.fillRect(...r(0, 0, baseW, baseH));

    // マーカー描画
    // 左上 (赤)
    ctx.fillStyle = "#FF0000";
    ctx.fillRect(...r(20, 20, 55, 55));
    // 右上 (赤)
    ctx.fillRect(...r(155, 20, 55, 55));
    // 中央下部の赤い帯
    ctx.fillRect(...r(75, 130, 80, 10));

    // 左下 (青)
    ctx.fillStyle = "#0000FF";
    ctx.fillRect(...r(20, 75, 55, 75));
    // 右下 (青)
    ctx.fillRect(...r(155, 75, 55, 75));

    // ★追加: 黒いストローク (枠線)
    // 30,30 -> 200,140 (W170, H110)
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * scale;
    ctx.strokeRect(...r(30, 30, 170, 110));

    // データエリア背景 (白)
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(...r(40, 40, 150, 90));

    // カラーコード描画
    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };

    // 左
    ctx.fillStyle = colorMap[codes[0]] || '#808080';
    ctx.fillRect(...r(40, 40, 30, 90));

    // 中上
    ctx.fillStyle = colorMap[codes[1]] || '#808080';
    ctx.fillRect(...r(80, 40, 70, 30));

    // 中下
    ctx.fillStyle = colorMap[codes[2]] || '#808080';
    ctx.fillRect(...r(80, 80, 70, 50));

    // 右
    ctx.fillStyle = colorMap[codes[3]] || '#808080';
    ctx.fillRect(...r(160, 40, 30, 90));
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

// ==========================================
//   管理者機能 (Admin) - 認証ロジック実装版
// ==========================================

let currentRequestId = null;
let currentAuthUser = null; // { name, authType(code array), faceDescriptor }
let adminGuideLoopId = null;
let adminAuthStep = 0; // 0:コードスキャン, 1:顔認証, 2:承認可

// 承認モーダルを開く
async function openAuthModal(reqId, userName, authTypeString) {
    currentRequestId = reqId;
    adminAuthStep = 0; // 最初はコードスキャンから
    
    // ユーザー情報の特定
    // authTypeString: "code,C,Y,M,G" 形式
    const parts = authTypeString.split(',');
    const targetCode = parts[0] === 'code' ? parts.slice(1) : [];
    
    // 登録済み顔データの検索
    // (注: Web版face-api.jsの形式に変換済みの registeredFaces から探す)
    const registered = registeredFaces.find(f => f.label === userName);
    
    currentAuthUser = {
        name: userName,
        targetCode: targetCode,
        descriptor: registered ? registered.descriptor : null
    };

    const modal = document.getElementById('authModal');
    modal.style.display = 'block';
    updateAdminStatus("コードを枠に合わせてください");
    document.getElementById('approveBtn').disabled = true;
    
    // カメラ起動
    const video = document.getElementById('adminVideo');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: "environment" } // 外カメラ推奨
        });
        video.srcObject = stream;
        video.onloadedmetadata = () => {
            video.play();
            processAdminFrame(); // 処理ループ開始
        };
    } catch(e) {
        console.error("カメラエラー:", e);
        alert("カメラを起動できませんでした。");
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
    document.getElementById('modalTitle').textContent = 
        `${currentAuthUser ? currentAuthUser.name : ''} さんの認証 (Step ${adminAuthStep+1}/2)`;
    document.getElementById('adminAuthStatus').textContent = msg;
}

// --- メイン処理ループ (描画 & 判定) ---
async function processAdminFrame() {
    const canvas = document.getElementById('adminCanvas');
    const video = document.getElementById('adminVideo');
    const modal = document.getElementById('authModal');

    if (modal.style.display === 'none' || !canvas || !video || video.paused || video.ended) return;

    // キャンバスサイズ同期
    if (video.videoWidth > 0 && canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // 1. ガイド描画 (現在のステップに応じて色などを変える)
    ctx.clearRect(0, 0, w, h);
    drawAdminGuide(ctx, w, h, adminAuthStep);

    // 2. 判定ロジック (少し負荷を下げるため毎フレーム実行しない制御を入れても良い)
    if (adminAuthStep === 0) {
        // --- Step 1: カラーコード判定 ---
        const detectedCode = scanColors(ctx, w, h); // 画像データから色を取得
        
        // ターゲットと一致するか
        if (isCodeMatch(detectedCode, currentAuthUser.targetCode)) {
            adminAuthStep = 1;
            updateAdminStatus("コード一致！ 次は「顔」を映してください");
            // 成功演出のあと少し待つなどの処理も可
        }
        
    } else if (adminAuthStep === 1) {
        // --- Step 2: 顔認証 ---
        // face-api.js を使用
        if (currentAuthUser.descriptor) {
            // 処理が重いので非同期実行(awaitしないとカクつくが、ループ内なので注意)
            // 簡易的に detectSingleFace を使用
            const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                .withFaceLandmarks()
                .withFaceDescriptor();
            
            if (detection) {
                // 距離計算 (ユークリッド距離)
                const dist = faceapi.euclideanDistance(detection.descriptor, currentAuthUser.descriptor);
                
                // ガイド枠(顔)の描画
                const box = detection.detection.box;
                const drawBox = new faceapi.draw.DrawBox(box, { label: dist.toFixed(2) });
                drawBox.draw(canvas);

                // 閾値判定 (0.6以下なら本人)
                if (dist < 0.6) {
                    adminAuthStep = 2;
                    updateAdminStatus("本人確認完了！ 承認ボタンを押してください");
                    document.getElementById('approveBtn').disabled = false;
                    document.getElementById('approveBtn').style.backgroundColor = "#28a745";
                }
            }
        } else {
            // 顔データがない場合はスキップするかエラーにする
            updateAdminStatus("登録顔データがありません (スキップ可)");
            document.getElementById('approveBtn').disabled = false;
        }
    }

    // 次のフレーム
    adminGuideLoopId = requestAnimationFrame(processAdminFrame);
}

// --- 色判定ロジック ---
function scanColors(ctx, w, h) {
    // 基準サイズとスケール計算 (GuidePainterと同じロジック)
    const refW = 230;
    const refH = 170;
    const scale = (w * 0.8) / refW;
    const offsetX = (w - refW * scale) / 2;
    const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: offsetX + x * scale, y: offsetY + y * scale });

    // H型配置のサンプリング座標 (左, 中上, 中下, 右)
    // 描画座標の中心点を狙う
    // 左: x=40~70 (中心55), y=40~130 (中心85) -> (55, 85)
    // 中上: x=80~150(中心115), y=40~70(中心55) -> (115, 55)
    // 中下: x=80~150(中心115), y=80~130(中心105) -> (115, 105)
    // 右: x=160~190(中心175), y=40~130(中心85) -> (175, 85)
    
    const points = [
        t(55, 85),  // Code 1
        t(115, 55), // Code 2
        t(115, 105),// Code 3
        t(175, 85)  // Code 4
    ];

    // ピクセルデータ取得
    // ctx.getImageData は重いので、points周辺だけ取得するか、全体1回取得するか
    // ここでは簡易的に全体を取得 (最適化余地あり)
    const imageData = ctx.getImageData(0, 0, w, h).data;

    const detected = points.map(p => {
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        const i = (y * w + x) * 4;
        const r = imageData[i];
        const g = imageData[i+1];
        const b = imageData[i+2];
        return classifyColor(r, g, b);
    });

    return detected;
}

function classifyColor(r, g, b) {
    // 簡易的な色判定閾値 (C, Y, M, G)
    // Cyan: G高, B高, R低
    if (g > 150 && b > 150 && r < 100) return 'C';
    // Yellow: R高, G高, B低
    if (r > 150 && g > 150 && b < 100) return 'Y';
    // Magenta: R高, B高, G低
    if (r > 150 && b > 150 && g < 100) return 'M';
    // Green: G高, R低, B低
    if (g > 100 && r < 100 && b < 100) return 'G';
    
    return '?';
}

function isCodeMatch(detected, target) {
    if (!target || target.length !== 4) return false;
    for (let i = 0; i < 4; i++) {
        if (detected[i] !== target[i]) return false;
    }
    return true;
}

// --- ガイド描画 (ステップ対応) ---
function drawAdminGuide(ctx, w, h, step) {
    const refW = 230;
    const refH = 170;
    const scale = (w * 0.8) / refW;
    const offsetX = (w - refW * scale) / 2;
    const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: x * scale + offsetX, y: y * scale + offsetY });

    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // 1. L字マーカー (ステップ0:コード認証時のみ強調、ステップ1以降は薄く)
    const markerAlpha = step === 0 ? 1.0 : 0.2;
    
    // 左上(赤)
    ctx.strokeStyle = `rgba(255, 0, 0, ${markerAlpha})`;
    ctx.beginPath();
    let p = t(30, 50); ctx.moveTo(p.x, p.y);
    p = t(30, 30); ctx.lineTo(p.x, p.y);
    p = t(50, 30); ctx.lineTo(p.x, p.y);
    ctx.stroke();
    // (右上、左下、右下も同様に...)
    // 右上(赤)
    ctx.beginPath();
    p = t(200, 50); ctx.moveTo(p.x, p.y);
    p = t(200, 30); ctx.lineTo(p.x, p.y);
    p = t(180, 30); ctx.lineTo(p.x, p.y);
    ctx.stroke();
    // 左下(青)
    ctx.strokeStyle = `rgba(0, 0, 255, ${markerAlpha})`;
    ctx.beginPath();
    p = t(30, 120); ctx.moveTo(p.x, p.y);
    p = t(30, 140); ctx.lineTo(p.x, p.y);
    p = t(50, 140); ctx.lineTo(p.x, p.y);
    ctx.stroke();
    // 右下(青)
    ctx.beginPath();
    p = t(200, 120); ctx.moveTo(p.x, p.y);
    p = t(200, 140); ctx.lineTo(p.x, p.y);
    p = t(180, 140); ctx.lineTo(p.x, p.y);
    ctx.stroke();

    // 2. 中央のH型 (コード認証時のみ表示)
    if (step === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.5)"; // 半透明白
        const fillRectFromPoints = (p1x, p1y, p2x, p2y) => {
            const start = t(p1x, p1y);
            const end = t(p2x, p2y);
            ctx.fillRect(start.x, start.y, end.x - start.x, end.y - start.y);
        };
        fillRectFromPoints(70, 40, 80, 130);  // 左
        fillRectFromPoints(80, 70, 150, 80);  // 横
        fillRectFromPoints(150, 40, 160, 130); // 右
        
        // ターゲット色をヒントとして表示 (オプション)
        if (currentAuthUser && currentAuthUser.targetCode.length === 4) {
            const colors = { 'C':'#00FFFF', 'Y':'#FFFF00', 'M':'#FF00FF', 'G':'#00FF00' };
            const c = currentAuthUser.targetCode;
            // 小さい丸で色を表示
            const drawDot = (cx, cy, code) => {
                const pt = t(cx, cy);
                ctx.fillStyle = colors[code] || 'gray';
                ctx.beginPath(); ctx.arc(pt.x, pt.y, 5, 0, Math.PI*2); ctx.fill();
            };
            drawDot(55, 85, c[0]);
            drawDot(115, 55, c[1]);
            drawDot(115, 105, c[2]);
            drawDot(175, 85, c[3]);
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
//   出席確認 (Check) - ロジック実装版
// ==========================================

// カレンダー表示用の状態変数
let checkDisplayDate = new Date(); // 表示中の年月
let checkHistoryDates = [];        // 取得した出席データ(Date型)のリスト
let checkCurrentName = "";         // 現在表示中のユーザー名

async function checkAttendance() {
    const name = document.getElementById('checkNameInput').value.trim();
    if (!name) { alert("名前を入力してください"); return; }
    
    checkCurrentName = name;
    
    // UI表示切り替え
    document.getElementById('resultArea').style.display = 'block';
    
    // 履歴取得 (承認済みのログ 'attendance_logs' を検索)
    try {
        const snapshot = await db.collection('attendance_logs')
            .where('userName', '==', name)
            .orderBy('timestamp', 'desc')
            .get();
            
        checkHistoryDates = [];
        snapshot.forEach(doc => {
            // FirestoreのTimestampをJavaScriptのDateに変換して保存
            checkHistoryDates.push(doc.data().timestamp.toDate());
        });
        
        // 今日のステータス更新
        updateTodayStatus();
        
        // カレンダー描画 (現在の月から開始)
        checkDisplayDate = new Date();
        renderCalendar();
        
    } catch(e) {
        console.error("履歴取得エラー:", e);
        alert("データの取得に失敗しました。");
    }
}

// 今日の出席状況表示
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
        statusEl.className = "status-card status-ok"; // 緑背景
    } else {
        statusEl.textContent = "今日の出席：未 ☁️";
        statusEl.className = "status-card status-no"; // グレー背景
    }
}

// 月変更ボタン処理
function changeMonth(offset) {
    // 月をずらす
    checkDisplayDate.setMonth(checkDisplayDate.getMonth() + offset);
    renderCalendar();
}

// カレンダー描画処理
function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = "";
    
    const year = checkDisplayDate.getFullYear();
    const month = checkDisplayDate.getMonth(); // 0-11
    
    document.getElementById('calendarTitle').textContent = `${year}年 ${month + 1}月`;
    
    // 曜日ヘッダー
    const weeks = ['日', '月', '火', '水', '木', '金', '土'];
    weeks.forEach(w => {
        const el = document.createElement('div');
        el.className = 'day-cell';
        el.style.border = 'none';
        el.style.fontWeight = 'bold';
        el.style.backgroundColor = '#f0f0f0';
        el.textContent = w;
        grid.appendChild(el);
    });
    
    // 月初めの空白セル
    const firstDay = new Date(year, month, 1);
    const startDayOfWeek = firstDay.getDay();
    for(let i=0; i<startDayOfWeek; i++) {
        const el = document.createElement('div');
        el.className = 'day-cell'; // 枠線だけ表示
        grid.appendChild(el);
    }
    
    // 日付セル生成
    const lastDay = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    
    for(let d=1; d<=lastDay; d++) {
        const el = document.createElement('div');
        el.className = 'day-cell';
        el.textContent = d;
        
        // 今日の枠線
        if(year === today.getFullYear() && month === today.getMonth() && d === today.getDate()) {
            el.classList.add('today-circle');
        }
        
        // 出席マーク判定 (履歴にあるかチェック)
        const isAttended = checkHistoryDates.some(historyDate => 
            historyDate.getFullYear() === year && 
            historyDate.getMonth() === month && 
            historyDate.getDate() === d
        );
        
        if(isAttended) {
            // 緑の丸アイコンを追加 (CSS .attended-mark を利用)
            const mark = document.createElement('div');
            mark.className = 'attended-mark';
            el.appendChild(mark);
            
            // 背景も薄い緑にする
            el.classList.add('active-area'); // pre_style.cssにある緑背景クラスを流用
        }
        
        grid.appendChild(el);
    }
}