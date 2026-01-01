let currentMapConfig = null;
let mapImage = null;
let mapCanvas, mapCtx;
let mapScale = 1.0;
let mapOffsetX = 0, mapOffsetY = 0;

// 余白設定 (15%)
const MARGIN_RATIO = 0.15; 

// 現在地追跡用
let watchId = null;
let currentUserPos = null; // {lat, lon, accuracy}

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Canvas初期化
    mapCanvas = document.getElementById('mapCanvas');
    mapCtx = mapCanvas.getContext('2d');
    
    // リサイズ時に再計算
    window.addEventListener('resize', () => {
        resizeCanvas();
        fitMapToScreen();
        drawMap();
    });
    resizeCanvas();
    
    // 2. キャンパス一覧ロード
    await loadMapCampuses();
});

function resizeCanvas() {
    mapCanvas.width = window.innerWidth;
    mapCanvas.height = window.innerHeight;
}

// --- キャンパスデータ読み込み ---
async function loadMapCampuses() {
    const select = document.getElementById('mapCampusSelect');
    if(!select) return;
    select.innerHTML = '<option value="">キャンパスを選択...</option>';

    try {
        const snap = await db.collection('campuses').get();
        if(snap.empty) return;
        
        // order順に並び替え
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
                fitMapToScreen(); // 画像ロード後に固定表示計算
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

// --- 描画・計算ロジック (固定表示版) ---

function fitMapToScreen() {
    if(!mapImage) return;

    // 画像サイズに15%ずつの余白を加えた「表示したい全体サイズ」を定義
    // 幅: ImageW + (ImageW * 0.15 * 2) = ImageW * 1.3
    const visibleW = mapImage.width * (1 + MARGIN_RATIO * 2);
    const visibleH = mapImage.height * (1 + MARGIN_RATIO * 2);

    // 画面(Canvas)に収まる倍率を計算 (Contain)
    const scaleW = mapCanvas.width / visibleW;
    const scaleH = mapCanvas.height / visibleH;
    mapScale = Math.min(scaleW, scaleH); 
    
    // 画像が画面中央に来るようにオフセットを設定 (ドラッグ不可なので固定)
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
        mapCtx.textAlign = "center";
        mapCtx.fillText("マップ画像なし", mapCanvas.width/2, mapCanvas.height/2);
        return;
    }

    mapCtx.save();
    
    // --- 地図画像の描画 ---
    // オフセットとスケールを適用
    mapCtx.translate(mapOffsetX, mapOffsetY);
    mapCtx.scale(mapScale, mapScale);
    mapCtx.drawImage(mapImage, 0, 0);

    // --- 現在地ピンの描画判定 ---
    if (currentUserPos && currentMapConfig) {
        const pixel = geoToPixel(
            currentUserPos.lat, 
            currentUserPos.lon, 
            currentMapConfig
        );
        
        if (pixel) {
            // 範囲判定: 画像領域 + 15%余白
            // 画像上の座標(0,0)から見て、-15% ～ 115% の範囲内なら「範囲内」とする
            const minX = -mapImage.width * MARGIN_RATIO;
            const maxX = mapImage.width * (1 + MARGIN_RATIO);
            const minY = -mapImage.height * MARGIN_RATIO;
            const maxY = mapImage.height * (1 + MARGIN_RATIO);

            const isInside = (pixel.x >= minX && pixel.x <= maxX && pixel.y >= minY && pixel.y <= maxY);

            if (isInside) {
                // 範囲内: ピンを描画 (逆スケールでサイズ維持)
                const pinRadius = 15 / mapScale;
                const lineWidth = 3 / mapScale;

                mapCtx.beginPath();
                mapCtx.arc(pixel.x, pixel.y, pinRadius, 0, Math.PI * 2); 
                mapCtx.fillStyle = "rgba(0, 123, 255, 0.9)"; // 青
                mapCtx.fill();
                mapCtx.lineWidth = lineWidth;
                mapCtx.strokeStyle = "white";
                mapCtx.stroke();
            } else {
                // 範囲外: ここでは何も描画せず、restore後にメッセージを出す
            }

            // 範囲外フラグを一時保存して外で使うためにctx.restore()後に処理してもよいが、
            // ここで分岐終了。
            mapCtx.restore();

            // 範囲外メッセージの描画 (Canvas座標系で描くため restore後に行う)
            if (!isInside) {
                mapCtx.save();
                mapCtx.fillStyle = "rgba(0, 0, 0, 0.7)";
                mapCtx.fillRect(0, mapCanvas.height - 150, mapCanvas.width, 40);
                
                mapCtx.fillStyle = "white";
                mapCtx.font = "bold 16px sans-serif";
                mapCtx.textAlign = "center";
                mapCtx.textBaseline = "middle";
                mapCtx.fillText("現在地はマップ範囲外です", mapCanvas.width / 2, mapCanvas.height - 130);
                mapCtx.restore();
            }
        } else {
            mapCtx.restore();
        }
    } else {
        mapCtx.restore();
    }
}

// --- 座標変換ロジック (LatLon -> Pixel) ---
function geoToPixel(lat, lon, config) {
    if (!config.origin || !config.terminal) return null;

    const origin = config.origin;   
    const term = config.terminal;   
    const rotation = config.rotation || 0; 
    
    // 画像サイズ
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

    // 符号補正
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
    
    // GPSボタン
    const btn = document.querySelector('.gps-btn');

    // 連続取得開始 (まだしていなければ)
    if (!watchId) {
        if(btn) btn.style.color = "#999"; 

        watchId = navigator.geolocation.watchPosition(
            (pos) => {
                currentUserPos = {
                    lat: pos.coords.latitude,
                    lon: pos.coords.longitude,
                    accuracy: pos.coords.accuracy
                };
                
                if(btn) btn.style.color = "#007bff"; 
                drawMap(); 
            },
            (err) => {
                console.error(err);
                if(btn) btn.style.color = "red";
                alert("位置情報の取得に失敗しました");
            },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
        alert("GPS追跡を開始しました");
    } else {
        // すでに取得中なら、再描画だけ行う（位置情報は自動更新されている）
        // 固定表示モードなので「中心へ移動」などの操作は行わない
        drawMap();
        alert("現在地情報を更新しました");
    }
}