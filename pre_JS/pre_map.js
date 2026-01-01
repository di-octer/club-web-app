let currentMapConfig = null;
let mapImage = null;
let mapCanvas, mapCtx;
let mapScale = 1.0;
let mapOffsetX = 0, mapOffsetY = 0;

// 現在地追跡用
let watchId = null;
let currentUserPos = null; // {lat, lon, accuracy}

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

    // 3. キャンパス一覧ロード
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
    if(!select) return;
    select.innerHTML = '<option value="">キャンパスを選択...</option>';

    try {
        // order順に並び替え (orderフィールドがない場合も考慮)
        const snap = await db.collection('campuses').get();
        if(snap.empty) return;
        
        const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        docs.sort((a, b) => (a.order || 9999) - (b.order || 9999));
        
        let firstCid = null;
        docs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.name;
            select.appendChild(opt);
            if(!firstCid) firstCid = d.id;
        });
        
        // デフォルトキャンパスを選択
        if (typeof userSettings !== 'undefined' && userSettings.defaultCampusId) {
            select.value = userSettings.defaultCampusId;
            loadCampusMapData(userSettings.defaultCampusId);
        } else if (firstCid) {
            select.value = firstCid;
            loadCampusMapData(firstCid);
        }
    } catch(e) { console.error("Map Load Error:", e); }
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
            mapImage.onload = () => {
                fitMapToScreen();
                drawMap();
            };
            mapImage.src = mapSrc;
        } else {
            alert("このキャンパスにはマップ画像が設定されていません");
            mapImage = null;
            currentMapConfig = null;
            drawMap();
        }
    } catch(e) { console.error(e); }
}

// --- 描画・操作関連 ---

function fitMapToScreen() {
    if(!mapImage) return;
    const scaleW = mapCanvas.width / mapImage.width;
    const scaleH = mapCanvas.height / mapImage.height;
    mapScale = Math.min(scaleW, scaleH); 
    
    // 中央配置
    mapOffsetX = (mapCanvas.width - mapImage.width * mapScale) / 2;
    mapOffsetY = (mapCanvas.height - mapImage.height * mapScale) / 2;
}

function drawMap() {
    // 画面クリア
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    
    // 背景
    mapCtx.fillStyle = "#e0e0e0";
    mapCtx.fillRect(0, 0, mapCanvas.width, mapCanvas.height);

    if(!mapImage) {
        mapCtx.fillStyle = "#666";
        mapCtx.font = "16px sans-serif";
        mapCtx.fillText("マップ画像なし", 20, 50);
        return;
    }

    mapCtx.save();
    
    // 変換マトリクス適用 (移動 -> スケール)
    mapCtx.translate(mapOffsetX, mapOffsetY);
    mapCtx.scale(mapScale, mapScale);
    
    // 地図画像描画
    mapCtx.drawImage(mapImage, 0, 0);

    // 現在地ピンの描画
    if (currentUserPos && currentMapConfig) {
        const pixel = geoToPixel(
            currentUserPos.lat, 
            currentUserPos.lon, 
            currentMapConfig
        );
        
        if (pixel) {
            // ★修正: 範囲外の場合は画像内の最も近い点に寄せる (クランプ処理)
            const clampedX = Math.max(0, Math.min(pixel.x, mapImage.width));
            const clampedY = Math.max(0, Math.min(pixel.y, mapImage.height));

            // ピン描画 (青丸)
            // 逆スケール (1/mapScale) を半径・線幅に掛けることで、ズームしてもピンの大きさを一定に保つ
            const pinRadius = 15 / mapScale;
            const lineWidth = 3 / mapScale;

            mapCtx.beginPath();
            mapCtx.arc(clampedX, clampedY, pinRadius, 0, Math.PI * 2); 
            mapCtx.fillStyle = "rgba(0, 123, 255, 0.9)";
            mapCtx.fill();
            mapCtx.lineWidth = lineWidth;
            mapCtx.strokeStyle = "white";
            mapCtx.stroke();
            
            // ※必要であればここに「範囲外」を示す矢印などを描画するロジックを追加可能
        }
    }
    
    mapCtx.restore();
}

// --- 座標変換ロジック (LatLon -> Pixel) ---
function geoToPixel(lat, lon, config) {
    if (!config.origin || !config.terminal) return null;

    const origin = config.origin;   
    const term = config.terminal;   
    const rotation = config.rotation || 0; 
    
    // 画像サイズ (Configまたはロードした画像から)
    const imgW = config.imageWidth || (mapImage ? mapImage.width : 1000);
    const imgH = config.imageHeight || (mapImage ? mapImage.height : 1000);

    // ヒュベニの簡易版係数
    const M_PER_LAT = 111319.49;
    const radLat = origin.lat * (Math.PI / 180);
    const M_PER_LON = 111319.49 * Math.cos(radLat);

    // 相対距離 (メートル)
    const dy_u = (lat - origin.lat) * M_PER_LAT;
    const dx_u = (lon - origin.lon) * M_PER_LON;

    const dy_t = (term.lat - origin.lat) * M_PER_LAT;
    const dx_t = (term.lon - origin.lon) * M_PER_LON;

    // 回転補正
    const rad = -rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    const rot_x_u = dx_u * cos - dy_u * sin;
    const rot_y_u = dx_u * sin + dy_u * cos;

    const rot_x_t = dx_t * cos - dy_t * sin;
    const rot_y_t = dx_t * sin + dy_t * cos;

    // スケール計算
    const scaleX = imgW / Math.abs(rot_x_t);
    const scaleY = imgH / Math.abs(rot_y_t);

    // ピクセル座標
    let px = rot_x_u * scaleX;
    let py = -rot_y_u * scaleY; // Y軸反転

    // 符号補正 (Terminalの位置関係が想定と異なる場合)
    if (rot_x_t < 0) px = -px; 
    if (rot_y_t > 0) py = -py; 

    return { x: px, y: py };
}

// --- 現在地取得 ---
function centerToCurrentLocation() {
    if (!navigator.geolocation) {
        alert("GPSが使用できません");
        return;
    }
    
    // 連続取得開始 (まだしていなければ)
    if (!watchId) {
        // 初回メッセージ
        const btn = document.querySelector('.gps-btn');
        if(btn) btn.style.color = "#999"; // 取得中カラー

        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                currentUserPos = {
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                };
                
                if(btn) btn.style.color = "#007bff"; // 取得OKカラー
                
                // 初回のみ自動センタリングする等の処理を入れても良いが、
                // 今回はボタンを押したときのみセンタリングする (下部elseブロック)
                drawMap(); 
            },
            (err) => {
                console.error(err);
                if(btn) btn.style.color = "red";
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
        alert("GPS追跡を開始しました。\nもう一度ボタンを押すと現在地に移動します。");
    } else {
        // すでに取得中なら、その位置を中心に移動
        if (currentUserPos && currentMapConfig && mapImage) {
            const pixel = geoToPixel(currentUserPos.lat, currentUserPos.lon, currentMapConfig);
            if(pixel) {
                // ★修正: センタリング時も画像範囲内にクランプする
                // これにより、現在地が遠くても「地図の端」が画面中央に来るようになる（地図が見失われない）
                const cx = Math.max(0, Math.min(pixel.x, mapImage.width));
                const cy = Math.max(0, Math.min(pixel.y, mapImage.height));
                
                // 画面中心に (cx, cy) が来るようにオフセット計算
                mapOffsetX = (mapCanvas.width / 2) - (cx * mapScale);
                mapOffsetY = (mapCanvas.height / 2) - (cy * mapScale);
                drawMap();
            }
        } else {
            alert("現在地を取得中、またはマップ設定がありません");
        }
    }
}

function initMapEvents() {
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

    mapCanvas.addEventListener('mousedown', e => start(e.clientX, e.clientY));
    mapCanvas.addEventListener('mousemove', e => move(e.clientX, e.clientY));
    mapCanvas.addEventListener('mouseup', end);
    mapCanvas.addEventListener('mouseleave', end);

    mapCanvas.addEventListener('touchstart', e => {
        if(e.touches.length === 1) start(e.touches[0].clientX, e.touches[0].clientY);
    });
    mapCanvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if(e.touches.length === 1) move(e.touches[0].clientX, e.touches[0].clientY);
    });
    mapCanvas.addEventListener('touchend', end);
}