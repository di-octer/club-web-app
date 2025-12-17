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
let currentStream = null;

// ユーザー認証用制御フラグ
let isAuthCompleted = false; 
let isDetectingLoop = false;
let myRequestId = null;

// 管理者認証用制御変数
let adminGuideLoopId = null;
let adminAuthStep = 0; 
let currentAuthUser = null;
let colorMatchCounter = 0; // カラーコード連続一致カウンタ

// 顔登録用変数
let regStream = null;

// H型カラーコード用定数
const COLORS = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#008000' };

// --- 初期化 (ページ読み込み時) ---
window.onload = async () => {
    const bodyId = document.body.id;
    
    // 共通データの読み込み
    await loadCampuses();
    await loadGpsAreas();
    
    if (bodyId === 'page-admin') {
        // 管理者ページの場合
        await loadModels(); // AIモデルロード
        await loadRegisteredFaces(); // 顔データロード
        refreshRequests(); // リクエスト一覧更新
        populateInfoLists(); // 設定タブのリスト更新
        populateFaceList(); // 顔一覧更新
    } else if (bodyId === 'page-user') {
        // ユーザーページ（認証開始時にロード）
    } else if (bodyId === 'page-check') {
        // 出席確認ページ
    }
};

// ==========================================
//   共通ヘルパー & データ読み込み
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
        let skippedCount = 0;

        snapshot.forEach(doc => {
            const data = doc.data();
            
            // 記述子(descriptors)が存在する場合のみ処理
            if (data.descriptors && data.descriptors.length > 0) {
                 try {
                     // Base64文字列をバイナリ(Float32Array)に変換
                     const binary = atob(data.descriptors[0]);
                     const len = binary.length;
                     const bytes = new Uint8Array(len);
                     for (let i = 0; i < len; i++) {
                         bytes[i] = binary.charCodeAt(i);
                     }
                     const float32 = new Float32Array(bytes.buffer);
                     
                     // ★重要: データ形式の確認 (Web版 face-api.js は 128次元)
                     // スマホ版 (MobileFaceNet) の 192次元データはここで除外する
                     if (float32.length === 128) {
                         registeredFaces.push({
                             label: data.label,
                             descriptor: float32
                         });
                     } else {
                         // 形式違い（スマホ版データなど）はスキップ
                         skippedCount++;
                     }
                 } catch(e) {
                     console.error("データ変換エラー:", data.label, e);
                 }
            }
        });
        console.log(`読込完了: Web用 ${registeredFaces.length}件 (スキップ: ${skippedCount}件)`);

    } catch (e) { 
        console.error("Face Load Error:", e); 
        alert("顔データの読み込みに失敗しました");
    }
}

async function loadModels() {
    // CDNからモデルを読み込む
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/'; 
    try {
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        console.log("AI Models Loaded");
    } catch(e) {
        console.error("Model Load Error:", e);
        alert("AIモデルの読み込みに失敗しました。ネットワークを確認してください。");
    }
}

// 2点間の距離計算 (Haversine formula)
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
    if (!navigator.geolocation) {
        alert("位置情報が利用できません");
        return;
    }

    navigator.geolocation.getCurrentPosition(async (pos) => {
        const uLat = pos.coords.latitude;
        const uLon = pos.coords.longitude;
        
        let inArea = false;
        // 活動中のエリアかつ100m以内かチェック
        const activeAreas = registeredGpsAreas.filter(a => a.isActive);
        for(const area of activeAreas) {
            const dist = getDistance(uLat, uLon, area.lat, area.lon);
            if(dist <= 100) { inArea = true; break; }
        }
        
        if(!inArea) {
            // 本番運用時はここを return にしてブロックする
            console.log("エリア外ですが、デバッグのため通過します");
        }
        
        // 2. 顔認証開始
        startFaceAuth(name);

    }, (err) => {
        alert("位置情報の取得に失敗しました: " + err.message);
    });
}

// 顔認証処理 (ウォームアップ機能付き)
async function startFaceAuth(userName) {
    const statusEl = document.getElementById('userStatus');
    statusEl.textContent = "モデルを読み込み中...";
    
    // フラグのリセット
    isAuthCompleted = false;
    isDetectingLoop = false;
    
    // 既存ストリーム停止
    stopFaceAuth();

    try {
        await loadModels();
        statusEl.textContent = "カメラを起動中...";
        
        const video = document.getElementById('userVideo');
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        currentStream = stream;
        video.srcObject = stream;
        
        // カメラ再生開始イベント
        video.addEventListener('play', async () => {
            const canvas = document.getElementById('userCanvas');
            const displaySize = { width: video.videoWidth, height: video.videoHeight };
            faceapi.matchDimensions(canvas, displaySize);
            
            // --- ウォームアップ待機 (2秒) ---
            statusEl.textContent = "カメラ準備中... (安定まで待機)";
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (isAuthCompleted) return; // 待機中にキャンセルされた場合
            statusEl.textContent = "顔を映してください...";

            // --- 検出ループ ---
            const detectLoop = async () => {
                // 終了条件
                if (isAuthCompleted || video.paused || video.ended) return;
                
                // 前処理が終わっていない場合は再試行予約
                if (isDetectingLoop) {
                    setTimeout(detectLoop, 100);
                    return;
                }

                isDetectingLoop = true; // ロック開始

                try {
                    const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                        .withFaceLandmarks()
                        .withFaceDescriptors();
                    
                    if (isAuthCompleted) return; // 処理中に完了していたら中断

                    const resizedDetections = faceapi.resizeResults(detections, displaySize);
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    faceapi.draw.drawDetections(canvas, resizedDetections);
                    
                    if (resizedDetections.length > 0) {
                        // ★発見！即座にロック
                        isAuthCompleted = true; 
                        statusEl.textContent = "顔を認識しました！";
                        
                        // 停止＆リクエスト送信
                        stopFaceAuth();
                        setTimeout(() => { requestAuth(userName); }, 500);
                        return; // ループ終了
                    }
                } catch (err) {
                    console.error("Detect Error:", err);
                } finally {
                    isDetectingLoop = false; // ロック解除
                }

                // 次のフレーム予約
                if (!isAuthCompleted) {
                    setTimeout(detectLoop, 200);
                }
            };

            // ループ始動
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

// リクエスト送信 & カラーコード表示
async function requestAuth(userName) {
    document.getElementById('step-1').classList.remove('active');
    document.getElementById('step-2').classList.add('active');
    
    // カラーコード生成 (ランダム)
    const colors = ['C', 'Y', 'M', 'G'];
    const myCode = [
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)],
        colors[Math.floor(Math.random()*4)]
    ];
    
    // H型コード描画
    drawHCode(myCode);
    
    // Firestore送信
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

// H型カラーコード描画 (比率維持 & 枠線あり)
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
    
    // 背景(黒)
    ctx.fillStyle = "#000000";
    ctx.fillRect(...r(0, 0, baseW, baseH));

    // マーカー
    ctx.fillStyle = "#FF0000"; // 赤
    ctx.fillRect(...r(20, 20, 55, 55)); // 左上
    ctx.fillRect(...r(155, 20, 55, 55)); // 右上
    ctx.fillRect(...r(75, 130, 80, 10)); // 下部帯

    ctx.fillStyle = "#0000FF"; // 青
    ctx.fillRect(...r(20, 75, 55, 75)); // 左下
    ctx.fillRect(...r(155, 75, 55, 75)); // 右下

    // 黒枠線
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2 * scale;
    ctx.strokeRect(...r(30, 30, 170, 110));

    // データエリア背景(白)
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(...r(40, 40, 150, 90));

    // カラーコード
    const colorMap = { 'C': '#00FFFF', 'Y': '#FFFF00', 'M': '#FF00FF', 'G': '#00FF00' };
    
    ctx.fillStyle = colorMap[codes[0]]; ctx.fillRect(...r(40, 40, 30, 90)); // 左
    ctx.fillStyle = colorMap[codes[1]]; ctx.fillRect(...r(80, 40, 70, 30)); // 中上
    ctx.fillStyle = colorMap[codes[2]]; ctx.fillRect(...r(80, 80, 70, 50)); // 中下
    ctx.fillStyle = colorMap[codes[3]]; ctx.fillRect(...r(160, 40, 30, 90)); // 右
}


// ==========================================
//   管理者機能 (Admin) - 認証 & 登録
// ==========================================

// タブ切り替え
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // event.target が無い場合(コードから呼び出し時)のガード
    if (event && event.target) event.target.classList.add('active');
    
    document.getElementById(`tab-${tabName}`).classList.add('active');
}

// リクエスト一覧更新
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

// --- 認証モーダル ---
async function openAuthModal(reqId, userName, authTypeString) {
    currentRequestId = reqId;
    adminAuthStep = 0;
    colorMatchCounter = 0; // カウンタクリア
    
    // コード解析
    const parts = authTypeString.split(',');
    // "code,C,Y,M,G" の形式
    const targetCode = parts[0].includes('code') && parts.length >= 5 ? parts.slice(1, 5) : [];
    
    // 顔データ検索
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
            processAdminFrame(); // 管理者用ループ開始
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

// --- 管理者ループ (コード判定 -> 顔判定) ---
async function processAdminFrame() {
    const canvas = document.getElementById('adminCanvas');
    const video = document.getElementById('adminVideo');
    const modal = document.getElementById('authModal');

    // モーダルが閉じているか、ビデオが無効なら終了
    if (modal.style.display === 'none' || !canvas || !video || video.paused || video.ended) return;

    // サイズ同期
    if (video.videoWidth > 0 && canvas.width !== video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    // 1. ビデオ映像を描画 (ピクセル取得用)
    ctx.drawImage(video, 0, 0, w, h);

    // 2. 判定ロジック
    if (adminAuthStep === 0) {
        // --- Step 1: カラーコード ---
        if (currentAuthUser.targetCode.length === 4) {
            const detectedCode = scanColors(ctx, w, h);
            
            // デバッグ: 検出色を表示
            ctx.font = "20px Arial";
            ctx.fillStyle = "white";
            ctx.fillText(`Detected: ${detectedCode.join(' ')}`, 10, 30);
            ctx.fillText(`Match Count: ${colorMatchCounter}`, 10, 55);

            if (isCodeMatch(detectedCode, currentAuthUser.targetCode)) {
                colorMatchCounter++;
                // ★連続10フレーム一致で通過
                if (colorMatchCounter > 10) {
                    adminAuthStep = 1;
                    updateAdminStatus("コード一致！ 次は「顔」を映してください");
                }
            } else {
                // 不一致ならカウンターを減らす(0未満にはしない)
                colorMatchCounter = Math.max(0, colorMatchCounter - 1);
            }
        } else {
             // コード情報がない場合はスキップ
             adminAuthStep = 1; 
        }

    } else if (adminAuthStep === 1) {
        // --- Step 2: 顔認証 ---
        if (currentAuthUser.descriptor) {
            try {
                // 簡易顔検出
                const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                    .withFaceLandmarks()
                    .withFaceDescriptor();
                
                if (detection) {
                    const dist = faceapi.euclideanDistance(detection.descriptor, currentAuthUser.descriptor);
                    const box = detection.detection.box;
                    const drawBox = new faceapi.draw.DrawBox(box, { label: `Diff: ${dist.toFixed(2)}` });
                    drawBox.draw(canvas);

                    // 閾値 0.6 以下で本人
                    if (dist < 0.6) {
                        adminAuthStep = 2;
                        updateAdminStatus("本人確認完了！ 承認可能です");
                        document.getElementById('approveBtn').disabled = false;
                        document.getElementById('approveBtn').style.backgroundColor = "#28a745";
                    }
                }
            } catch(e) { /* 顔が見つからない等は無視 */ }
        } else {
            updateAdminStatus("顔データなし (スキップ可)");
            document.getElementById('approveBtn').disabled = false;
        }
    }

    // 3. ガイド描画 (上書き)
    drawAdminGuide(ctx, w, h, adminAuthStep);

    // 次フレーム
    adminGuideLoopId = requestAnimationFrame(processAdminFrame);
}

// --- 色判定ロジック (強化版) ---
function scanColors(ctx, w, h) {
    const refW = 230;
    const refH = 170;
    const scale = Math.min(w / refW, h / refH) * 0.8; 
    const offsetX = (w - refW * scale) / 2;
    const offsetY = (h - refH * scale) / 2;
    const t = (x, y) => ({ x: Math.floor(offsetX + x * scale), y: Math.floor(offsetY + y * scale) });

    // H型の中心点サンプリング (左, 中上, 中下, 右)
    const points = [
        t(55, 85),  
        t(115, 55), 
        t(115, 105),
        t(175, 85)  
    ];

    const imageData = ctx.getImageData(0, 0, w, h).data;
    return points.map(p => {
        const i = (p.y * w + p.x) * 4;
        return classifyColor(imageData[i], imageData[i+1], imageData[i+2]);
    });
}

function classifyColor(r, g, b) {
    // 彩度チェック (白・黒・グレーを除外)
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max - min;
    
    // 彩度が低い場合は無彩色として除外
    if (saturation < 40) return '?'; 

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

    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    
    // マーカー (ステップ0以外は薄く)
    const alpha = step === 0 ? 1.0 : 0.2;
    
    ctx.strokeStyle = `rgba(255, 0, 0, ${alpha})`; // 赤
    ctx.beginPath();
    let p = t(30, 50); ctx.moveTo(p.x, p.y); p = t(30, 30); ctx.lineTo(p.x, p.y); p = t(50, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath();
    p = t(200, 50); ctx.moveTo(p.x, p.y); p = t(200, 30); ctx.lineTo(p.x, p.y); p = t(180, 30); ctx.lineTo(p.x, p.y); ctx.stroke();
    
    ctx.strokeStyle = `rgba(0, 0, 255, ${alpha})`; // 青
    ctx.beginPath();
    p = t(30, 120); ctx.moveTo(p.x, p.y); p = t(30, 140); ctx.lineTo(p.x, p.y); p = t(50, 140); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.beginPath();
    p = t(200, 120); ctx.moveTo(p.x, p.y); p = t(200, 140); ctx.lineTo(p.x, p.y); p = t(180, 140); ctx.lineTo(p.x, p.y); ctx.stroke();

    // 中央H型 (ステップ0のみ)
    if (step === 0) {
        ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
        const fillRect = (x1,y1,x2,y2) => {
            const s = t(x1,y1); const e = t(x2,y2);
            ctx.fillRect(s.x, s.y, e.x - s.x, e.y - s.y);
        };
        fillRect(70, 40, 80, 130);
        fillRect(80, 70, 150, 80);
        fillRect(150, 40, 160, 130);
        
        // 進捗バー (連続一致度合いを表示)
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
        // ログ記録
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

async function startFaceRegistration() {
    const nameInput = document.getElementById('regName');
    const name = nameInput.value.trim();
    if (!name) return alert("登録名を入力してください");

    const btn = document.getElementById('regBtn');
    const statusEl = document.getElementById('regStatus');
    
    // UI反応: ボタンを一時無効化し、メッセージを表示
    btn.disabled = true;
    statusEl.textContent = "システム準備中...";
    
    const video = document.getElementById('regVideo');
    const canvas = document.getElementById('regCanvas');

    try {
        // face-apiがロードされているか確認
        if (typeof faceapi === 'undefined') {
            throw new Error("AIモデルがまだ読み込まれていません。ページを更新してください。");
        }

        await loadModels(); // 未ロードならロード
        
        statusEl.textContent = "カメラを起動しています...";
        
        const stream = await navigator.mediaDevices.getUserMedia({ video: {} });
        regStream = stream;
        video.srcObject = stream;

        // 映像再生開始時の処理
        video.onloadedmetadata = () => {
            video.play();
            statusEl.textContent = "顔を検出中... (正面を向いてください)";
            btn.disabled = false; // 起動したらボタンを戻す（または「停止」に変えるなど）
            detectFaceLoop(video, canvas, name);
        };

    } catch (e) {
        console.error(e);
        alert("エラー: " + e.message);
        statusEl.textContent = "起動エラー";
        btn.disabled = false;
    }
}

async function detectFaceLoop(video, canvas, name) {
    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    faceapi.matchDimensions(canvas, displaySize);

    let captured = false;
    
    const interval = setInterval(async () => {
        if (captured) return; // 既にキャプチャ済み

        const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptor();

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (detection) {
            const resized = faceapi.resizeResults(detection, displaySize);
            faceapi.draw.drawDetections(canvas, resized);

            // スコアが0.8以上なら登録実行
            if (detection.detection.score > 0.8) {
                captured = true;
                clearInterval(interval);
                saveFaceData(name, detection.descriptor);
            }
        }
    }, 200);
}

async function saveFaceData(name, descriptor) {
    document.getElementById('regStatus').textContent = "保存中...";
    
    // Float32Array -> Base64変換 (Flutter互換のため、バイナリとして保存)
    // ※注意: FlutterのMobileFaceNet(192)とは互換性がないが、データ構造は合わせる
    const buffer = descriptor.buffer;
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const base64Str = btoa(binary);

    try {
        await db.collection("faces").doc(name).set({
            label: name,
            thumbnail: "", // サムネは省略(必要ならvideoからcanvas captureして保存)
            descriptors: [base64Str]
        });
        alert(`登録完了: ${name}`);
        document.getElementById('regStatus').textContent = "登録完了";
        document.getElementById('regName').value = "";
    } catch(e) {
        alert("保存エラー: " + e.message);
    }
    
    // カメラ停止
    if (regStream) {
        regStream.getTracks().forEach(t => t.stop());
        regStream = null;
    }
    const ctx = document.getElementById('regCanvas').getContext('2d');
    ctx.clearRect(0, 0, 1000, 1000);
}

// ==========================================
//   出席確認機能 (Check)
// ==========================================
let checkDisplayDate = new Date();
let checkHistoryDates = [];

async function checkAttendance() {
    const name = document.getElementById('checkNameInput').value.trim();
    if (!name) return alert("名前を入力してください");
    
    document.getElementById('resultArea').style.display = 'block';
    
    try {
        const snapshot = await db.collection('attendance_logs')
            .where('userName', '==', name)
            .orderBy('timestamp', 'desc')
            .get();
            
        checkHistoryDates = [];
        snapshot.forEach(doc => {
            checkHistoryDates.push(doc.data().timestamp.toDate());
        });
        
        updateTodayStatus();
        checkDisplayDate = new Date();
        renderCalendar();
        
    } catch(e) {
        console.error(e);
        // インデックス未作成エラーの場合の案内
        if(e.code === 'failed-precondition') {
            alert("エラー: 管理者にインデックス作成を依頼してください");
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
        const el = document.createElement('div');
        el.className = 'day-cell';
        el.textContent = d;
        
        if(year===today.getFullYear() && month===today.getMonth() && d===today.getDate()) {
            el.classList.add('today-circle');
        }
        
        const isAttended = checkHistoryDates.some(hd => 
            hd.getFullYear()===year && hd.getMonth()===month && hd.getDate()===d
        );
        
        if(isAttended) {
            const mark = document.createElement('div');
            mark.className = 'attended-mark';
            el.appendChild(mark);
            el.classList.add('active-area'); // 緑背景
        }
        grid.appendChild(el);
    }
}

// ==========================================
//   設定・管理用 (Info)
// ==========================================
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
    
    await db.collection('gps_areas').doc(name).set({ name, campusId, lat, lon, isActive: false });
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
        opt.value = c.id; opt.innerText = c.name;
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
        item.innerHTML = `<span>${a.name}</span> <small>${a.isActive?'活動中':'停止'}</small>`;
        aList.appendChild(item);
    });
}

function populateFaceList() {
    const el = document.getElementById('faceList');
    el.innerHTML = '';
    registeredFaces.forEach(f => {
        const div = document.createElement('div');
        div.className = 'item-card';
        div.innerHTML = `<span>${f.label}</span>`;
        el.appendChild(div);
    });
}

// ==========================================
//   届出・連絡機能 (Report) - Form & Admin
// ==========================================

// --- ユーザー側: 送信処理 ---
async function submitReport() {
    const nameInput = document.getElementById('reportName');
    const typeInput = document.getElementById('reportType');
    const reasonInput = document.getElementById('reportReason');
    const fileInput = document.getElementById('reportImage');
    
    // 要素取得チェック
    if (!nameInput || !typeInput || !reasonInput) {
        console.error("フォーム要素が見つかりません");
        return;
    }

    const name = nameInput.value.trim();
    const type = typeInput.value;
    const reason = reasonInput.value.trim();
    
    if (!name || !reason) return alert("名前と理由を入力してください");
    
    // 画像処理 (Base64変換)
    let imageBase64 = null;
    if (fileInput && fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        // サイズ制限 (1MB)
        if (file.size > 1024 * 1024) {
            return alert("画像サイズが大きすぎます (1MB以下にしてください)");
        }
        
        try {
            imageBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(e.target.result);
                reader.onerror = e => reject(e);
                reader.readAsDataURL(file);
            });
        } catch(e) {
            return alert("画像の読み込みに失敗しました: " + e.message);
        }
    }

    try {
        await db.collection('absence_reports').add({
            userName: name,
            type: type,
            reason: reason,
            attachment: imageBase64, // 画像データ (Base64)
            status: 'pending', // 初期状態
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });
        
        alert("送信しました");
        
        // フォームクリア
        reasonInput.value = "";
        if (fileInput) fileInput.value = "";
        const preview = document.getElementById('previewArea');
        if (preview) preview.innerHTML = "";
        
    } catch(e) {
        console.error("Submit Error:", e);
        alert("送信エラー: " + e.message);
    }
}

// ユーザー側: 画像プレビュー機能
// ページ読み込み時にイベントリスナーを設定
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
                img.style.border = "1px solid #ccc";
                img.style.marginTop = "10px";
                area.appendChild(img);
            }
        });
    }
});


// --- 管理者側: サブタブ切り替え & リスト表示 ---

function switchAdminSubTab(tab) {
    const authView = document.getElementById('view-auth');
    const reportView = document.getElementById('view-report');
    const btnAuth = document.getElementById('btn-sub-auth');
    const btnReport = document.getElementById('btn-sub-report');

    if (!authView || !reportView) return;

    if (tab === 'auth') {
        authView.style.display = 'block';
        reportView.style.display = 'none';
        if(btnAuth) btnAuth.classList.add('active');
        if(btnReport) btnReport.classList.remove('active');
        refreshRequests(); // 認証リスト更新
    } else {
        authView.style.display = 'none';
        reportView.style.display = 'block';
        if(btnAuth) btnAuth.classList.remove('active');
        if(btnReport) btnReport.classList.add('active');
        refreshReports(); // 届出リスト更新
    }
}

// 届出リスト取得 (管理者)
async function refreshReports() {
    const listEl = document.getElementById('reportList');
    if (!listEl) return;
    
    listEl.innerHTML = '<p>読み込み中...</p>';
    
    try {
        const snapshot = await db.collection('absence_reports')
            .orderBy('timestamp', 'desc')
            .limit(50)
            .get();
            
        listEl.innerHTML = '';
        if (snapshot.empty) {
            listEl.innerHTML = '<p>届出はありません</p>';
            return;
        }
        
        snapshot.forEach(doc => {
            const data = doc.data();
            const date = data.timestamp ? data.timestamp.toDate().toLocaleString() : '';
            
            // 表示ラベル変換
            const typeMap = { 'absence':'欠席', 'late':'遅刻', 'early':'早退' };
            const typeLabel = typeMap[data.type] || data.type;
            
            const statusMap = { 
                'pending': '未承認', 'approved': '承認済', 
                'confirm': '要確認', 'rejected': '否認' 
            };
            const statusLabel = statusMap[data.status] || data.status;
            
            // ステータスに応じた色クラス (CSSで定義推奨)
            let badgeStyle = "background:#666;";
            if(data.status === 'approved') badgeStyle = "background:#28a745;";
            if(data.status === 'confirm') badgeStyle = "background:#ffc107; color:black;";
            if(data.status === 'rejected') badgeStyle = "background:#dc3545;";

            const div = document.createElement('div');
            div.className = 'item-card'; // 既存CSS流用
            div.style.display = "block"; // 縦並びにするため
            
            div.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px;">
                    <strong>${data.userName}</strong>
                    <span style="padding:3px 8px; border-radius:4px; color:white; font-size:0.8em; ${badgeStyle}">${statusLabel}</span>
                </div>
                <div style="font-size:0.9em; color:#333; margin-bottom:5px;">
                    <span style="font-weight:bold; color:#007bff;">[${typeLabel}]</span> ${date}<br>
                    理由: ${data.reason}
                </div>
                ${data.attachment ? `<div style="margin:5px 0;"><img src="${data.attachment}" style="max-width:100px; max-height:100px; border:1px solid #ccc;"></div>` : ''}
                
                <div style="margin-top:8px; text-align:right;">
                    <button onclick="updateReportStatus('${doc.id}', 'approved')" style="background:#28a745; padding:5px 10px; font-size:0.9em; margin-left:5px;">承認</button>
                    <button onclick="updateReportStatus('${doc.id}', 'confirm')" style="background:#ffc107; color:black; padding:5px 10px; font-size:0.9em; margin-left:5px;">確認</button>
                    <button onclick="updateReportStatus('${doc.id}', 'rejected')" style="background:#dc3545; padding:5px 10px; font-size:0.9em; margin-left:5px;">否認</button>
                </div>
            `;
            listEl.appendChild(div);
        });
    } catch(e) {
        listEl.innerHTML = '<p>読み込みエラー</p>';
        console.error(e);
        if(e.code === 'failed-precondition') {
            alert("インデックスが必要です。コンソールのリンクから作成してください。");
        }
    }
}

// ステータス更新処理
async function updateReportStatus(docId, newStatus) {
    if (!confirm(`ステータスを変更しますか？`)) return;
    
    try {
        await db.collection('absence_reports').doc(docId).update({
            status: newStatus
        });
        refreshReports(); // リスト再読み込み
    } catch(e) {
        alert("更新エラー: " + e.message);
    }
}