// @ts-nocheck

// ★★★ 1. Firebase の初期化 (正しいブロックのみ) ★★★
const firebaseConfig = {
  apiKey: "AIzaSyD4fimqj2CE89w1qQRJG_fQGRH5GgUDf8Q",
  authDomain: "club-app-db.firebaseapp.com",
  projectId: "club-app-db",
  storageBucket: "club-app-db.firebasestorage.app",
  messagingSenderId: "993061804495",
  appId: "1:993061804495:web:9ca633885d8986d3f59aba",
  measurementId: "G-94JSQHYZR4"
};

// Firebaseアプリを初期化
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
// ★★★ 初期化ここまで ★★★


let faceMatcher;
let registeredFaces = []; 
let registeredGpsAreas = []; 

// --- モード管理 ---
let currentMode = 'auth'; 

// --- 平滑化設定 ---
const UPDATE_INTERVAL_MS = 200;
const HISTORY_MAX_LENGTH = 5;
const DETECTION_THRESHOLD = 3;
let detectionHistory = []; 
let isBoxVisible = false;
let lastGoodDetections = []; 

// --- GPS認証の誤差吸収 ---
const GPS_PADDING_DEGREES = 0.00005;

// --- 顔スキャン用ステートマシン ---
let scanStep = 0; 
let scanDescriptors = [];
let scanThumbnail = null; 
const scanInstructions = [
  "", "1/5: 正面...", "2/5: 顔を「左」...", "3/5: 顔を「右」...", "4/5: 顔を「上」...", "5/5: 顔を「下」...",
];

// --- GPSスキャン用ステートマシン ---
let gpsScanStep = 0; 
let tempGpsArea = {}; 

// --- ヘルパー関数 ---
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// --- 登録済み一覧の描画 (変更なし) ---
function populateRegisteredList() {
  const registeredList = document.getElementById("registeredList");
  if (!registeredList) return; 

  if (registeredFaces.length === 0) {
    registeredList.innerHTML = '<h3>登録済み一覧</h3><p>登録者はいません</p>';
    return;
  }
  registeredList.innerHTML = '<h3>登録済み一覧</h3>';
  registeredFaces.forEach(face => {
    const item = document.createElement('div');
    item.className = 'registered-item';
    
    const img = document.createElement('img');
    img.src = face.thumbnail;
    
    const name = document.createElement('span');
    name.textContent = face.label;
    
    // ★追加: 削除ボタン (定義を確実に行う)
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '削除';
    deleteBtn.className = 'delete-face-btn';
    deleteBtn.dataset.label = face.label;
    deleteBtn.style.marginLeft = 'auto';
    deleteBtn.style.backgroundColor = '#ffcccc';

    item.appendChild(img);
    item.appendChild(name);
    item.appendChild(deleteBtn); 
    registeredList.appendChild(item);
  });
}

// --- faceMatcher 再構築 (変更なし) ---
function rebuildFaceMatcher() {
  if (registeredFaces.length === 0) {
    faceMatcher = null;
    return;
  }
  const descriptorsToLoad = registeredFaces.map(face => {
    return new faceapi.LabeledFaceDescriptors(face.label, face.descriptors);
  });
  faceMatcher = new faceapi.FaceMatcher(descriptorsToLoad, 0.5); 
  console.log("faceMatcher を再構築しました。");
}

// --- ★ 修正 ★ 顔データ「単体」保存 (Base64対応版) ---
async function saveSingleFaceToFirestore(faceObject) {
  console.log(`Firestore への顔データ「${faceObject.label}」保存を開始...`);
  try {
    const dataToSave = {
      label: faceObject.label,
      thumbnail: faceObject.thumbnail,
      
      // ★★★ 修正箇所 (Dart互換のBase64エンコード) ★★★
      descriptors: faceObject.descriptors.map(d => {
        // d は Float32Array
        const uint8Array = new Uint8Array(d.buffer);
        // Uint8Arrayをbtoaで安全にエンコードするためのトリック
        let binaryString = '';
        uint8Array.forEach(byte => {
          binaryString += String.fromCharCode(byte);
        });
        return btoa(binaryString);
      })
    };
    await db.collection("faces").doc(faceObject.label).set(dataToSave);
    console.log("Firestore への顔データ保存が成功しました。");
  } catch (e) {
    console.error("Firestore への保存に失敗 (顔):", e);
    alert(`エラー: 顔「${faceObject.label}」のデータベース保存に失敗しました。\n\n詳細: ${e.message}`);
  }
}

// --- ★ 修正 ★ 顔データ「単体」削除 (エラー通知) ---
async function deleteFaceFromFirestore(faceLabel) {
  console.log(`Firestore から顔データ「${faceLabel}」削除を開始...`);
  try {
    const docRef = db.collection("faces").doc(faceLabel);
    await docRef.delete();
    console.log("Firestore からの顔データ削除が成功しました。");
  } catch (e) {
    console.error("Firestore からの削除に失敗 (顔):", e);
    alert(`エラー: 顔「${faceLabel}」のデータベース削除に失敗しました。\n\n詳細: ${e.message}`);
  }
}

// --- ★ 修正 ★ 顔データ読み込み (Base64対応版) ---
async function loadRegisteredFacesFromStorage() {
  console.log("Firestore から顔データを読み込み中...");
  try {
    const snapshot = await db.collection("faces").get();
    
    if (snapshot.empty) {
      console.log("Firestore に登録済みの顔はありません。");
      registeredFaces = [];
      return;
    }

    const loadedFaces = [];
    snapshot.forEach(doc => {
      const data = doc.data();

      const firstDescriptorLength = data.descriptors[0] ? atob(data.descriptors[0]).length : 0;
      if (firstDescriptorLength !== 128 * 4) { // 128 (次元) * 4 (Float32のバイト数) = 512
          console.warn(`[互換性なし] 顔データ「${data.label}」はFlutterアプリで登録されたデータのため、Web版ではスキップします。`);
          return; // forEachの次のループへ
      }
      
      loadedFaces.push({
        label: data.label,
        thumbnail: data.thumbnail,
        
        descriptors: data.descriptors.map(base64String => {
          const binaryString = atob(base64String);
          const uint8Array = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            uint8Array[i] = binaryString.charCodeAt(i);
          }
          return new Float32Array(uint8Array.buffer);
        })
      });
    });
    
    registeredFaces = loadedFaces;
    console.log(`Firestore から ${registeredFaces.length} 件の顔データを読み込みました。`);

  } catch (e) {
    console.error("Firestore からの顔データ読み込みに失敗しました:", e);
    registeredFaces = [];
  }
}

// --- ★ 修正 ★ GPSデータ「単体」保存 (エラー通知) ---
async function saveSingleGpsAreaToFirestore(areaObject) {
  console.log(`Firestore へのGPSエリア「${areaObject.name}」保存を開始...`);
  try {
    // 新データ構造
    const dataToSave = {
      name: areaObject.name,
      lat: areaObject.lat,
      lon: areaObject.lon,
      isActive: areaObject.isActive || false
    };
    const docRef = db.collection("gps_areas").doc(areaObject.name);
    await docRef.set(dataToSave);
    console.log("Firestore へのGPSエリアデータ保存が成功しました。");
  } catch (e) {
    console.error("Firestore への保存に失敗 (GPS):", e);
    alert(`エラー: GPSエリア「${areaObject.name}」のデータベース保存に失敗しました。\n\n詳細: ${e.message}`);
  }
}

// --- ★ 修正 ★ GPSデータ「単体」削除 (エラー通知) ---
async function deleteGpsAreaFromFirestore(areaName) {
  console.log(`Firestore からGPSエリア「${areaName}」削除を開始...`);
  try {
    const docRef = db.collection("gps_areas").doc(areaName);
    await docRef.delete();
    console.log("Firestore からのGPSエリア削除が成功しました。");
  } catch (e) {
    console.error("Firestore からの削除に失敗 (GPS):", e);
    alert(`エラー: GPSエリア「${areaName}」のデータベース削除に失敗しました。\n\n詳細: ${e.message}`);
  }
}

// --- ★ 変更なし ★ GPSデータ読み込み (Firebase版) ---
async function loadGpsAreasFromStorage() {
  console.log("Firestore からGPSエリアデータを読み込み中...");
  try {
    const snapshot = await db.collection("gps_areas").get();
    if (snapshot.empty) {
      console.log("Firestore に登録済みのGPSエリアはありません。");
      registeredGpsAreas = [];
      return;
    }
    const loadedGpsAreas = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      // ★修正: 新しいデータ構造に対応
      loadedGpsAreas.push({
        name: data.name,
        lat: data.lat, // 中心緯度
        lon: data.lon, // 中心経度
        isActive: data.isActive ?? false // 活動フラグ (なければfalse)
      });
    });
    registeredGpsAreas = loadedGpsAreas;
    console.log(`Firestore から ${registeredGpsAreas.length} 件のGPSエリアを読み込みました。`);
  } catch (e) {
    console.error("Firestore からのGPSエリア読み込みに失敗しました:", e);
    registeredGpsAreas = [];
  }
}

// --- GPSエリア一覧の描画 (変更なし) ---
function populateGpsAreaList() {
  const gpsAreaList = document.getElementById("gpsAreaList");
  if (!gpsAreaList) return;
  
  if (registeredGpsAreas.length === 0) {
    gpsAreaList.innerHTML = '<p>登録済みのエリアはありません。</p>';
    return;
  }
  
  gpsAreaList.innerHTML = '';
  registeredGpsAreas.forEach(area => {
    const item = document.createElement('div');
    item.style.marginBottom = '10px';
    item.style.padding = '5px';
    item.style.border = '1px solid #ddd';
    if(area.isActive) item.style.backgroundColor = '#e6ffec';

    // エリア情報
    const info = document.createElement('span');
    info.textContent = `[${area.name}] ${area.lat.toFixed(5)}, ${area.lon.toFixed(5)} (${area.isActive ? "活動中" : "停止中"})`;
    
    // ★追加: 削除ボタン (ここがエラーの原因でした)
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '削除';
    deleteBtn.className = 'delete-gps-btn';
    deleteBtn.dataset.name = area.name; // データ属性に名前を持たせる
    deleteBtn.style.marginLeft = '10px';
    deleteBtn.style.backgroundColor = '#ffcccc';
    
    item.appendChild(info);
    item.appendChild(deleteBtn);
    gpsAreaList.appendChild(item);
  });
}

// --- 距離計算 ---
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // 地球の半径 (メートル)
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // 距離 (メートル)
}

function handleGpsAuthentication() {
  const gpsStatus = document.getElementById("gpsStatus");
  gpsStatus.textContent = "現在地を取得中...";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const userLat = position.coords.latitude;
      const userLon = position.coords.longitude;
      
      let nearestArea = null;
      let minDistance = Infinity;
      const RADIUS = 100; // 半径100メートル

      registeredGpsAreas.forEach(area => {
        // 活動中のエリアのみ対象
        if (!area.isActive) return;

        const distance = calculateDistance(userLat, userLon, area.lat, area.lon);
        
        // 範囲内かつ、これまで見つけた中で最も近い場合
        if (distance <= RADIUS && distance < minDistance) {
          minDistance = distance;
          nearestArea = area;
        }
      });

      if (nearestArea) {
        gpsStatus.textContent = `✅ 認証成功: 「${nearestArea.name}」のエリア内にいます。(距離: 約${Math.round(minDistance)}m)`;
        // 必要ならここで認証成功後の処理 (顔認証へ進むボタンの有効化など)
      } else {
        gpsStatus.textContent = "❌ 認証失敗: 活動中のエリア内にいません。";
      }
    },
    (error) => {
      gpsStatus.textContent = "エラー: 位置情報の利用が拒否されました。";
      console.error(error);
    },
    {
        enableHighAccuracy: true, // 高精度モードを要求
        timeout: 10000,
        maximumAge: 0
    }
  );
}

// --- カメラ起動 (変更なし) ---
async function setupCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  videoEl.srcObject = stream;
  return new Promise(resolve => videoEl.onloadedmetadata = () => resolve(videoEl));
}

// --- モデル読み込み (変更なし) ---
async function loadModels() {
  await faceapi.nets.tinyFaceDetector.loadFromUri('models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('models');
}

// --- スキャンUIリセット処理 (変更なし) ---
function resetRegistrationUI(message = "登録モード: 顔を検出中...") {
  const statusEl = document.getElementById("status");
  const nameInput = document.getElementById("nameInput");
  const registerBtn = document.getElementById("registerBtn");
  scanStep = 0;
  scanDescriptors = [];
  scanThumbnail = null;
  if(statusEl) statusEl.textContent = message;
  if(registerBtn) {
    registerBtn.textContent = "スキャン開始 (5段階)";
    registerBtn.classList.remove("scanning");
    registerBtn.disabled = false;
  }
  if(nameInput) nameInput.disabled = false;
}

// --- ★ 修正 ★ 顔登録処理 (単体保存対応) ---
async function handleRegisterClick() {
  const nameInput = document.getElementById("nameInput");
  const registerBtn = document.getElementById("registerBtn");
  const statusEl = document.getElementById("status");

  if (!nameInput || !registerBtn || !statusEl) {
    console.error("登録UIの要素が見つかりません。");
    return;
  }
  const newName = nameInput.value.trim();

  // --- ステップ 0: スキャン開始 ---
  if (scanStep === 0) {
    if (!newName) {
      statusEl.textContent = "登録名を入力してください";
      return;
    }
    if (registeredFaces.some(f => f.label === newName)) {
        if (!confirm(`「${newName}」さんは既に登録されています。上書きしますか？`)) {
            return;
        }
    }
    scanStep = 1; 
    scanDescriptors = []; 
    scanThumbnail = null; 
    statusEl.textContent = scanInstructions[scanStep]; 
    registerBtn.textContent = `スキャン (${scanStep}/5)`; 
    registerBtn.classList.add("scanning"); 
    nameInput.disabled = true; 
    return;
  }

  // --- ステップ 1〜5: スキャン実行 ---
  if (scanStep >= 1 && scanStep <= 5) {
    registerBtn.disabled = true;
    statusEl.textContent = `スキャン中... (${scanStep}/5)`;
    
    if (!lastGoodDetections || lastGoodDetections.length === 0) {
      statusEl.textContent = `スキャン失敗: ${scanInstructions[scanStep]}。顔が検出されていません。`;
      registerBtn.disabled = false;
      return;
    }

    let largestUnknownFace = null;
    let maxArea = 0;
    let knownFaceFound = false;
    for (const d of lastGoodDetections) {
        let isKnown = false;
        if (faceMatcher) {
          const match = faceMatcher.findBestMatch(d.descriptor);
          if (match.label !== 'unknown') {
            isKnown = true; 
          }
        }
        if (!isKnown) {
          const area = d.detection.box.width * d.detection.box.height;
          if (area > maxArea) {
            maxArea = area;
            largestUnknownFace = d; 
          }
        } else {
          knownFaceFound = true;
        }
    }

    if (!largestUnknownFace) {
        const errorMsg = knownFaceFound 
          ? `スキャン失敗: 登録可能な「不明」な顔が見つかりません (登録済みの顔が映っています)`
          : `スキャン失敗: ${scanInstructions[scanStep]}。顔が検出されていません。`;
        statusEl.textContent = errorMsg;
        registerBtn.disabled = false;
        return;
    }

    if (scanStep === 1) {
      const video = document.getElementById("video");
      const canvas = document.getElementById("canvas"); 
      if (!video || !canvas) {
          console.error("サムネイルキャプチャ失敗: video または canvas が見つかりません。");
          scanThumbnail = null;
      } else {
          const tempCanvas = document.createElement('canvas');
          const box = largestUnknownFace.detection.box; 
          const padding = box.width * 0.2; 
          const scaleX = video.videoWidth / canvas.clientWidth;
          const scaleY = video.videoHeight / canvas.clientHeight;
          tempCanvas.width = box.width + padding * 2;
          tempCanvas.height = box.height + padding * 2;
          const tempCtx = tempCanvas.getContext('2d');
          tempCtx.drawImage(
            video,
            (box.x - padding) * scaleX, 
            (box.y - padding) * scaleY,
            (box.width + padding * 2) * scaleX, 
            (box.height + padding * 2) * scaleY,
            0, 0,
            tempCanvas.width, 
            tempCanvas.height
          );
          scanThumbnail = tempCanvas.toDataURL('image/jpeg', 0.8);
      }
    }
    
    scanDescriptors.push(largestUnknownFace.descriptor);
    scanStep++;

    if (scanStep > 5) {
      // --- ステップ 6: 登録完了 ---
      statusEl.textContent = "サンプリング完了。登録します。";
      registeredFaces = registeredFaces.filter(f => f.label !== newName);
      
      const newFaceObject = { 
          label: newName, 
          descriptors: scanDescriptors, 
          thumbnail: scanThumbnail 
      };
      
      registeredFaces.push(newFaceObject);
      rebuildFaceMatcher();
      
      // データベースには「この顔」だけを保存
      await saveSingleFaceToFirestore(newFaceObject); 
      
      populateRegisteredList();
      resetRegistrationUI(`${newName} さんを ${scanDescriptors.length} サンプルで登録しました`);
      nameInput.value = "";
    } else {
      statusEl.textContent = scanInstructions[scanStep];
      registerBtn.textContent = `スキャン (${scanStep}/5)`;
      registerBtn.disabled = false;
    }
  }
}

// --- 描画ヘルパー関数 (変更なし) ---
function drawBox(detections) {
  const canvas = document.getElementById("canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!canvas || !ctx) return;
  const displaySize = { width: canvas.clientWidth, height: canvas.clientHeight };
  faceapi.matchDimensions(canvas, displaySize);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  detections.forEach(d => {
    const box = d.box;
    const name = d.name;
    let strokeStyle = "#FF0000"; 
    let drawGrid = true;        
    if (name !== "不明") {
      strokeStyle = "#00FF00"; 
      drawGrid = false;       
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 4;
    const padding = 10;
    const x = box.x - padding, y = box.y - padding, w = box.width + (padding * 2), h = box.height + (padding * 2);
    ctx.strokeRect(x, y, w, h);
    if (drawGrid) {
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w / 2, y + h);
      ctx.moveTo(x, y + h / 2);
      ctx.lineTo(x + w, y + h / 2);
      ctx.stroke();
    }
    ctx.fillStyle = strokeStyle;
    ctx.font = "18px sans-serif";
    ctx.fillText(name, x, y > 20 ? y - 5 : y + h + 18);
  });
}

// --- ★ 新規 ★ 管理者への認証リクエスト送信 ---
async function sendAuthRequestToAdmin(authType) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "管理者に承認リクエストを送信中...";

  // ユーザー名の取得 (簡易的にプロンプト、またはログイン情報から)
  let userName = prompt("あなたの名前を入力してください", "");
  if (!userName) {
    statusEl.textContent = "名前が必要です。";
    return;
  }

  try {
    // リクエスト作成
    const docRef = await db.collection('auth_requests').add({
      userName: userName,
      authType: authType, // 'code' or 'nfc'
      status: 'pending',
      requestTimestamp: firebase.firestore.FieldValue.serverTimestamp(),
      gps_valid: true, // GPSチェック通過済みとする
      face_valid: true, // 顔認証通過済みとする
      platform: 'web'
    });

    statusEl.textContent = "管理者の承認待ちです... この画面のままお待ちください。";

    // 承認状態を監視
    docRef.onSnapshot((snapshot) => {
      const data = snapshot.data();
      if (data && data.status === 'approved') {
        statusEl.innerHTML = `<span style="color:green; font-size:1.5em;">✅ 認証成功！</span><br>出席が記録されました。`;
        // 必要に応じてCanvas等をクリア
      } else if (data && data.status === 'rejected') {
        statusEl.textContent = "❌ 管理者に否認されました。";
      }
    });

  } catch (e) {
    console.error(e);
    statusEl.textContent = "リクエスト送信エラー: " + e.message;
  }
}

// --- 認証/登録フェーズの処理 (変更なし) ---
function handleFaceProcessing(detections) {
  const statusEl = document.getElementById("status");
  if (!statusEl) return; 
  let currentDetectionsToDraw = [];
  const assignedLabels = new Set(); 
  if (faceMatcher && registeredFaces.length > 0) {
    const allMatches = detections.map(d => ({
      detection: d, 
      bestMatch: faceMatcher.findBestMatch(d.descriptor) 
    }));
    allMatches.sort((a, b) => a.bestMatch.distance - b.bestMatch.distance);
    allMatches.forEach(match => {
      const label = match.bestMatch.label;
      let name = "不明";
      if (label !== 'unknown') {
        if (!assignedLabels.has(label)) {
          name = label;
          assignedLabels.add(label); 
        } else {
          name = "不明";
        }
      }
      currentDetectionsToDraw.push({ box: match.detection.detection.box, name: name });
    });
  } else {
      detections.forEach(d => {
        currentDetectionsToDraw.push({ box: d.detection.box, name: "不明" });
      });
  }
  drawBox(currentDetectionsToDraw);
  // 認証モードかつ、顔が登録済みユーザーと一致した場合
  if (currentMode === 'auth') {
    // detections の中に "不明" 以外の顔があるかチェック
    const match = detections.find(d => d.name !== "不明");
    
    if (match) {
      // 連続検出回数のチェックなどを経て...
      // ★ 変更点: ここで完了にするのではなく、次のステップ(管理者承認)へ進む
      
      // 一旦ループを停止 (重複リクエスト防止)
      // 注: 実際にはフラグ管理が必要
      if (!window.requestSent) {
        window.requestSent = true; 
        
        // ユーザーに認証方法を選ばせる、もしくはデフォルト(Code)で進む
        if (confirm(`${match.name} さんとして認証リクエストを送信しますか？`)) {
           // WebではNFCは難しいのでカラーコードモードと仮定
           sendAuthRequestToAdmin('code'); 
        } else {
           window.requestSent = false;
        }
      }
    }
  } else if (currentMode === 'reg') { 
    if (scanStep === 0) { 
      const newStatus = "登録モード: 準備完了";
      if (statusEl.textContent !== newStatus) statusEl.textContent = newStatus;
    } else { 
      const newStatus = scanInstructions[scanStep];
      if (statusEl.textContent !== newStatus) statusEl.textContent = newStatus;
    }
  }
}

// --- メインの検出ループ (変更なし) ---
async function mainLoop() {
  const video = document.getElementById("video");
  const canvas = document.getElementById("canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  const statusEl = document.getElementById("status");
  if (!video || !canvas || !ctx) return; 
  const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
  const displaySize = { width: canvas.clientWidth, height: canvas.clientHeight };
  const resizedDetections = faceapi.resizeResults(detections, displaySize);
  detectionHistory.push(detections.length > 0 ? 1 : 0);
  if (detectionHistory.length > HISTORY_MAX_LENGTH) detectionHistory.shift(); 
  const detectionCount = detectionHistory.reduce((total, val) => total + val, 0);
  isBoxVisible = (detectionCount >= DETECTION_THRESHOLD);
  if (detections.length > 0) {
      lastGoodDetections = resizedDetections; 
  }
  if (isBoxVisible && lastGoodDetections.length > 0) {
    handleFaceProcessing(lastGoodDetections);
  } else {
    lastGoodDetections = [];
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); 
    if (statusEl) {
        const defaultStatus = "検出中... (顔をカメラに向けてください)";
        if (currentMode === 'auth') {
            const newStatus = "認証中..."; // (mainLoop内で '認証中...' が設定されていなかったバグを修正)
            if (statusEl.textContent !== defaultStatus && statusEl.textContent !== newStatus) {
                statusEl.textContent = defaultStatus;
            }
        } else if (currentMode === 'reg') {
            if (scanStep === 0) {
                if (statusEl.textContent !== defaultStatus) statusEl.textContent = defaultStatus;
            } else { 
                const instruction = scanInstructions[scanStep] || "";
                const lostStatus = `${instruction} (顔を検出できません)`;
                if (statusEl.textContent !== lostStatus) statusEl.textContent = lostStatus;
            }
        }
    }
  }
}

// --- GPS登録ハンドラ (手入力のみ) ---
// (script.js にこの関数を置き換えてください)
function handleGpsRegistration() {
  const adminStatus = document.getElementById("adminStatus");
  const nameInput = document.getElementById("areaNameInput");
  // 緯度・経度の入力欄 (HTML側に追加されている前提)
  const latInput = document.getElementById("areaLatInput");
  const lonInput = document.getElementById("areaLonInput");

  if (!nameInput || !latInput || !lonInput) {
      adminStatus.textContent = "エラー: 必要な入力欄が見つかりません。";
      return;
  }

  const areaName = nameInput.value.trim();
  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);

  if (!areaName || isNaN(lat) || isNaN(lon)) {
    adminStatus.textContent = "エラー: 正しい値を入力してください。";
    return;
  }

  // 重複チェックなど...

  const newArea = { name: areaName, lat: lat, lon: lon, isActive: false };
  saveSingleGpsAreaToFirestore(newArea);
  
  // リスト更新
  registeredGpsAreas = registeredGpsAreas.filter(a => a.name !== areaName);
  registeredGpsAreas.push(newArea);
  populateGpsAreaList();
  
  adminStatus.textContent = `✅ 登録成功: ${areaName}`;
  nameInput.value = "";
  latInput.value = "";
  lonInput.value = "";
}

// --- ビーコンスキャンハンドラ (変更なし) ---
async function handleBeaconScan() {
  const beaconStatus = document.getElementById("beaconStatus");
  if (!beaconStatus) return;
  if (!navigator.bluetooth) {
    beaconStatus.textContent = "エラー: お使いのブラウザは Web Bluetooth に対応していません。";
    return;
  }
  beaconStatus.textContent = "ビーコンをスキャン中... (ブラウザの許可を求めています)";
  try {
    const device = await navigator.bluetooth.requestDevice({
        filters: [{
            services: ['battery_service'] // UUID: 0x180F
        }],
    });
    beaconStatus.textContent = `✅ ビーコン検出成功: ${device.name || `ID: ${device.id}`}`;
  } catch (error) {
    if (error.name === 'NotFoundError') {
      beaconStatus.textContent = "❌ スキャン失敗: 付近に対応するビーコンが見つかりませんでした。";
    } else if (error.name === 'NotAllowedError') {
       beaconStatus.textContent = "エラー: Bluetoothデバイスへのアクセスが許可されませんでした。";
    } else {
       console.error('Web Bluetooth スキャンエラー:', error);
       beaconStatus.textContent = `エラー: スキャン中に問題が発生しました (${error.name})。`;
    }
  }
}

// --- ICカードスキャンハンドラ (変更なし) ---
function handleIcScan() {
    const icStatus = document.getElementById("icStatus");
    if (!icStatus) return;
    const returnUrl = location.origin + location.pathname;
    const appUrl = `club-agent://scan?return_url=${encodeURIComponent(returnUrl)}`;
    icStatus.textContent = "ICカードリーダーアプリを起動中...";
    window.location.href = appUrl;
}


// --- ★ 修正 ★ イベントリスナー設定 (単体削除対応) ---
function setupEventListeners() {
  // 登録フェーズ (settings.html)
  if (currentMode === 'reg') {
    document.getElementById("registerBtn")?.addEventListener("click", handleRegisterClick);
  }

  // 認証フェーズ (attendance.html)
  if (currentMode === 'auth') {
    document.getElementById("gpsAuthBtn")?.addEventListener("click", handleGpsAuthentication);
    document.getElementById("beaconScanBtn")?.addEventListener("click", handleBeaconScan);
    document.getElementById("icScanBtn")?.addEventListener("click", handleIcScan);
  }

  // 管理者ページ (admin-gps.html)
  if (currentMode === 'admin-gps') {
    const adminStatus = document.getElementById("adminStatus"); 
    
    document.getElementById("registerAreaBtn")?.addEventListener("click", handleGpsRegistration);
    
    // GPS全削除ボタン
    document.getElementById("clearAllGpsBtn")?.addEventListener("click", () => {
      if (confirm("本当にすべての「GPSエリア」登録データを削除しますか？")) {
        (async () => {
          for (const area of registeredGpsAreas) {
            await deleteGpsAreaFromFirestore(area.name);
          }
        })();
        registeredGpsAreas = []; 
        populateGpsAreaList(); 
        if(adminStatus) adminStatus.textContent = "全GPSエリアを削除しました。"; 
      }
    });
    
    // 顔 全削除ボタン
    document.getElementById("clearAllFacesBtn")?.addEventListener("click", () => {
      if (confirm("本当にすべての「顔」登録データを削除しますか？")) {
        (async () => {
          for (const face of registeredFaces) {
            await deleteFaceFromFirestore(face.label);
          }
        })();
        registeredFaces = []; 
        rebuildFaceMatcher(); 
        populateRegisteredList(); 
        if(adminStatus) adminStatus.textContent = "全顔データを削除しました。"; 
      }
    });

    const registeredListElement = document.getElementById('registeredList');
    const gpsAreaListElement = document.getElementById('gpsAreaList');

    // 顔 個別削除リスナー
    if (registeredListElement) {
      registeredListElement.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('delete-face-btn')) {
          const label = e.target.dataset.label;
          if (confirm(`顔データ「${label}」を削除しますか？`)) {
            registeredFaces = registeredFaces.filter(f => f.label !== label);
            rebuildFaceMatcher();
            deleteFaceFromFirestore(label);
            populateRegisteredList(); 
            if (adminStatus) adminStatus.textContent = `顔データ「${label}」を削除しました。`;
          }
        }
      });
    }

    // GPS 個別削除リスナー
    if (gpsAreaListElement) {
      gpsAreaListElement.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('delete-gps-btn')) {
          const areaName = e.target.dataset.name;
          if (confirm(`GPSエリア「${areaName}」を削除しますか？`)) {
            registeredGpsAreas = registeredGpsAreas.filter(a => a.name !== areaName);
            deleteGpsAreaFromFirestore(areaName);
            populateGpsAreaList();
             if (adminStatus) adminStatus.textContent = `GPSエリア「${areaName}」を削除しました。`;
          }
        }
      });
    }
  }
}


// --- 12. ★★★ 修正 ★★★ 実行開始 (Firebase対応) ---
(async function main() {
  try {
    // 0. Firestoreからの読み込みが完了するまで「待つ」
    await loadRegisteredFacesFromStorage();
    await loadGpsAreasFromStorage(); 

    // 1. ページIDに基づいてモードと要素を決定
    const bodyId = document.body.id;
    let video = null; 
    let statusEl = null; 

    const icScanBtn = document.getElementById("icScanBtn");
    const beaconScanBtn = document.getElementById("beaconScanBtn");
    
    // 拡張機能のサポート判定
    if (beaconScanBtn) {
        if (!navigator.bluetooth) {
            beaconScanBtn.style.display = 'none';
            const beaconStatus = document.getElementById("beaconStatus");
            if (beaconStatus) beaconStatus.textContent = "このブラウザはBLEスキャンに非対応です。";
        }
    }
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (icScanBtn) {
        if (!isIOS) {
            icScanBtn.style.display = 'none';
            const icStatus = document.getElementById("icStatus");
            if (icStatus) icStatus.textContent = "ICスキャンはiPhone/iPadでのみ連携可能です。";
        }
    }

    if (bodyId === 'page-reg') {
      currentMode = 'reg';
      video = document.getElementById("video");
      statusEl = document.getElementById("status");
      rebuildFaceMatcher(); 
    } else if (bodyId === 'page-auth') { 
      currentMode = 'auth';
      video = document.getElementById("video");
      statusEl = document.getElementById("status");
      rebuildFaceMatcher();
      
      const icStatus = document.getElementById("icStatus");
      if (icStatus && isIOS) { 
          const urlParams = new URLSearchParams(window.location.search);
          const cardId = urlParams.get('cardId');
          const nfcError = urlParams.get('nfcError');
          if (cardId) {
              icStatus.textContent = `✅ 認証成功: カードID ${cardId}`;
              window.history.replaceState(null, '', window.location.pathname);
          } else if (nfcError) {
              icStatus.textContent = `❌ 認証失敗: ${decodeURIComponent(nfcError)}`;
              window.history.replaceState(null, '', window.location.pathname);
          } else {
              icStatus.textContent = "ICカードリーダーアプリと連携可能です。";
          }
      }
      
    } else if (bodyId === 'page-admin-gps') {
      currentMode = 'admin-gps';
      statusEl = document.getElementById("adminStatus");
      populateRegisteredList(); 
      populateGpsAreaList();
    } else { 
      currentMode = 'none';
      return; 
    }

    if(statusEl) statusEl.textContent = "初期化中...";

    // 2. イベントリスナーを設定
    setupEventListeners();

    // 3. 顔認証が必要なページ (auth または reg) のみ、カメラとモデルを起動
    if (currentMode === 'auth' || currentMode === 'reg') {
      if (!video) throw new Error("顔認証に必要なVideo要素が見つかりません");
      if(statusEl) statusEl.textContent = "カメラを起動中...";
      await setupCamera(video);

      video.addEventListener('play', async () => {
        if(statusEl) statusEl.textContent = "モデルを読み込み中...";
        
        // (GitHub Pages用のパス修正)
        await faceapi.nets.tinyFaceDetector.loadFromUri('models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('models');

        if(statusEl) statusEl.textContent = "カメラ再生開始。検出ループをスタートします。";
        setInterval(mainLoop, UPDATE_INTERVAL_MS); 
      });

      await video.play();

    } else if (currentMode === 'admin-gps') {
       if(statusEl) statusEl.textContent = "準備完了";
    }

  } catch (e) {
    console.error(e);
    const finalStatusEl = document.getElementById("status") || document.getElementById("adminStatus");
    if (finalStatusEl) {
       if (e.name === "NotAllowedError") {
         finalStatusEl.textContent = "エラー: カメラ/マイクへのアクセスが許可されませんでした。";
       } else {
         finalStatusEl.textContent = `エラー: ${e.message}`;
       }
    }
  }
})();