let currentMapConfig = null;
let mapImage = null;
let mapCanvas, mapCtx;
let mapScale = 1.0;
let mapOffsetX = 0, mapOffsetY = 0;

// ドラッグ操作用変数
let isDragging = false;
let startX, startY;

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Canvas初期化
    mapCanvas = document.getElementById('mapCanvas');
    mapCtx = mapCanvas.getContext('2d');
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    
    // 2. イベントリスナー登録 (ドラッグ操作)
    initMapEvents();

    // 3. ナビゲーションバー等の共通初期化待ち
    // (pre_common.jsのcurrentUserロード等を待つ場合はここで調整)
    
    // 4. キャンパス一覧ロード
    await loadMapCampuses();
});

function resizeCanvas() {
    mapCanvas.width = window.innerWidth;
    mapCanvas.height = window.innerHeight;
    if(mapImage) drawMap();
}

// --- キャンパスデータ読み込み ---
async function loadMapCampuses() {
    const select = document.getElementById('mapCampusSelect');
    select.innerHTML = '<option value="">キャンパスを選択...</option>';

    try {
        const snap = await db.collection('campuses').orderBy('order').get();
        if(snap.empty) return;
        
        let firstCid = null;
        snap.forEach(doc => {
            const d = doc.data();
            const opt = document.createElement('option');
            opt.value = doc.id;
            opt.textContent = d.name;
            select.appendChild(opt);
            if(!firstCid) firstCid = doc.id;
        });
        
        // デフォルトキャンパスを選択 (設定があればそれ、なければ最初)
        // ※ userSettings は pre_common.js で定義されていると想定
        if (typeof userSettings !== 'undefined' && userSettings.defaultCampusId) {
            select.value = userSettings.defaultCampusId;
            loadCampusMapData(userSettings.defaultCampusId);
        } else if (firstCid) {
            select.value = firstCid;
            loadCampusMapData(firstCid);
        }
    } catch(e) { console.error(e); }
}

async function changeMapCampus() {
    const cid = document.getElementById('mapCampusSelect').value;
    if(cid) loadCampusMapData(cid);
}

async function loadCampusMapData(cid) {
    try {
        const doc = await db.collection('campuses').doc(cid).get();
        if(!doc.exists) return;
        
        const data = doc.data();
        const mapSrc = (data.mapConfig) ? (data.mapConfig.image || data.mapConfig.imageUrl) : null;

        if(mapSrc) {
            currentMapConfig = data.mapConfig;
            
            mapImage = new Image();
            // Base64ならcrossOrigin不要ですが、念のため残してもエラーにはなりません
            // mapImage.crossOrigin = "anonymous"; 
            mapImage.onload = () => {
                fitMapToScreen();
                drawMap();
            };
            mapImage.src = mapSrc; // URLでもBase64でもsrcに入れれば表示されます
        } else {
            alert("このキャンパスにはマップ画像が設定されていません");
            // 画像クリア
            mapImage = null;
            drawMap();
        }
    } catch(e) { console.error(e); }
}

// --- 描画・操作関連 ---

function fitMapToScreen() {
    if(!mapImage) return;
    // 画面に収まるようにスケール計算
    const scaleW = mapCanvas.width / mapImage.width;
    const scaleH = mapCanvas.height / mapImage.height;
    mapScale = Math.min(scaleW, scaleH); // 小さい方に合わせる（全体表示）
    
    // 画面中央に配置
    mapOffsetX = (mapCanvas.width - mapImage.width * mapScale) / 2;
    mapOffsetY = (mapCanvas.height - mapImage.height * mapScale) / 2;
}

function drawMap() {
    // 画面クリア
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    
    // 背景色
    mapCtx.fillStyle = "#e0e0e0";
    mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

    if(!mapImage) {
        mapCtx.fillStyle = "#666";
        mapCtx.font = "16px sans-serif";
        mapCtx.fillText("マップ画像なし", 20, 50);
        return;
    }

    // 画像描画 (変換マトリクス適用)
    mapCtx.save();
    mapCtx.translate(mapOffsetX, mapOffsetY);
    mapCtx.scale(mapScale, mapScale);
    mapCtx.drawImage(mapImage, 0, 0);
    
    // (将来的にここに現在地ピンなどを描画)
    
    mapCtx.restore();
}

function initMapEvents() {
    // マウス/タッチイベントでドラッグ移動
    const start = (x, y) => {
        isDragging = true;
        startX = x - mapOffsetX;
        startY = y - mapOffsetY;
    };
    const move = (x, y) => {
        if(!isDragging) return;
        mapOffsetX = x - startX;
        mapOffsetY = y - startY;
        drawMap();
    };
    const end = () => { isDragging = false; };

    // Mouse
    mapCanvas.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    mapCanvas.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    mapCanvas.addEventListener('mouseup', end);
    mapCanvas.addEventListener('mouseleave', end);

    // Touch
    mapCanvas.addEventListener('touchstart', e => {
        if(e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
    });
    mapCanvas.addEventListener('touchmove', e => {
        e.preventDefault(); // スクロール防止
        if(e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
    });
    mapCanvas.addEventListener('touchend', end);
}

function centerToCurrentLocation() {
    alert("現在地を取得してマップ上に表示します（実装予定）");
    // ここにGeolocation APIと座標変換ロジックを実装します
}