// @ts-nocheck
// script.js (ディープリンク方式 修正版)

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

// --- 顔データ保存/読み込み (変更なし) ---
function saveRegisteredFacesToStorage() {
  if (registeredFaces.length === 0) {
    localStorage.removeItem('faceAuthData');
  } else {
    const dataToSave = registeredFaces.map(face => ({
      label: face.label,
      thumbnail: face.thumbnail,
      descriptors: face.descriptors.map(d => Array.from(d)) 
    }));
    localStorage.setItem('faceAuthData', JSON.stringify(dataToSave));
  }
}
function loadRegisteredFacesFromStorage() {
  const data = localStorage.getItem('faceAuthData');
  if (!data) return;
  try {
    const parsedData = JSON.parse(data);
    registeredFaces = parsedData.map(face => ({
      label: face.label,
      thumbnail: face.thumbnail,
      descriptors: face.descriptors.map(d => new Float32Array(d)) 
    }));
  } catch (e) {
    console.error("顔登録データの読み込みに失敗しました:", e);
    localStorage.removeItem('faceAuthData'); 
  }
}

// --- GPSデータ保存/読み込み (変更なし) ---
function saveGpsAreasToStorage() {
  localStorage.setItem('faceAuthGpsAreas', JSON.stringify(registeredGpsAreas));
  console.log("GPSエリアデータを保存しました。");
}
function loadGpsAreasFromStorage() {
  const data = localStorage.getItem('faceAuthGpsAreas');
  if (!data) return;
  try {
    registeredGpsAreas = JSON.parse(data);
    console.log("GPSエリアデータを読み込みました:", registeredGpsAreas);
  } catch (e) {
    console.error("GPSエリアデータの読み込みに失敗しました:", e);
    localStorage.removeItem('faceAuthGpsAreas');
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
    // ★ toFixed(4) -> toFixed(7) に変更
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
  // 緯度経度の小さい方/大きい方に、さらにパディング(誤差)を加える
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
  // 必要なHTML要素を取得
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
            if (statusEl.textContent !== defaultStatus) statusEl.textContent = defaultStatus;
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
// (Web Bluetoothは localhost と https:// の両方で動作するため、変更不要)
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

// --- ★★★ 変更: WebSocket関連をすべて削除 ★★★ ---
// function connectIcWebSocket() { ... } // <-- 削除
// let icWebSocket = null; // <-- 削除
// const IC_WEBSOCKET_URL = "ws://localhost:12345"; // <-- 削除

// --- ★★★ 変更: handleIcScan をディープリンク方式に変更 ★★★ ---
/**
 * 「ICカードをスキャン」ボタンがクリックされたときに呼び出される関数。
 * ネイティブアプリ (Flutter) をカスタムURLスキームで呼び出す。
 */
function handleIcScan() {
    const icStatus = document.getElementById("icStatus");
    if (!icStatus) return;

    // 1. スキャン完了後に戻ってくるURLを作成
    // (現在のURLから ?... クエリパラメータを除いたもの)
    const returnUrl = location.origin + location.pathname;

    // 2. Flutterアプリを呼び出すためのURLスキームを作成
    // "club-agent://" は、ステップ2の Info.plist で設定する名前
    const appUrl = `club-agent://scan?return_url=${encodeURIComponent(returnUrl)}`;

    icStatus.textContent = "ICカードリーダーアプリを起動中...";

    // 3. ブラウザでURLを開く (これによりiOSがFlutterアプリを起動する)
    window.location.href = appUrl;

    // 4. アプリがインストールされていない場合に備え、
    //    短時間後にストアへ誘導するなどのフォールバック処理も可能 (ここでは省略)
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


// --- 12. ★修正★ 実行開始 ---
(async function main() {
  try {
    // 0. 共通ロード処理: 顔データとGPSデータをローカルストレージから読み込む
    loadRegisteredFacesFromStorage();
    loadGpsAreasFromStorage();

    // 1. ページIDに基づいてモードと要素を決定
    const bodyId = document.body.id;
    let video = null; 
    let statusEl = null; 

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
      
      // ★★★ 追加: ICカードの結果（URLパラメータ）をチェック ★★★
      const icStatus = document.getElementById("icStatus");
      if (icStatus) {
          const urlParams = new URLSearchParams(window.location.search);
          const cardId = urlParams.get('cardId');
          const nfcError = urlParams.get('nfcError');

          if (cardId) {
              icStatus.textContent = `✅ 認証成功: カードID ${cardId}`;
              // URLからクエリパラメータを削除して履歴をクリーンにする
              window.history.replaceState(null, '', window.location.pathname);
          } else if (nfcError) {
              icStatus.textContent = `❌ 認証失敗: ${decodeURIComponent(nfcError)}`;
              window.history.replaceState(null, '', window.location.pathname);
          } else {
              icStatus.textContent = "ICカードリーダーアプリと連携可能です。";
          }
      }
      // ★★★ ICカード結果チェックここまで ★★★
      
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

    // ★★★ 変更: WebSocket接続処理を削除 ★★★
    // if (currentMode === 'auth') { ... } // <-- 削除

    // 3. 顔認証が必要なページ (auth または reg) のみ、カメラとモデルを起動
    if (currentMode === 'auth' || currentMode === 'reg') {
      if (!video) throw new Error("顔認証に必要なVideo要素が見つかりません");
      if(statusEl) statusEl.textContent = "カメラを起動中...";
      await setupCamera(video);

      video.addEventListener('play', async () => {
        if(statusEl) statusEl.textContent = "モデルを読み込み中...";
        await loadModels();
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