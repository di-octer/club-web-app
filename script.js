// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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
firebase.initializeApp(firebaseConfig);
// Firestore データベースのインスタンスを取得
const db = firebase.firestore();

// --- これ以降は、あなたがアップロードした script.js (L26以降) と同じです ---

let faceMatcher;
let registeredFaces = []; 
let registeredGpsAreas = []; 

// --- モード管理 ---
let currentMode = 'auth'; 

// --- 平滑化設定 (変更なし) ---
const UPDATE_INTERVAL_MS = 200;
const HISTORY_MAX_LENGTH = 5;
const DETECTION_THRESHOLD = 3;
let detectionHistory = []; 
let isBoxVisible = false;
let lastGoodDetections = []; 

// --- ★追加★ GPS認証の誤差吸収 (約11メートル) ---
const GPS_PADDING_DEGREES = 0.00005;

// --- 顔スキャン用ステートマシン (変更なし) ---
let scanStep = 0; 
let scanDescriptors = [];
let scanThumbnail = null; 
const scanInstructions = [
  "", "1/5: 正面...", "2/5: 顔を「左」...", "3/5: 顔を「右」...", "4/5: 顔を「上」...", "5/5: 顔を「下」...",
];

// --- GPSスキャン用ステートマシン (変更なし) ---
let gpsScanStep = 0; 
let tempGpsArea = {}; 

// --- ヘルパー関数 (変更なし) ---
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

// --- 顔データ保存 (Firebase版) ---
async function saveRegisteredFacesToStorage() {
  if (registeredFaces.length === 0) {
    // TODO: Firestoreから全件削除する処理 (ここでは省略)
    console.log("顔データが0件です。");
    return;
  }
  
  console.log("Firestore への顔データ保存を開始...");
  const batch = db.batch();

  registeredFaces.forEach(face => {
    const dataToSave = {
      label: face.label,
      thumbnail: face.thumbnail,
      // Float32Array を Firestore が保存できる通常の配列に変換
      descriptors: face.descriptors.map(d => Array.from(d)) 
    };
    
    // 'faces' コレクションに、label (名前) をドキュメントIDとして保存
    const docRef = db.collection("faces").doc(face.label);
    batch.set(docRef, dataToSave);
  });

  try {
    await batch.commit();
    console.log("Firestore への顔データ保存が成功しました。");
  } catch (e) {
    console.error("Firestore への保存に失敗しました:", e);
  }
}

// --- 顔データ読み込み (Firebase版) ---
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
      // Firestore の配列から Float32Array に変換し直す
      loadedFaces.push({
        label: data.label,
        thumbnail: data.thumbnail,
        descriptors: data.descriptors.map(d => new Float32Array(d))
      });
    });
    
    registeredFaces = loadedFaces;
    console.log(`Firestore から ${registeredFaces.length} 件の顔データを読み込みました。`);

  } catch (e) {
    console.error("Firestore からの顔データ読み込みに失敗しました:", e);
    registeredFaces = [];
  }
}

// --- GPSデータ保存 (Firebase版) ---
async function saveGpsAreasToStorage() {
  if (registeredGpsAreas.length === 0) {
    // TODO: Firestoreから全件削除する処理 (ここでは省略)
    console.log("GPSエリアデータが0件です。");
    return;
  }
  
  console.log("Firestore へのGPSエリアデータ保存を開始...");
  const batch = db.batch();

  registeredGpsAreas.forEach(area => {
    // GPSデータはそのまま保存できる
    const dataToSave = {
      name: area.name,
      lat1: area.lat1,
      lon1: area.lon1,
      lat2: area.lat2,
      lon2: area.lon2
    };
    
    // 'gps_areas' コレクションに、name (エリア名) をドキュメントIDとして保存
    const docRef = db.collection("gps_areas").doc(area.name);
    batch.set(docRef, dataToSave);
  });

  try {
    await batch.commit();
    console.log("Firestore へのGPSエリアデータ保存が成功しました。");
  } catch (e) {
    console.error("Firestore へのGPSエリア保存に失敗しました:", e);
  }
}

// --- GPSデータ読み込み (Firebase版) ---
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
      // GPSデータは変換不要
      loadedGpsAreas.push({
        name: data.name,
        lat1: data.lat1,
        lon1: data.lon1,
        lat2: data.lat2,
        lon2: data.lon2
      });
    });
    
    registeredGpsAreas = loadedGpsAreas;
    console.log(`Firestore から ${registeredGpsAreas.length} 件のGPSエリアを読み込みました。`);

  } catch (e) {
    console.error("Firestore からのGPSエリア読み込みに失敗しました:", e);
    registeredGpsAreas = [];
  }
}

// --- ★修正★ GPSエリア一覧の描画 (詳細表示) ---
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
    item.style.display = 'flex';
    item.style.alignItems = 'center';
    item.style.marginBottom = '5px';

    const li = document.createElement('span');
    li.textContent = `[${area.name}] (端1: ${area.lat1.toFixed(7)}, ${area.lon1.toFixed(7)} / 端2: ${area.lat2.toFixed(7)}, ${area.lon2.toFixed(7)})`;
    
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '削除';
    deleteBtn.className = 'delete-gps-btn';
    deleteBtn.dataset.name = area.name; 
    deleteBtn.style.marginLeft = 'auto';
    deleteBtn.style.backgroundColor = '#ffcccc';

    item.appendChild(li);
    item.appendChild(deleteBtn);
    gpsAreaList.appendChild(item);
  });
}

// --- ★修正★ 四角形エリアの内外判定 (パディング追加) ---
function isInsideBoundingBox(userLat, userLon, area) {
  const minLat = Math.min(area.lat1, area.lat2) - GPS_PADDING_DEGREES;
  const maxLat = Math.max(area.lat1, area.lat2) + GPS_PADDING_DEGREES;
  const minLon = Math.min(area.lon1, area.lon2) - GPS_PADDING_DEGREES;
  const maxLon = Math.max(area.lon1, area.lon2) + GPS_PADDING_DEGREES;
  
  return (userLat >= minLat && userLat <= maxLat &&
          userLon >= minLon && userLon <= maxLon);
}

// --- 2. カメラ起動 (変更なし) ---
async function setupCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  videoEl.srcObject = stream;
  return new Promise(resolve => videoEl.onloadedmetadata = () => resolve(videoEl));
}

// --- 3. モデル読み込み (変更なし) ---
async function loadModels() {
  // (GitHub Pages用のパス修正済み)
  await faceapi.nets.tinyFaceDetector.loadFromUri('models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('models');
}

// --- 4. ★修正★ スキャンUIリセット処理 (キャンバスクリアを削除) ---
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

// --- 6. ★修正★ 顔登録処理 (サムネイルのズレを修正) ---
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
    statusEl.textContent = scanInstructions[scanStep]; // 最初の指示
    registerBtn.textContent = `スキャン (${scanStep}/5)`; 
    registerBtn.classList.add("scanning"); 
    nameInput.disabled = true; 
    
    return;
  }

  // --- ステップ 1〜5: スキャン実行 (ボタン押下時の処理) ---
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
      registeredFaces.push({ label: newName, descriptors: scanDescriptors, thumbnail: scanThumbnail });
      
      rebuildFaceMatcher();
      saveRegisteredFacesToStorage();
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

// --- 7. ★修正★ 描画専用のヘルパー関数 (変更なし) ---
function drawBox(detections) {
  const canvas = document.getElementById("canvas");
  const ctx = canvas ? canvas.getContext("2d") : null;
  if (!canvas || !ctx) return;

  const displaySize = { width: canvas.clientWidth, height: canvas.clientHeight };
  faceapi.matchDimensions(canvas, displaySize);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  detections.forEach(d => {
    const box = d.box;
    const name = d.name; // "不明" または 登録名

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

// --- 8 & 9. ★修正★ 認証/登録フェーズの処理 (変更なし) ---
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

  if (currentMode === 'auth') {
    const newStatus = "認証中...";
    if (statusEl.textContent !== newStatus) statusEl.textContent = newStatus;
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

// --- 10. ★修正★ メインの検出ループ (変更なし) ---
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
            if (statusEl.textContent !== newStatus) statusEl.textContent = defaultStatus;
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

// --- GPS認証ハンドラ (変更なし) ---
function handleGpsAuthentication() {
  const gpsStatus = document.getElementById("gpsStatus");
  gpsStatus.textContent = "現在地を取得中...";

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const userLat = position.coords.latitude;
      const userLon = position.coords.longitude;
      
      let inArea = false;
      let areaName = "";
      
      for (const area of registeredGpsAreas) {
        if (isInsideBoundingBox(userLat, userLon, area)) {
          inArea = true;
          areaName = area.name;
          break;
        }
      }
      
      if (inArea) {
        gpsStatus.textContent = `✅ 認証成功: 「${areaName}」のエリア内にいます。`;
      } else {
        gpsStatus.textContent = "❌ 認証失敗: 登録済みのエリア内にいません。";
      }
    },
    (error) => {
      gpsStatus.textContent = "エラー: 位置情報の利用が拒否されました。";
    }
  );
}

// --- GPS登録ハンドラ (ステートマシン) (変更なし) ---
function handleGpsRegistration() {
  const adminStatus = document.getElementById("adminStatus");
  const nameInput = document.getElementById("areaNameInput");
  const registerBtn = document.getElementById("registerAreaBtn");

  if (gpsScanStep === 0) {
    const areaName = nameInput.value.trim();
    if (!areaName) {
      adminStatus.textContent = "エラー: エリア名を入力してください。";
      return;
    }
    tempGpsArea = { name: areaName };
    gpsScanStep = 1;
    adminStatus.textContent = "エリアの「1つ目の端」に移動し、ボタンを押してください。";
    registerBtn.textContent = "2. 1つ目の端を登録";
    registerBtn.style.backgroundColor = "#ffc107";
    nameInput.disabled = true;
    return;
  }
  if (gpsScanStep === 1 || gpsScanStep === 2) {
    adminStatus.textContent = `座標を取得中... (${gpsScanStep}/2)`;
    registerBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (gpsScanStep === 1) {
          tempGpsArea.lat1 = position.coords.latitude;
          tempGpsArea.lon1 = position.coords.longitude;
          gpsScanStep = 2;
          adminStatus.textContent = `1点目 登録完了。エリアの「対角の端」に移動し、ボタンを押してください。`;
          registerBtn.textContent = "3. 2つ目の端を登録して完了";
          registerBtn.disabled = false;
        } else if (gpsScanStep === 2) {
          tempGpsArea.lat2 = position.coords.latitude;
          tempGpsArea.lon2 = position.coords.longitude;
          registeredGpsAreas.push(tempGpsArea);
          saveGpsAreasToStorage();
          populateGpsAreaList(); 
          adminStatus.textContent = `✅ 登録成功: 「${tempGpsArea.name}」を登録しました。`;
          gpsScanStep = 0;
          tempGpsArea = {};
          registerBtn.textContent = "1. エリア定義を開始";
          registerBtn.style.backgroundColor = "#28a745";
          registerBtn.disabled = false;
          nameInput.disabled = false;
          nameInput.value = "";
        }
      },
      (error) => {
        adminStatus.textContent = "エラー: 位置情報が取得できません。";
        registerBtn.disabled = false; 
      }
    );
  }
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

// --- ★★★ 変更: handleIcScan をディープリンク方式に変更 ★★★ ---
function handleIcScan() {
    const icStatus = document.getElementById("icStatus");
    if (!icStatus) return;

    const returnUrl = location.origin + location.pathname;
    const appUrl = `club-agent://scan?return_url=${encodeURIComponent(returnUrl)}`;
    icStatus.textContent = "ICカードリーダーアプリを起動中...";
    window.location.href = appUrl;
}


// --- 11. ★修正★ イベントリスナー設定 (個別削除バグ修正) ---
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
    // GPS登録ボタン
    document.getElementById("registerAreaBtn")?.addEventListener("click", handleGpsRegistration);
    // GPS全削除ボタン
    document.getElementById("clearAllGpsBtn")?.addEventListener("click", () => {
      if (confirm("本当にすべての「GPSエリア」登録データを削除しますか？")) {
        registeredGpsAreas = []; 
        saveGpsAreasToStorage(); 
        populateGpsAreaList(); 
        const adminStatus = document.getElementById("adminStatus"); 
        if(adminStatus) adminStatus.textContent = "全GPSエリアを削除しました。"; 
      }
    });
    // 顔 全削除ボタン
    document.getElementById("clearAllFacesBtn")?.addEventListener("click", () => {
      if (confirm("本当にすべての「顔」登録データを削除しますか？")) {
        registeredFaces = []; 
        rebuildFaceMatcher(); 
        saveRegisteredFacesToStorage(); 
        populateRegisteredList(); 
        const adminStatus = document.getElementById("adminStatus"); 
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
            saveRegisteredFacesToStorage();
            populateRegisteredList(); 
            const adminStatus = document.getElementById("adminStatus");
            if (adminStatus) adminStatus.textContent = `顔データ「${label}」を削除しました。`;
          }
        }
      });
    }

    // GPS個別削除リスナー
    if (gpsAreaListElement) {
      gpsAreaListElement.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('delete-gps-btn')) {
          const areaName = e.target.dataset.name;
          if (confirm(`GPSエリア「${areaName}」を削除しますか？`)) {
            registeredGpsAreas = registeredGpsAreas.filter(a => a.name !== areaName);
            saveGpsAreasToStorage();
            populateGpsAreaList();
            const adminStatus = document.getElementById("adminStatus");
             if (adminStatus) adminStatus.textContent = `GPSエリア「${areaName}」を削除しました。`;
          }
        }
      });
    }
  }
}


// --- 12. ★修正★ 実行開始 (Firebase対応) ---
(async function main() {
  try {
    // 0. ★変更★ 
    // Firestoreからの読み込みが完了するまで「待つ」
    await loadRegisteredFacesFromStorage();
    await loadGpsAreasFromStorage(); 

    // 1. ページIDに基づいてモードと要素を決定
    const bodyId = document.body.id;
    let video = null; 
    let statusEl = null; 

    // ★★★ 追加: 拡張機能ボタンの取得 ★★★
    const icScanBtn = document.getElementById("icScanBtn");
    const beaconScanBtn = document.getElementById("beaconScanBtn");
    
    // ★★★ 追加: 拡張機能のサポート判定 ★★★
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
    // ★★★ 拡張機能の判定ここまで ★★★

    if (bodyId === 'page-reg') {
      currentMode = 'reg';
      video = document.getElementById("video");
      statusEl = document.getElementById("status");
      // ★重要★ 読み込みが終わってから faceMatcher を構築
      rebuildFaceMatcher(); 
    } else if (bodyId === 'page-auth') { 
      currentMode = 'auth';
      video = document.getElementById("video");
      statusEl = document.getElementById("status");
      // ★重要★ 読み込みが終わってから faceMatcher を構築
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